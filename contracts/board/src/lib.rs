//! Proof Courier board: open bounties for Lean proofs and counterexamples, checked by NEAR itself.
//!
//! * A poster locks a reward for a **claim**: the name of a `Prop` definition in the kernel's
//!   sealed shelf (for example `Wallet.Claim.AllowedReceiversOnly`), and optionally its
//!   **counter-claim** (`Wallet.Claim.Refute.AllowedReceiversOnly`, the negation). The bounty pays
//!   whoever settles the question first: a proof of the claim, or a proof of the counter-claim.
//! * Any account may claim. A claimer first **commits**
//!   `sha256(domain, bounty, account, side, sha256(delta), salt)` and **reveals** the delta at least
//!   `reveal_delay_blocks` later, with a bond. A copied proof must be committed again and wait the
//!   same delay, by which time the original reveal has been checked.
//! * Every reveal is checked by the keyless kernel contract (a Lean 4 kernel compiled to wasm).
//!   Reveals do not lock the bounty: any number can be in flight, and the first verdict that is
//!   `ok`, in claim mode, for exactly that claim, against exactly the pinned shelf, with no axiom
//!   beyond `propext`, `Classical.choice`, `Quot.sound`, wins: reward plus bond go to the winner.
//!   A rejected reveal forfeits its bond to the reward (spam funds the bounty); a valid proof that
//!   arrives after the bounty is settled gets its bond back.
//! * A commit is used once. Commits made before the deadline may still be revealed during a
//!   grace period after it; only then can the poster take an unclaimed reward back.
//! * A settled claim is recorded: the board refuses a new bounty for it and points to the
//!   certificate. `fund_if_proven` forwards a deposit to a wallet only if the claim was proved, so
//!   money moves only with the proof.
//! * The claims are about one wallet code. The board pins a wallet factory and that code's sha256:
//!   a bounty's subject, and any wallet `fund_if_proven` pays, must be a wallet the factory created
//!   from that code (the factory answers `wallet_of` on-chain). So a proof covers every wallet the
//!   factory made, whatever caps its owner chose, and no money goes to an account running other code.
//! * A wallet is alive only while its rule is true. When a refutation is accepted, the board freezes the
//!   bounty's subject in the same transaction (`freeze` on the wallet, which accepts only its board), and
//!   from then on anyone may freeze any other wallet of that code (`freeze`: the board asks the factory
//!   first). The board never forwards money into code it has seen refuted.
//! * The root bounty is for `False` itself: one-sided, paid for a theorem of type `False` that the kernel
//!   accepts on the sealed shelf. If it is ever paid, the board records for good that its kernel is
//!   broken: it settles nothing more, opens no gate, lets posters take their money back at once and lets
//!   anyone freeze any wallet of its factory.
//!
//! What this contract does not do: it does not prove the kernel sound, it cannot read the kernel's
//! or the factory's code hash (clients check that those accounts are keyless and run the published
//! wasm), and it does not prove its own state machine.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub const ALLOWED_AXIOMS: [&str; 3] = ["propext", "Classical.choice", "Quot.sound"];
pub const COMMIT_DOMAIN: &str = "proof-courier/commit/v2";
/// Kept by the board for a bounty's storage (attempt log, certificate).
pub const POST_FEE: NearToken = NearToken::from_millinear(100);
/// Kept by the board for a commitment's storage; also makes spam commitments cost something.
pub const COMMIT_FEE: NearToken = NearToken::from_millinear(10);
pub const MIN_REWARD: NearToken = NearToken::from_millinear(10);
pub const MAX_DELTA_BYTES: usize = 1_400_000;
pub const ATTEMPT_LOG: usize = 16;
pub const MIN_BOOST: NearToken = NearToken::from_millinear(100);
/// A bounty's deadline is at most this far away, so nobody can hold a claim's one open bounty for good.
pub const MAX_DEADLINE_NS: u64 = 90 * 86_400 * 1_000_000_000;
/// Bounds the board's storage per bounty for boosts (a booster may boost again).
pub const MAX_BOOSTERS: u32 = 64;
const CALLBACK_GAS: Gas = Gas::from_tgas(100);
const POST_CALLBACK_GAS: Gas = Gas::from_tgas(20);
/// Gas for each `statement_of` call that validates a new bounty (it parses the shelf once).
const STATEMENT_GAS: Gas = Gas::from_tgas(300);
const PAY_CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// Gas for the factory's `wallet_of` and for the callback that acts on its answer.
const WALLET_OF_GAS: Gas = Gas::from_tgas(10);
const FUND_CALLBACK_GAS: Gas = Gas::from_tgas(20);
const MAX_KERNEL_REPLY: usize = 262_144;
/// The root bounty's claim: the shelf's empty proposition, as the kernel prints it.
pub const ROOT_CLAIM: &str = "False";
pub const ROOT_STATEMENT: &str = "inductive False : Prop";
/// nanoda's debug print of the type of a theorem whose type is exactly the constant `False`; the kernel
/// reports its sha256 as `statement_hash`.
pub const ROOT_TYPE_DEBUG: &str = "False.[]";
/// Gas for a wallet's `freeze` and for the callback that records whether it worked.
const FREEZE_GAS: Gas = Gas::from_tgas(10);
const FROZEN_CALLBACK_GAS: Gas = Gas::from_tgas(5);
const FREEZE_CHECKED_GAS: Gas = Gas::from_tgas(25);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Bounties,
    Commits,
    Pending,
    Settled,
    OpenByName,
    Boosts,
    Committers,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    /// The kernel is being asked whether the claim (and counter-claim) are on the shelf.
    Validating,
    Open,
    Owed,
    Paying,
    Paid,
    OwedRefund,
    PayingRefund,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Proof,
    Refutation,
}

impl Side {
    fn parse(s: &str) -> Option<Side> {
        match s {
            "proof" => Some(Side::Proof),
            "refutation" => Some(Side::Refutation),
            _ => None,
        }
    }
    fn as_str(&self) -> &'static str {
        match self {
            Side::Proof => "proof",
            Side::Refutation => "refutation",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Certificate {
    pub claimer: AccountId,
    pub side: Side,
    /// The shelf constant that was proved: the claim, or the counter-claim.
    pub proved: String,
    pub proof_theorem: String,
    pub statement_hash: String,
    pub base_hash: String,
    pub axioms: Vec<String>,
    pub decls_checked: u32,
    pub delta_sha256: String,
    pub block_height: U64,
    pub timestamp: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Attempt {
    pub claimer: AccountId,
    pub side: Side,
    pub delta_sha256: String,
    /// `accepted`, `accepted_after_settled`, or the reason the board refused to pay.
    pub outcome: String,
    pub block_height: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Bounty {
    pub id: U64,
    pub poster: AccountId,
    pub claim: String,
    pub counter_claim: Option<String>,
    /// sha256 of the statement as the kernel prints it from the sealed shelf (set when the
    /// bounty opens): the bounty is about exactly this text.
    pub statement_sha256: Option<String>,
    pub counter_statement_sha256: Option<String>,
    pub title: String,
    /// The reward, including bonds forfeited by rejected reveals.
    pub reward: U128,
    pub forfeited: U128,
    /// Part of `reward` added by others with `boost` (each can take its own part back if nobody
    /// settles the bounty); the poster's refund is `reward - boosted`.
    pub boosted: U128,
    pub boosters: u32,
    pub deadline: U64,
    pub posted_at: U64,
    /// The wallet the escrow goes to, and the sha256 of the code it runs, as the pinned factory
    /// reported it when the bounty opened (a bounty whose subject is not such a wallet never opens).
    pub subject: Option<AccountId>,
    pub subject_code_hash: Option<String>,
    pub phase: Phase,
    /// Kernel checks in flight.
    pub pending: u32,
    pub winner: Option<AccountId>,
    pub winner_bond: U128,
    pub certificate: Option<Certificate>,
    pub funded: U128,
    /// Part of the poster's deposit held for the subject: released to the subject when the claim
    /// is proved, returned to the poster on a refutation or after the deadline.
    pub escrow: U128,
    /// `none`, `held`, `releasing`, `released`, `returning`, `returned`.
    pub escrow_state: String,
    /// Commitments made to this bounty (agents can read it to judge competition).
    pub commitments: u32,
    /// The most recent attempts (at most `ATTEMPT_LOG`), oldest first.
    pub attempts: Vec<Attempt>,
    pub attempts_total: u32,
    pub last_error: Option<String>,
    /// Why the board refused to open this bounty (set once, at posting), if it did.
    pub refused_because: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Commit {
    pub hash: String,
    pub block_height: U64,
    pub timestamp: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub side: Side,
    pub delta_sha256: String,
    pub bond: U128,
    pub block_height: U64,
}

/// A claim this board accepts bounties for, and its exact negation (both shelf constants).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ClaimPair {
    pub claim: String,
    pub counter: String,
}

#[near(serializers = [json])]
pub struct Config {
    pub kernel: AccountId,
    pub base_hash: String,
    pub factory: Option<AccountId>,
    pub wallet_code_hash: Option<String>,
    pub claims: Vec<ClaimPair>,
    pub reveal_delay_blocks: U64,
    pub min_reveal_gas_tgas: U64,
    pub reveal_bond: U128,
    pub grace_seconds: U64,
    pub stale_blocks: U64,
    pub bounties: U64,
    pub commit_domain: String,
    pub allowed_axioms: Vec<String>,
    /// The first bounty settled by a refutation: the wallet code this board pins is refuted.
    pub code_refuted_by: Option<U64>,
    /// The root bounty that was paid for a proof of `False`: this board's kernel is broken.
    pub kernel_broken_by: Option<U64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Board {
    kernel: AccountId,
    base_hash: String,
    /// The wallet factory and the sha256 of the wallet code the shelf's claims are about.
    factory: Option<AccountId>,
    wallet_code_hash: Option<String>,
    /// The only claims this board takes bounties for: the claims about the wallet code it pins.
    claims: Vec<ClaimPair>,
    reveal_delay_blocks: u64,
    min_reveal_gas_tgas: u64,
    reveal_bond: u128,
    grace_ns: u64,
    stale_blocks: u64,
    next_id: u64,
    bounties: IterableMap<u64, Bounty>,
    commits: LookupMap<String, Commit>,
    pending: LookupMap<String, Pending>,
    /// Shelf constant (claim or counter-claim) -> the bounty that settled it.
    settled: LookupMap<String, u64>,
    /// Shelf constant -> the bounty currently open (or validating) for it.
    open_by_name: LookupMap<String, u64>,
    /// "<bounty id>:<account>" -> what that account added with `boost`.
    boosts: LookupMap<String, u128>,
    /// "<bounty id>:<account>" for every account that ever committed to the bounty (rivals are counted once).
    committers: LookupMap<String, bool>,
    /// Write-once: the first bounty settled by a refutation. From then on the pinned wallet code is
    /// refuted: its wallets can be frozen and the board forwards no money to them.
    refuted_by: Option<u64>,
    /// Write-once: the root bounty paid for a proof of `False`. From then on nothing settles.
    kernel_broken_by: Option<u64>,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn valid_claim_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'\'')
}

fn key(id: u64, who: &AccountId) -> String {
    format!("{id}:{who}")
}

/// The commitment a claimer publishes before revealing. Hex sha256 of
/// `proof-courier/commit/v2\n<bounty id>\n<account>\n<side>\n<hex sha256(delta)>\n<salt>`.
pub fn commitment(id: u64, who: &str, side: &str, delta_sha256: &str, salt: &str) -> String {
    let pre = format!("{COMMIT_DOMAIN}\n{id}\n{who}\n{side}\n{delta_sha256}\n{salt}");
    hex::encode(env::sha256(pre.as_bytes()))
}

/// What the board needs from an accepted kernel verdict.
#[derive(Debug, PartialEq)]
pub struct Accepted {
    pub proof_theorem: String,
    pub statement_hash: String,
    pub axioms: Vec<String>,
    pub decls_checked: u32,
}

/// Decide whether a kernel `CheckResult` settles `name` (the claim or the counter-claim).
/// `Err` carries the refusal reason.
pub fn judge(v: &Value, name: &str, base_hash: &str) -> Result<Accepted, String> {
    if v["ok"] != Value::Bool(true) {
        let reason = v["reason"].as_str().unwrap_or("rejected");
        return Err(reason.chars().take(200).collect());
    }
    if v["mode"] != "claim" {
        return Err("not_claim_mode".into());
    }
    if v["theorem"] != name {
        return Err("claim_mismatch".into());
    }
    if v["base_hash"] != base_hash {
        return Err("base_mismatch".into());
    }
    let decls = v["decls_checked"].as_u64().unwrap_or(0);
    if decls == 0 {
        return Err("empty_delta".into());
    }
    let axioms: Vec<String> = match v["axioms"].as_array() {
        Some(a) => a.iter().map(|x| x.as_str().unwrap_or("?").to_string()).collect(),
        None => return Err("no_axiom_list".into()),
    };
    if let Some(bad) = axioms.iter().find(|a| !ALLOWED_AXIOMS.contains(&a.as_str())) {
        return Err(format!("axiom_not_allowed:{bad}"));
    }
    let proof_theorem = v["proof_theorem"].as_str().unwrap_or("").to_string();
    let statement_hash = v["statement_hash"].as_str().unwrap_or("").to_string();
    if proof_theorem.is_empty() || !is_hex64(&statement_hash) {
        return Err("incomplete_verdict".into());
    }
    Ok(Accepted { proof_theorem, statement_hash, axioms, decls_checked: decls as u32 })
}

/// Does the factory's `wallet_of` answer say `account` is a wallet running `code_hash`?
pub fn attests(answer: &Value, account: &str, code_hash: &str) -> bool {
    answer["wallet"] == account && answer["code_hash"] == code_hash
}

/// Decide whether a kernel `CheckResult` is an accepted theorem of type exactly `False` on the pinned
/// shelf, with allowed axioms only. The kernel ran in theorem mode on the theorem the claimer named;
/// which theorem it was does not matter, only its type.
pub fn judge_root(v: &Value, base_hash: &str) -> Result<Accepted, String> {
    if v["ok"] != Value::Bool(true) {
        let reason = v["reason"].as_str().unwrap_or("rejected");
        return Err(reason.chars().take(200).collect());
    }
    if v["mode"] != "theorem" {
        return Err("not_theorem_mode".into());
    }
    if v["statement_hash"] != hex::encode(env::sha256(ROOT_TYPE_DEBUG.as_bytes())).as_str() {
        return Err("not_a_proof_of_false".into());
    }
    // The rest is what `judge` asks of any verdict: this shelf, a non-empty delta, allowed axioms.
    let mut as_claim = v.clone();
    as_claim["mode"] = json!("claim");
    let name = v["theorem"].as_str().unwrap_or("");
    judge(&as_claim, name, base_hash)
}

fn read_json(i: u64) -> Option<Value> {
    match env::promise_result_checked(i, 65_536) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok(),
        Err(_) => None,
    }
}

fn event(name: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "proof-courier", "version": "2.0.0", "event": name, "data": [data]})
    ));
}

fn push_attempt(b: &mut Bounty, claimer: AccountId, side: Side, delta_sha256: String, outcome: String) {
    if b.attempts.len() >= ATTEMPT_LOG {
        b.attempts.remove(0);
    }
    b.attempts.push(Attempt { claimer, side, delta_sha256, outcome, block_height: U64(env::block_height()) });
    b.attempts_total += 1;
}

#[near]
impl Board {
    /// `kernel` must be a keyless account running the published kernel wasm with a sealed
    /// shelf whose sha256 is `base_hash`; `factory`, if given, a keyless wallet factory whose wallets
    /// run the code with sha256 `wallet_code_hash`. All parameters are fixed for the life of the board.
    #[init]
    pub fn new(
        kernel: AccountId,
        base_hash: String,
        factory: Option<AccountId>,
        wallet_code_hash: Option<String>,
        claims: Vec<ClaimPair>,
        reveal_delay_blocks: U64,
        min_reveal_gas_tgas: U64,
        reveal_bond: U128,
        grace_seconds: U64,
        stale_blocks: U64,
    ) -> Self {
        require!(is_hex64(&base_hash), "bad_base_hash");
        require!(factory.is_some() == wallet_code_hash.is_some(), "factory_and_code_hash_go_together");
        require!(!claims.is_empty() && claims.len() <= 64, "bad_claims");
        for c in &claims {
            require!(valid_claim_name(&c.claim) && valid_claim_name(&c.counter) && c.claim != c.counter, "bad_claims");
            require!(c.claim != ROOT_CLAIM && c.counter != ROOT_CLAIM, "bad_claims");
        }
        if let Some(h) = &wallet_code_hash {
            require!(is_hex64(h), "bad_wallet_code_hash");
        }
        require!(reveal_delay_blocks.0 >= 1 && reveal_delay_blocks.0 <= 10_000, "bad_reveal_delay");
        require!(min_reveal_gas_tgas.0 >= 100 && min_reveal_gas_tgas.0 <= 1_000, "bad_min_gas");
        require!(reveal_bond.0 <= NearToken::from_near(10).as_yoctonear(), "bad_bond");
        require!(grace_seconds.0 <= 7 * 86_400, "bad_grace");
        require!(stale_blocks.0 >= 10, "bad_stale_blocks");
        Self {
            kernel,
            base_hash,
            factory,
            wallet_code_hash,
            claims,
            reveal_delay_blocks: reveal_delay_blocks.0,
            min_reveal_gas_tgas: min_reveal_gas_tgas.0,
            reveal_bond: reveal_bond.0,
            grace_ns: grace_seconds.0 * 1_000_000_000,
            stale_blocks: stale_blocks.0,
            next_id: 0,
            bounties: IterableMap::new(Key::Bounties),
            commits: LookupMap::new(Key::Commits),
            pending: LookupMap::new(Key::Pending),
            settled: LookupMap::new(Key::Settled),
            open_by_name: LookupMap::new(Key::OpenByName),
            boosts: LookupMap::new(Key::Boosts),
            committers: LookupMap::new(Key::Committers),
            refuted_by: None,
            kernel_broken_by: None,
        }
    }

    fn live(&self) {
        require!(self.kernel_broken_by.is_none(), "kernel_broken");
    }

    /// Lock `attached deposit - POST_FEE` as the reward for settling `claim` (and, if given,
    /// `counter_claim`). Refused if either is already settled on this board. The board then asks
    /// the kernel for both statements: the bounty opens only if `claim` is a `Prop` definition on
    /// the sealed shelf and `counter_claim` is defined as exactly `Not claim`; otherwise the
    /// whole deposit goes back. A `subject` (the wallet an `escrow` goes to) must be a wallet the
    /// pinned factory created from the pinned code; the board asks the factory in the same step.
    /// Attach at least 700 TGas (each statement costs one shelf parse).
    ///
    /// The root bounty: `claim` = `False`, no `counter_claim` (its negation is trivially provable), no
    /// subject, no escrow. It opens if the kernel prints the shelf's `False` as the empty proposition.
    #[payable]
    pub fn post_bounty(
        &mut self,
        claim: String,
        counter_claim: Option<String>,
        title: String,
        deadline: U64,
        subject: Option<AccountId>,
        escrow: Option<U128>,
    ) -> Promise {
        // Only the claims this board was created for (claims about the wallet code it pins), always
        // two-sided: a proof of the claim or of its listed negation settles the bounty. So a bounty can
        // neither be about another program nor hide the counterexample side.
        self.live();
        if claim == ROOT_CLAIM {
            require!(counter_claim.is_none() && subject.is_none() && escrow.is_none(), "root_bounty_is_one_sided_and_has_no_escrow");
        } else {
            let listed = self.claims.iter().find(|c| c.claim == claim).unwrap_or_else(|| env::panic_str("claim_not_on_this_board"));
            require!(counter_claim.as_deref() == Some(listed.counter.as_str()), "counter_claim_must_be_the_listed_negation");
        }
        require!(title.len() <= 160, "title_too_long");
        require!(deadline.0 > env::block_timestamp(), "bad_deadline");
        require!(deadline.0 <= env::block_timestamp().saturating_add(MAX_DEADLINE_NS), "deadline_too_far");
        for name in std::iter::once(&claim).chain(counter_claim.iter()) {
            if let Some(id) = self.settled.get(name) {
                env::panic_str(&format!("already_settled:{id}"));
            }
            if let Some(id) = self.open_by_name.get(name) {
                env::panic_str(&format!("open_bounty:{id}"));
            }
        }
        require!(subject.is_none() || self.factory.is_some(), "subject_needs_a_factory");
        let escrow = escrow.map(|e| e.0).unwrap_or(0);
        require!(escrow == 0 || subject.is_some(), "escrow_needs_subject");
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= POST_FEE.as_yoctonear() + MIN_REWARD.as_yoctonear() + escrow, "deposit_below_fee_plus_min_reward_plus_escrow");
        let reward = deposit - POST_FEE.as_yoctonear() - escrow;
        let id = self.next_id;
        self.next_id += 1;
        let b = Bounty {
            id: U64(id),
            poster: env::predecessor_account_id(),
            claim: claim.clone(),
            counter_claim: counter_claim.clone(),
            statement_sha256: None,
            counter_statement_sha256: None,
            title,
            reward: U128(reward),
            forfeited: U128(0),
            boosted: U128(0),
            boosters: 0,
            deadline,
            posted_at: U64(env::block_timestamp()),
            subject: subject.clone(),
            subject_code_hash: None,
            phase: Phase::Validating,
            pending: 0,
            winner: None,
            winner_bond: U128(0),
            certificate: None,
            funded: U128(0),
            escrow: U128(escrow),
            escrow_state: if escrow > 0 { "held".into() } else { "none".into() },
            commitments: 0,
            attempts: vec![],
            attempts_total: 0,
            last_error: None,
            refused_because: None,
        };
        self.bounties.insert(id, b);
        self.open_by_name.insert(claim.clone(), id);
        if let Some(c) = &counter_claim {
            self.open_by_name.insert(c.clone(), id);
        }
        let ask = |name: &str| Promise::new(self.kernel.clone()).function_call_weight(
            "statement_of", serde_json::to_vec(&json!({"theorem_name": name, "delta": ""})).unwrap(),
            NearToken::from_yoctonear(0), STATEMENT_GAS, GasWeight(0));
        let mut p = ask(&claim);
        if let Some(c) = &counter_claim {
            p = p.and(ask(c));
        }
        if let (Some(s), Some(f)) = (&subject, &self.factory) {
            p = p.and(Promise::new(f.clone()).function_call_weight(
                "wallet_of", serde_json::to_vec(&json!({"account_id": s})).unwrap(),
                NearToken::from_yoctonear(0), WALLET_OF_GAS, GasWeight(0)));
        }
        p.then(Promise::new(env::current_account_id()).function_call_weight(
            "on_posted", serde_json::to_vec(&json!({"id": U64(id)})).unwrap(), NearToken::from_yoctonear(0), POST_CALLBACK_GAS, GasWeight(1)))
    }

    #[private]
    pub fn on_posted(&mut self, id: U64) -> PromiseOrValue<bool> {
        let read = |i: u64| -> Option<String> {
            match env::promise_result_checked(i, 65_536) {
                Ok(bytes) => serde_json::from_slice::<String>(&bytes).ok(),
                Err(_) => None,
            }
        };
        let norm = |t: &str| t.split_whitespace().collect::<Vec<_>>().join(" ");
        let code_hash = self.wallet_code_hash.clone();
        let kernel_live = self.kernel_broken_by.is_none();
        let b = self.bounties.get_mut(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        require!(b.phase == Phase::Validating, "not_validating");
        let claim_text = read(0);
        let claim_ok = claim_text.as_ref().map(|t| {
            let n = norm(t);
            if b.claim == ROOT_CLAIM { n == ROOT_STATEMENT } else { n.starts_with(&format!("def {} : Prop :=", b.claim)) }
        }).unwrap_or(false);
        let (counter_text, counter_ok) = match &b.counter_claim {
            None => (None, true),
            Some(c) => {
                let t = read(1);
                let ok = t.as_ref().map(|t| norm(t) == format!("def {} : Prop := Not {}", c, b.claim)).unwrap_or(false);
                (t, ok)
            }
        };
        let subject_ok = match (&b.subject, &code_hash) {
            (None, _) => true,
            (Some(s), Some(h)) => {
                let i = if b.counter_claim.is_some() { 2 } else { 1 };
                read_json(i).map(|v| attests(&v, s.as_str(), h)).unwrap_or(false)
            }
            (Some(_), None) => false,
        };
        if kernel_live && claim_ok && counter_ok && subject_ok {
            if b.subject.is_some() {
                b.subject_code_hash = code_hash;
            }
            b.statement_sha256 = claim_text.map(|t| hex::encode(env::sha256(t.as_bytes())));
            b.counter_statement_sha256 = counter_text.map(|t| hex::encode(env::sha256(t.as_bytes())));
            b.phase = Phase::Open;
            event("bounty_posted", json!({"id": id, "poster": b.poster, "claim": b.claim, "counter_claim": b.counter_claim,
                "statement_sha256": b.statement_sha256, "reward": b.reward, "deadline": b.deadline, "subject": b.subject}));
            PromiseOrValue::Value(true)
        } else {
            let reason = if !kernel_live {
                "kernel_broken"
            } else if !claim_ok {
                "claim_not_a_prop_on_the_shelf"
            } else if !counter_ok {
                "counter_claim_is_not_not_claim"
            } else {
                "subject_not_a_factory_wallet"
            };
            // The reward and the escrow go back through the same paths as an expired bounty's, so a
            // failed transfer can be retried (`refund`, `retry_escrow`); the posting fee stays and pays
            // for the record of the refused bounty.
            b.refused_because = Some(reason.into());
            b.last_error = Some(reason.into());
            let (claim, counter, has_escrow) = (b.claim.clone(), b.counter_claim.clone(), b.escrow.0 > 0 && b.escrow_state == "held");
            event("bounty_rejected", json!({"id": id, "claim": claim, "reason": reason}));
            self.close_names(id.0, &claim, &counter);
            if has_escrow {
                drop(self.send_escrow(id.0, false));
            }
            PromiseOrValue::Promise(self.pay(id.0, true))
        }
    }

    /// Publish `commitment(id, your account, side, sha256(delta), salt)`. A later commit from the
    /// same account replaces the earlier one and restarts its delay. A commit is used up by a reveal.
    #[payable]
    pub fn commit(&mut self, id: U64, hash: String) {
        self.live();
        require!(env::attached_deposit() >= COMMIT_FEE, "attach_commit_fee");
        require!(is_hex64(&hash), "bad_commit_hash");
        let b = self.bounties.get_mut(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        require!(b.phase == Phase::Open, "not_open");
        require!(env::block_timestamp() < b.deadline.0, "deadline");
        let who = env::predecessor_account_id();
        // Count accounts, once per bounty: neither replacing a commitment nor committing again after a
        // reveal looks like a new rival.
        if !self.committers.contains_key(&key(id.0, &who)) {
            b.commitments += 1;
            self.committers.insert(key(id.0, &who), true);
        }
        self.commits.insert(key(id.0, &who), Commit { hash, block_height: U64(env::block_height()), timestamp: U64(env::block_timestamp()) });
        event("committed", json!({"id": id, "claimer": who}));
    }

    /// Raw input (no JSON): `<bounty id>\n<proof|refutation>\n<salt>\n<delta bytes>`, with at least
    /// `reveal_bond` attached. The delta is the lean4export NDJSON that follows the sealed shelf.
    /// For the root bounty the second line is `proof <theorem>`: the name of the theorem in the delta
    /// whose type is `False` (the commitment's side is still `proof`).
    #[payable]
    pub fn reveal(&mut self) -> Promise {
        self.live();
        require!(env::prepaid_gas() >= Gas::from_tgas(self.min_reveal_gas_tgas), "attach_more_gas");
        let bond = env::attached_deposit().as_yoctonear();
        require!(bond >= self.reveal_bond, "attach_reveal_bond");
        let input = env::input().unwrap_or_default();
        let mut parts = input.splitn(4, |c| *c == b'\n');
        let id: u64 = parts.next().and_then(|s| core::str::from_utf8(s).ok()).and_then(|s| s.trim().parse().ok())
            .unwrap_or_else(|| env::panic_str("expected <id>\\n<side>\\n<salt>\\n<delta>"));
        let side_line = parts.next().and_then(|s| core::str::from_utf8(s).ok()).unwrap_or("");
        let (side_s, root_theorem) = side_line.split_once(' ').unwrap_or((side_line, ""));
        let side = Side::parse(side_s).unwrap_or_else(|| env::panic_str("bad_side"));
        let salt = parts.next().and_then(|s| core::str::from_utf8(s).ok()).unwrap_or_else(|| env::panic_str("bad_salt"));
        require!(salt.len() >= 16 && salt.len() <= 128, "bad_salt");
        let delta = parts.next().unwrap_or(&[]);
        require!(!delta.is_empty() && delta.len() <= MAX_DELTA_BYTES, "bad_delta_size");
        let who = env::predecessor_account_id();
        let k = key(id, &who);
        let delta_sha256 = hex::encode(env::sha256(delta));
        let c = self.commits.get(&k).cloned().unwrap_or_else(|| env::panic_str("no_commit"));
        require!(env::block_height() >= c.block_height.0 + self.reveal_delay_blocks, "reveal_too_early");
        require!(commitment(id, who.as_str(), side.as_str(), &delta_sha256, salt) == c.hash, "commit_mismatch");
        require!(!self.pending.contains_key(&k), "check_in_flight");
        let grace = self.grace_ns;
        let b = self.bounties.get_mut(&id).unwrap_or_else(|| env::panic_str("no_bounty"));
        require!(b.phase == Phase::Open, "not_open");
        require!(c.timestamp.0 < b.deadline.0 && env::block_timestamp() < b.deadline.0.saturating_add(grace), "deadline");
        let name = match side {
            Side::Proof if b.claim == ROOT_CLAIM => {
                require!(valid_claim_name(root_theorem), "name_the_theorem_of_type_false");
                root_theorem.to_string()
            }
            Side::Proof => b.claim.clone(),
            Side::Refutation => b.counter_claim.clone().unwrap_or_else(|| env::panic_str("one_sided_bounty")),
        };
        require!(b.claim == ROOT_CLAIM || root_theorem.is_empty(), "bad_side");
        b.pending += 1;
        self.commits.remove(&k);
        self.pending.insert(k, Pending { side, delta_sha256: delta_sha256.clone(), bond: U128(bond), block_height: U64(env::block_height()) });
        let mut args = Vec::with_capacity(name.len() + 1 + delta.len());
        args.extend_from_slice(name.as_bytes());
        args.push(b'\n');
        args.extend_from_slice(delta);
        event("revealed", json!({"id": U64(id), "claimer": who, "side": side, "delta_sha256": delta_sha256, "delta_bytes": delta.len(),
            "block_height": U64(env::block_height()), "in_flight": b.pending}));
        Promise::new(self.kernel.clone())
            .function_call_weight("check_result_raw", args, NearToken::from_yoctonear(0), Gas::from_tgas(0), GasWeight(1))
            .then(Promise::new(env::current_account_id()).function_call_weight(
                "on_verdict",
                serde_json::to_vec(&json!({"id": U64(id), "claimer": who, "delta_sha256": delta_sha256})).unwrap(),
                NearToken::from_yoctonear(0),
                CALLBACK_GAS,
                GasWeight(0),
            ))
    }

    #[private]
    pub fn on_verdict(&mut self, id: U64, claimer: AccountId, delta_sha256: String) -> PromiseOrValue<bool> {
        require!(env::promise_results_count() == 1, "one_result_required");
        let base_hash = self.base_hash.clone();
        let result = env::promise_result_checked(0, MAX_KERNEL_REPLY);
        // A verdict belongs to the reveal that asked for it: after `clear_stale`, a late callback must not
        // be applied to a newer reveal by the same account.
        let k = key(id.0, &claimer);
        match self.pending.get(&k) {
            Some(p) if p.delta_sha256 == delta_sha256 => {}
            _ => {
                event("stale_verdict_ignored", json!({"id": id, "claimer": claimer, "delta_sha256": delta_sha256}));
                return PromiseOrValue::Value(false);
            }
        }
        let p = self.pending.remove(&k).unwrap();
        let (broken, code_refuted) = (self.kernel_broken_by.is_some(), self.refuted_by.is_some());
        let b = self.bounties.get_mut(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        b.pending = b.pending.saturating_sub(1);
        if broken {
            // The kernel was recorded broken while this check was in flight: neither its `ok` nor its
            // refusal means anything now. Nothing settles, and the bond goes back.
            push_attempt(b, claimer.clone(), p.side, p.delta_sha256, "kernel_broken".into());
            return PromiseOrValue::Promise(Promise::new(claimer).transfer(NearToken::from_yoctonear(p.bond.0)));
        }
        let root = b.claim == ROOT_CLAIM;
        let name = match p.side {
            Side::Proof => b.claim.clone(),
            Side::Refutation => b.counter_claim.clone().unwrap_or_default(),
        };
        let verdict = match result {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(v) if root => judge_root(&v, &base_hash),
                Ok(v) => judge(&v, &name, &base_hash),
                Err(_) => Err("bad_kernel_reply".into()),
            },
            // A Lean type error panics inside the kernel (wasm cannot unwind), and so does
            // running out of gas.
            Err(PromiseError::Failed) => Err("kernel_failed".into()),
            Err(_) => Err("kernel_reply_unreadable".into()),
        };
        let open = b.phase == Phase::Open;
        match verdict {
            Err(reason) => {
                push_attempt(b, claimer.clone(), p.side, p.delta_sha256.clone(), reason.clone());
                event("proof_rejected", json!({"id": id, "claimer": claimer, "side": p.side, "delta_sha256": p.delta_sha256, "reason": reason}));
                // A rejected reveal always forfeits its bond: to the reward while the bounty is open,
                // to the poster after it is settled.
                b.forfeited = U128(b.forfeited.0 + p.bond.0);
                if open {
                    b.reward = U128(b.reward.0 + p.bond.0);
                    PromiseOrValue::Value(false)
                } else {
                    PromiseOrValue::Promise(Promise::new(b.poster.clone()).transfer(NearToken::from_yoctonear(p.bond.0)))
                }
            }
            Ok(_) if !open || self.settled.get(&b.claim).is_some_and(|other| *other != id.0) => {
                push_attempt(b, claimer.clone(), p.side, p.delta_sha256, "accepted_after_settled".into());
                PromiseOrValue::Promise(Promise::new(claimer).transfer(NearToken::from_yoctonear(p.bond.0)))
            }
            Ok(acc) => {
                let cert = Certificate {
                    claimer: claimer.clone(),
                    side: p.side,
                    proved: name.clone(),
                    proof_theorem: acc.proof_theorem,
                    statement_hash: acc.statement_hash,
                    base_hash,
                    axioms: acc.axioms,
                    decls_checked: acc.decls_checked,
                    delta_sha256: p.delta_sha256.clone(),
                    block_height: U64(env::block_height()),
                    timestamp: U64(env::block_timestamp()),
                };
                push_attempt(b, claimer.clone(), p.side, p.delta_sha256, "accepted".into());
                event("proof_accepted", json!({"id": id, "certificate": cert}));
                let (claim, counter) = (b.claim.clone(), b.counter_claim.clone());
                let proved = p.side == Side::Proof;
                let has_escrow = b.escrow.0 > 0 && b.escrow_state == "held";
                let subject = b.subject.clone();
                b.certificate = Some(cert);
                b.winner = Some(claimer);
                b.winner_bond = p.bond;
                b.phase = Phase::Owed;
                if root {
                    // A proof of `False`: this kernel accepts anything. Recorded once, for good.
                    self.kernel_broken_by = Some(id.0);
                    event("kernel_broken", json!({"id": id, "kernel": self.kernel}));
                } else if !proved {
                    // A counterexample: the rule is false for this wallet code. The wallet the bounty is
                    // about is frozen by the receipts of this same transaction; the freeze is scheduled on
                    // its own, and if it fails anyone can send it again with `freeze`.
                    if self.refuted_by.is_none() {
                        self.refuted_by = Some(id.0);
                        event("code_refuted", json!({"id": id, "wallet_code_hash": self.wallet_code_hash}));
                    }
                    if let Some(s) = subject {
                        drop(self.send_freeze(s));
                    }
                }
                self.close_names(id.0, &claim, &counter);
                // Write-once: at most one bounty is ever open per name, so this is the first.
                if !self.settled.contains_key(&claim) {
                    self.settled.insert(claim, id.0);
                }
                if let Some(c) = counter {
                    if !self.settled.contains_key(&c) {
                        self.settled.insert(c, id.0);
                    }
                }
                if has_escrow {
                    // Scheduled on its own (a joint promise cannot be returned); its callback
                    // records where the escrow went.
                    // No escrow goes to a wallet of code this board has already seen refuted.
                    let escrow_move = self.send_escrow(id.0, proved && !code_refuted);
                    drop(escrow_move);
                }
                PromiseOrValue::Promise(self.pay(id.0, false))
            }
        }
    }

    /// Anyone may retry a failed payment; it can only go to the recorded winner.
    pub fn retry_payment(&mut self, id: U64) -> Promise {
        let b = self.bounties.get(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        require!(b.phase == Phase::Owed, "nothing_owed");
        self.pay(id.0, false)
    }

    /// Add the attached deposit to an open bounty's reward: several owners can pool one question.
    /// The winner gets all of it; if nobody settles the bounty, each booster takes its own part back
    /// with `withdraw_boost` after the deadline and grace, and the poster's refund leaves it alone.
    #[payable]
    pub fn boost(&mut self, id: U64) {
        self.live();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount >= MIN_BOOST.as_yoctonear(), "boost_too_small");
        let who = env::predecessor_account_id();
        let k = key(id.0, &who);
        let prev = self.boosts.get(&k).copied();
        let b = self.bounties.get_mut(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        require!(b.phase == Phase::Open && env::block_timestamp() < b.deadline.0, "not_open");
        if prev.is_none() {
            require!(b.boosters < MAX_BOOSTERS, "too_many_boosters");
            b.boosters += 1;
        }
        b.reward = U128(b.reward.0 + amount);
        b.boosted = U128(b.boosted.0 + amount);
        event("boosted", json!({"id": id, "by": who, "amount": U128(amount), "reward": b.reward}));
        self.boosts.insert(k, prev.unwrap_or(0) + amount);
    }

    /// A booster takes its boost back once the bounty has expired unsettled (deadline + grace, no
    /// check in flight). Works before or after the poster's refund.
    pub fn withdraw_boost(&mut self, id: U64) -> Promise {
        let grace = self.grace_ns;
        let who = env::predecessor_account_id();
        let k = key(id.0, &who);
        let amount = self.boosts.get(&k).copied().unwrap_or_else(|| env::panic_str("no_boost"));
        let broken = self.kernel_broken_by.is_some();
        let b = self.bounties.get_mut(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        require!(matches!(b.phase, Phase::Open | Phase::OwedRefund | Phase::PayingRefund | Phase::Refunded), "settled");
        // With the kernel recorded broken nothing can settle any more, so there is nothing to wait for.
        require!(broken || env::block_timestamp() >= b.deadline.0.saturating_add(grace), "not_expired");
        require!(b.pending == 0, "checks_in_flight");
        // Both shrink together, so the poster's part (`reward - boosted`, which `refund` and a
        // retried refund pay) never changes, whatever the order of refunds and withdrawals.
        b.boosted = U128(b.boosted.0 - amount);
        b.reward = U128(b.reward.0 - amount);
        self.boosts.remove(&k);
        Promise::new(who.clone()).transfer(NearToken::from_yoctonear(amount)).then(
            Promise::new(env::current_account_id()).function_call_weight(
                "on_boost_back",
                serde_json::to_vec(&json!({"id": id, "who": who, "amount": U128(amount)})).unwrap(),
                NearToken::from_yoctonear(0),
                PAY_CALLBACK_GAS,
                GasWeight(0),
            ),
        )
    }

    /// If a boost could not be sent back, the booster keeps its claim to it and can withdraw again.
    #[private]
    pub fn on_boost_back(&mut self, id: U64, who: AccountId, amount: U128) -> bool {
        let ok = matches!(env::promise_result_checked(0, 0), Ok(bytes) if bytes.is_empty());
        if ok {
            event("boost_withdrawn", json!({"id": id, "by": who, "amount": amount}));
        } else {
            let b = self.bounties.get_mut(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
            b.boosted = U128(b.boosted.0 + amount.0);
            b.reward = U128(b.reward.0 + amount.0);
            let k = key(id.0, &who);
            let prev = self.boosts.get(&k).copied().unwrap_or(0);
            self.boosts.insert(k, prev + amount.0);
            event("boost_withdraw_failed", json!({"id": id, "by": who, "amount": amount}));
        }
        ok
    }

    /// What `account_id` added to bounty `id` with `boost` and has not taken back.
    pub fn boost_of(&self, id: U64, account_id: AccountId) -> U128 {
        U128(self.boosts.get(&key(id.0, &account_id)).copied().unwrap_or(0))
    }

    /// After the deadline and its grace period, with no check in flight, anyone may close an unclaimed
    /// bounty: the poster gets its reward back (including forfeited bonds, excluding other people's
    /// boosts) and the escrow goes back too. So nobody can hold a claim longer than deadline + grace,
    /// and nobody else can take the money. Also retries a refund whose transfer failed.
    pub fn refund(&mut self, id: U64) -> Promise {
        let grace = self.grace_ns;
        let b = self.bounties.get(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        // A bounty stuck in Validating (its validation callback never ran) can be refunded once
        // the grace period after posting has passed; a refused post's failed refund, at once.
        let stuck_validating = b.phase == Phase::Validating && env::block_timestamp() >= b.posted_at.0.saturating_add(grace);
        let refused_post = b.phase == Phase::OwedRefund && b.statement_sha256.is_none();
        require!(matches!(b.phase, Phase::Open | Phase::OwedRefund) || stuck_validating, "not_refundable");
        // With the kernel recorded broken no bounty can settle any more: every open one is refundable at once.
        let broken = self.kernel_broken_by.is_some() && b.phase != Phase::Validating;
        require!(stuck_validating || refused_post || broken || env::block_timestamp() >= b.deadline.0.saturating_add(grace), "not_expired");
        require!(b.pending == 0, "checks_in_flight");
        let (claim, counter, has_escrow) = (b.claim.clone(), b.counter_claim.clone(), b.escrow.0 > 0 && b.escrow_state == "held");
        self.close_names(id.0, &claim, &counter);
        if has_escrow {
            let escrow_back = self.send_escrow(id.0, false);
            drop(escrow_back);
        }
        self.pay(id.0, true)
    }

    /// Anyone may retry an escrow transfer that failed (it goes where the outcome says).
    pub fn retry_escrow(&mut self, id: U64) -> Promise {
        let b = self.bounties.get(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        // Only once the bounty is decided (settled, or refunded after it expired) and the escrow is
        // still held: never while it is being validated or is open.
        require!(b.escrow_state == "held" && b.escrow.0 > 0
            && matches!(b.phase, Phase::Owed | Phase::Paying | Phase::Paid | Phase::OwedRefund | Phase::PayingRefund | Phase::Refunded),
            "no_escrow_to_move");
        // To the subject only for a proof, and only while the code is not refuted and the kernel not broken.
        let to_subject = b.certificate.as_ref().map(|c| c.side == Side::Proof).unwrap_or(false)
            && self.refuted_by.is_none() && self.kernel_broken_by.is_none();
        self.send_escrow(id.0, to_subject)
    }

    /// Release a bounty's claim names, but only where this bounty still holds them: a retried refund of an
    /// old bounty must not free a name that a newer bounty has taken since.
    fn close_names(&mut self, id: u64, claim: &String, counter: &Option<String>) {
        for name in std::iter::once(claim).chain(counter.iter()) {
            if self.open_by_name.get(name) == Some(&id) {
                self.open_by_name.remove(name);
            }
        }
    }

    fn send_escrow(&mut self, id: u64, to_subject: bool) -> Promise {
        let b = self.bounties.get_mut(&id).unwrap_or_else(|| env::panic_str("no_bounty"));
        // Every path that moves the escrow comes through here: it moves only from `held`, so it moves once.
        require!(b.escrow_state == "held" && b.escrow.0 > 0, "escrow_not_held");
        b.escrow_state = if to_subject { "releasing".into() } else { "returning".into() };
        let to = if to_subject { b.subject.clone().unwrap_or_else(|| env::panic_str("no_subject")) } else { b.poster.clone() };
        Promise::new(to).transfer(NearToken::from_yoctonear(b.escrow.0)).then(
            Promise::new(env::current_account_id()).function_call_weight(
                "on_escrow",
                serde_json::to_vec(&json!({"id": U64(id), "to_subject": to_subject})).unwrap(),
                NearToken::from_yoctonear(0),
                PAY_CALLBACK_GAS,
                GasWeight(0),
            ),
        )
    }

    #[private]
    pub fn on_escrow(&mut self, id: U64, to_subject: bool) -> bool {
        require!(env::promise_results_count() == 1, "one_result_required");
        let ok = matches!(env::promise_result_checked(0, 0), Ok(bytes) if bytes.is_empty());
        let b = self.bounties.get_mut(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        b.escrow_state = match (ok, to_subject) { (true, true) => "released", (true, false) => "returned", (false, _) => "held" }.into();
        if ok {
            let to = if to_subject { b.subject.clone().unwrap() } else { b.poster.clone() };
            event(if to_subject { "escrow_released" } else { "escrow_returned" }, json!({"id": id, "to": to, "amount": b.escrow}));
        }
        ok
    }

    /// If a kernel check never called back (its callback ran out of gas), anyone may clear it
    /// after `stale_blocks`; the claimer gets the bond back.
    pub fn clear_stale(&mut self, id: U64, claimer: AccountId) -> Promise {
        let k = key(id.0, &claimer);
        let p = self.pending.get(&k).cloned().unwrap_or_else(|| env::panic_str("no_pending"));
        require!(env::block_height() >= p.block_height.0 + self.stale_blocks, "not_stale");
        self.pending.remove(&k);
        let b = self.bounties.get_mut(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        b.pending = b.pending.saturating_sub(1);
        push_attempt(b, claimer.clone(), p.side, p.delta_sha256, "cleared_stale".into());
        Promise::new(claimer).transfer(NearToken::from_yoctonear(p.bond.0))
    }

    /// Forward the attached deposit to a wallet, but only if the bounty's claim was proved (not
    /// refuted). `to` defaults to the bounty's subject; any other `to` must be a wallet the pinned
    /// factory created from the pinned code (the board asks the factory; if not, the deposit comes
    /// back). The proof is about the code, so it covers every such wallet. If the claim is not
    /// proved the call fails and NEAR returns the deposit.
    #[payable]
    pub fn fund_if_proven(&mut self, id: U64, to: Option<AccountId>) -> Promise {
        self.live();
        let deposit = env::attached_deposit();
        require!(deposit.as_yoctonear() > 0, "attach_deposit");
        let factory = self.factory.clone();
        let code_refuted = self.refuted_by.is_some();
        let b = self.bounties.get_mut(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        let proved = matches!(b.phase, Phase::Owed | Phase::Paying | Phase::Paid)
            && b.certificate.as_ref().map(|c| c.side == Side::Proof).unwrap_or(false) && b.claim != ROOT_CLAIM;
        require!(proved, "not_proven");
        // Another claim about the same code was refuted: its wallets are being frozen, so no money goes in.
        require!(!code_refuted, "code_refuted");
        let to = to.or_else(|| b.subject.clone()).unwrap_or_else(|| env::panic_str("no_subject"));
        if Some(&to) == b.subject.as_ref() {
            // The subject was checked against the factory when the bounty opened.
            b.funded = U128(b.funded.0 + deposit.as_yoctonear());
            event("funded", json!({"id": id, "from": env::predecessor_account_id(), "to": to, "amount": U128(deposit.as_yoctonear()), "claim": b.claim}));
            return Promise::new(to).transfer(deposit);
        }
        let factory = factory.unwrap_or_else(|| env::panic_str("no_factory"));
        Promise::new(factory)
            .function_call_weight("wallet_of", serde_json::to_vec(&json!({"account_id": to})).unwrap(),
                NearToken::from_yoctonear(0), WALLET_OF_GAS, GasWeight(0))
            .then(Promise::new(env::current_account_id()).function_call_weight(
                "on_fund_checked",
                serde_json::to_vec(&json!({"id": id, "to": to, "from": env::predecessor_account_id(), "amount": U128(deposit.as_yoctonear())})).unwrap(),
                NearToken::from_yoctonear(0), FUND_CALLBACK_GAS, GasWeight(0)))
    }

    /// Pays `to` if the factory said it is one of its wallets running the pinned code; otherwise
    /// returns the deposit to `from`.
    #[private]
    pub fn on_fund_checked(&mut self, id: U64, to: AccountId, from: AccountId, amount: U128) -> Promise {
        let ok = match (&self.wallet_code_hash, read_json(0)) {
            (Some(h), Some(v)) => attests(&v, to.as_str(), h),
            _ => false,
        };
        // This request may have started before another receipt invalidated the code or
        // the kernel. Re-check here, where the transfer is actually scheduled. Panicking
        // would leave the deposit on this account, so return it through the refund path.
        let refusal = if self.kernel_broken_by.is_some() {
            Some("kernel_broken")
        } else if self.refuted_by.is_some() {
            Some("code_refuted")
        } else if !ok {
            Some("not_a_factory_wallet")
        } else {
            None
        };
        let b = self.bounties.get_mut(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        if refusal.is_none() {
            b.funded = U128(b.funded.0 + amount.0);
            event("funded", json!({"id": id, "from": from, "to": to, "amount": amount, "claim": b.claim}));
            Promise::new(to).transfer(NearToken::from_yoctonear(amount.0))
        } else {
            event("fund_refused", json!({"id": id, "from": from, "to": to, "amount": amount, "reason": refusal.unwrap()}));
            Promise::new(from).transfer(NearToken::from_yoctonear(amount.0))
        }
    }

    /// Freeze `wallet`: anyone may call it, but only once this board holds an accepted refutation of a
    /// claim about its wallet code, or has paid its root bounty; never on an accusation. The board asks
    /// the factory whether `wallet` runs that code and then calls the wallet's `freeze`, which accepts
    /// only its own board. Freezing twice changes nothing; a failed freeze can be sent again.
    pub fn freeze(&mut self, wallet: AccountId) -> Promise {
        require!(self.refuted_by.is_some() || self.kernel_broken_by.is_some(), "nothing_refuted");
        let factory = self.factory.clone().unwrap_or_else(|| env::panic_str("no_factory"));
        Promise::new(factory)
            .function_call_weight("wallet_of", serde_json::to_vec(&json!({"account_id": wallet})).unwrap(),
                NearToken::from_yoctonear(0), WALLET_OF_GAS, GasWeight(0))
            .then(Promise::new(env::current_account_id()).function_call_weight(
                "on_freeze_checked", serde_json::to_vec(&json!({"wallet": wallet})).unwrap(),
                NearToken::from_yoctonear(0), FREEZE_CHECKED_GAS, GasWeight(0)))
    }

    #[private]
    pub fn on_freeze_checked(&mut self, wallet: AccountId) -> PromiseOrValue<bool> {
        let ok = match (&self.wallet_code_hash, read_json(0)) {
            (Some(h), Some(v)) => attests(&v, wallet.as_str(), h),
            _ => false,
        };
        if ok {
            PromiseOrValue::Promise(self.send_freeze(wallet))
        } else {
            event("freeze_refused", json!({"wallet": wallet, "reason": "not_a_factory_wallet"}));
            PromiseOrValue::Value(false)
        }
    }

    fn send_freeze(&self, wallet: AccountId) -> Promise {
        Promise::new(wallet.clone())
            .function_call_weight("freeze", Vec::new(), NearToken::from_yoctonear(0), FREEZE_GAS, GasWeight(0))
            .then(Promise::new(env::current_account_id()).function_call_weight(
                "on_frozen", serde_json::to_vec(&json!({"wallet": wallet})).unwrap(),
                NearToken::from_yoctonear(0), FROZEN_CALLBACK_GAS, GasWeight(0)))
    }

    /// Records in the log whether the wallet accepted the freeze. The board keeps no list of frozen
    /// wallets: each wallet answers for itself (`get_policy`), and `freeze` can always be sent again.
    #[private]
    pub fn on_frozen(&mut self, wallet: AccountId) -> bool {
        let ok = env::promise_result_checked(0, 256).is_ok();
        event(if ok { "wallet_frozen" } else { "freeze_failed" }, json!({"wallet": wallet}));
        ok
    }

    fn pay(&mut self, id: u64, refund: bool) -> Promise {
        let b = self.bounties.get_mut(&id).unwrap_or_else(|| env::panic_str("no_bounty"));
        b.phase = if refund { Phase::PayingRefund } else { Phase::Paying };
        b.last_error = None;
        let (to, amount) = if refund {
            (b.poster.clone(), b.reward.0 - b.boosted.0)
        } else {
            (b.winner.clone().unwrap_or_else(|| env::panic_str("no_winner")), b.reward.0 + b.winner_bond.0)
        };
        Promise::new(to).transfer(NearToken::from_yoctonear(amount)).then(
            Promise::new(env::current_account_id()).function_call_weight(
                "on_payment",
                serde_json::to_vec(&json!({"id": U64(id), "refund": refund})).unwrap(),
                NearToken::from_yoctonear(0),
                PAY_CALLBACK_GAS,
                GasWeight(0),
            ),
        )
    }

    #[private]
    pub fn on_payment(&mut self, id: U64, refund: bool) -> bool {
        require!(env::promise_results_count() == 1, "one_result_required");
        let result = env::promise_result_checked(0, 0);
        let b = self.bounties.get_mut(&id.0).unwrap_or_else(|| env::panic_str("no_bounty"));
        require!(b.phase == if refund { Phase::PayingRefund } else { Phase::Paying }, "not_paying");
        let paid = match result {
            Ok(bytes) if bytes.is_empty() => true,
            Err(PromiseError::Failed) => false,
            // Unknown shape: keep the in-flight phase rather than risk paying twice.
            _ => {
                b.last_error = Some("unexpected_payment_result_inflight_preserved".into());
                return false;
            }
        };
        b.phase = match (refund, paid) {
            (false, true) => Phase::Paid,
            (false, false) => Phase::Owed,
            (true, true) => Phase::Refunded,
            (true, false) => Phase::OwedRefund,
        };
        if paid {
            let (to, amount) = if refund { (b.poster.clone(), b.reward.0 - b.boosted.0) } else { (b.winner.clone().unwrap(), b.reward.0 + b.winner_bond.0) };
            event(if refund { "refunded" } else { "paid" }, json!({"id": id, "to": to, "amount": U128(amount)}));
        } else {
            b.last_error = Some("transfer_failed_owed_preserved".into());
        }
        paid
    }

    pub fn get_config(&self) -> Config {
        Config {
            kernel: self.kernel.clone(),
            base_hash: self.base_hash.clone(),
            factory: self.factory.clone(),
            wallet_code_hash: self.wallet_code_hash.clone(),
            claims: self.claims.clone(),
            reveal_delay_blocks: U64(self.reveal_delay_blocks),
            min_reveal_gas_tgas: U64(self.min_reveal_gas_tgas),
            reveal_bond: U128(self.reveal_bond),
            grace_seconds: U64(self.grace_ns / 1_000_000_000),
            stale_blocks: U64(self.stale_blocks),
            bounties: U64(self.next_id),
            commit_domain: COMMIT_DOMAIN.into(),
            allowed_axioms: ALLOWED_AXIOMS.iter().map(|s| s.to_string()).collect(),
            code_refuted_by: self.refuted_by.map(U64),
            kernel_broken_by: self.kernel_broken_by.map(U64),
        }
    }

    pub fn get_bounty(&self, id: U64) -> Option<Bounty> {
        self.bounties.get(&id.0).cloned()
    }

    pub fn list_bounties(&self, from_index: Option<U64>, limit: Option<U64>) -> Vec<Bounty> {
        let from = from_index.map(|x| x.0).unwrap_or(0);
        let limit = limit.map(|x| x.0).unwrap_or(50).min(100);
        (from..self.next_id.min(from.saturating_add(limit)))
            .filter_map(|i| self.bounties.get(&i).cloned())
            .collect()
    }

    pub fn get_commit(&self, id: U64, account_id: AccountId) -> Option<Commit> {
        self.commits.get(&key(id.0, &account_id)).cloned()
    }

    pub fn get_pending(&self, id: U64, account_id: AccountId) -> Option<Pending> {
        self.pending.get(&key(id.0, &account_id)).cloned()
    }

    /// The bounty currently open for a shelf constant, if any.
    pub fn open_for(&self, name: String) -> Option<U64> {
        self.open_by_name.get(&name).map(|id| U64(*id))
    }

    /// The bounty that settled a shelf constant, if any.
    pub fn settled_by(&self, name: String) -> Option<U64> {
        self.settled.get(&name).map(|id| U64(*id))
    }

    /// Helper for clients: the commitment `commit` expects (view, free).
    pub fn commitment_for(&self, id: U64, account_id: AccountId, side: String, delta_sha256: String, salt: String) -> String {
        require!(is_hex64(&delta_sha256), "bad_delta_sha256");
        require!(Side::parse(&side).is_some(), "bad_side");
        commitment(id.0, account_id.as_str(), &side, &delta_sha256, &salt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_verdict() -> Value {
        json!({"ok": true, "reason": null, "theorem": "Wallet.Claim.AllowedReceiversOnly", "mode": "claim",
               "proof_theorem": "Solution.proof", "statement_hash": "a".repeat(64),
               "decls_checked": 28, "axioms": ["propext", "Quot.sound"], "base_hash": "b".repeat(64)})
    }

    #[test]
    fn accepts_exact_claim() {
        let r = judge(&ok_verdict(), "Wallet.Claim.AllowedReceiversOnly", &"b".repeat(64)).unwrap();
        assert_eq!(r.proof_theorem, "Solution.proof");
        assert_eq!(r.decls_checked, 28);
    }

    #[test]
    fn refuses_everything_else() {
        let claim = "Wallet.Claim.AllowedReceiversOnly";
        let base = "b".repeat(64);
        let mut v = ok_verdict();
        v["ok"] = json!(false);
        v["reason"] = json!("sorryAx");
        assert_eq!(judge(&v, claim, &base), Err("sorryAx".into()));
        let mut v = ok_verdict();
        v["mode"] = json!("theorem");
        assert_eq!(judge(&v, claim, &base), Err("not_claim_mode".into()));
        assert_eq!(judge(&ok_verdict(), "Wallet.Claim.Refute.AllowedReceiversOnly", &base), Err("claim_mismatch".into()));
        assert_eq!(judge(&ok_verdict(), claim, &"c".repeat(64)), Err("base_mismatch".into()));
        let mut v = ok_verdict();
        v["decls_checked"] = json!(0);
        assert_eq!(judge(&v, claim, &base), Err("empty_delta".into()));
        let mut v = ok_verdict();
        v["axioms"] = json!(["propext", "Lean.ofReduceBool"]);
        assert_eq!(judge(&v, claim, &base), Err("axiom_not_allowed:Lean.ofReduceBool".into()));
        let mut v = ok_verdict();
        v["statement_hash"] = json!("short");
        assert_eq!(judge(&v, claim, &base), Err("incomplete_verdict".into()));
        let mut v = ok_verdict();
        v["ok"] = json!("true");
        assert!(judge(&v, claim, &base).is_err());
    }

    #[test]
    fn root_bounty_wants_a_theorem_of_type_false() {
        let base = "b".repeat(64);
        // What the kernel answers for `theorem badApp : False` (sha256 of nanoda's debug print `False.[]`).
        let h = "a230a46ca5e70a1b2eec0ce060880d354617123df53bfbfbdc4c84823b6e317e";
        let ok = json!({"ok": true, "reason": null, "theorem": "badApp", "mode": "theorem", "proof_theorem": "badApp",
            "statement_hash": h, "decls_checked": 14, "axioms": [], "base_hash": base});
        assert_eq!(judge_root(&ok, &base).unwrap().proof_theorem, "badApp");
        // An honest proof of a claim, checked in theorem mode, is not a proof of `False`.
        let mut v = ok.clone();
        v["statement_hash"] = json!("9d62ba61439388513fc717ac8518ae3cb5045e7b64641a97aa7fecf1a9db23b5");
        assert_eq!(judge_root(&v, &base), Err("not_a_proof_of_false".into()));
        let mut v = ok.clone();
        v["mode"] = json!("claim");
        assert_eq!(judge_root(&v, &base), Err("not_theorem_mode".into()));
        let mut v = ok.clone();
        v["ok"] = json!(false);
        v["reason"] = json!("not_a_theorem:False is a base declaration");
        assert!(judge_root(&v, &base).is_err());
        assert_eq!(judge_root(&ok, &"c".repeat(64)), Err("base_mismatch".into()));
        let mut v = ok.clone();
        v["axioms"] = json!(["magic"]);
        assert_eq!(judge_root(&v, &base), Err("axiom_not_allowed:magic".into()));
        // The claim-side judge never takes a theorem-mode verdict, so a root proof cannot settle a claim.
        assert_eq!(judge(&ok, "badApp", &base), Err("not_claim_mode".into()));
    }

    #[test]
    fn commitment_binds_every_field() {
        let d = "d".repeat(64);
        let c = commitment(1, "alice.near", "proof", &d, "salt-0123456789abcdef");
        assert!(is_hex64(&c));
        assert_ne!(c, commitment(2, "alice.near", "proof", &d, "salt-0123456789abcdef"));
        assert_ne!(c, commitment(1, "bob.near", "proof", &d, "salt-0123456789abcdef"));
        assert_ne!(c, commitment(1, "alice.near", "refutation", &d, "salt-0123456789abcdef"));
        assert_ne!(c, commitment(1, "alice.near", "proof", &"e".repeat(64), "salt-0123456789abcdef"));
        assert_ne!(c, commitment(1, "alice.near", "proof", &d, "salt-0123456789abcdeg"));
    }

    #[test]
    fn deadline_cap_is_ninety_days() {
        assert_eq!(MAX_DEADLINE_NS, 7_776_000_000_000_000);
    }

    #[test]
    fn factory_answer() {
        let h = "a".repeat(64);
        let rec = json!({"wallet": "alice.wallets.near", "owner": "alice.near", "code_hash": h, "created_at": "1"});
        assert!(attests(&rec, "alice.wallets.near", &h));
        assert!(!attests(&rec, "bob.wallets.near", &h));
        assert!(!attests(&rec, "alice.wallets.near", &"b".repeat(64)));
        assert!(!attests(&Value::Null, "alice.wallets.near", &h));
    }

    #[test]
    fn names_and_sides() {
        assert!(valid_claim_name("Wallet.Claim.AllowedReceiversOnly"));
        assert!(!valid_claim_name(""));
        assert!(!valid_claim_name("Wallet.Spec.X\nfoo"));
        assert!(!valid_claim_name("a b"));
        assert_eq!(Side::parse("proof"), Some(Side::Proof));
        assert_eq!(Side::parse("refutation"), Some(Side::Refutation));
        assert_eq!(Side::parse("Proof"), None);
    }

    // The factory reply can arrive after a different receipt invalidates this board.
    // These checks inspect the actual scheduled transfer, not a helper predicate.
    #[allow(deprecated)]
    fn pending_funding_after_invalidation(kind: &str) -> (AccountId, u128, u128) {
        use near_sdk::test_utils::{VMContextBuilder, testing_env_with_promise_results, get_created_receipts};
        use near_sdk::mock::MockAction;
        use near_sdk::{testing_env, PromiseResult};
        let account = |s: &str| s.parse::<AccountId>().unwrap();
        let here = account("board.near");
        let wallet = account("bob.wallets.near");
        let source = account("sender.near");
        let hash = "a".repeat(64);
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(here.clone()).predecessor_account_id(here).account_balance(NearToken::from_near(100));
        testing_env!(ctx.build());
        let mut board = Board::new(account("kernel.near"), "b".repeat(64), Some(account("wallets.near")), Some(hash.clone()),
            vec![ClaimPair { claim: "Wallet.Claim.X".into(), counter: "Wallet.Claim.Refute.X".into() }],
            U64(40), U64(100), U128(1), U64(1), U64(100));
        let cert = Certificate { claimer: account("prover.near"), side: Side::Proof, proved: "Wallet.Claim.X".into(), proof_theorem: "Solution.proof".into(),
            statement_hash: "c".repeat(64), base_hash: "b".repeat(64), axioms: vec![], decls_checked: 1,
            delta_sha256: "d".repeat(64), block_height: U64(1), timestamp: U64(1) };
        board.bounties.insert(0, Bounty { id: U64(0), poster: source.clone(), claim: "Wallet.Claim.X".into(), counter_claim: Some("Wallet.Claim.Refute.X".into()),
            statement_sha256: Some("c".repeat(64)), counter_statement_sha256: None, title: "funding".into(), reward: U128(1), forfeited: U128(0), boosted: U128(0), boosters: 0,
            deadline: U64(1000), posted_at: U64(1), subject: None, subject_code_hash: None, phase: Phase::Paid, pending: 0, winner: Some(account("prover.near")),
            winner_bond: U128(0), certificate: Some(cert), funded: U128(0), escrow: U128(0), escrow_state: "none".into(), commitments: 1, attempts: vec![], attempts_total: 1,
            last_error: None, refused_because: None });
        if kind == "code" { board.refuted_by = Some(2); }
        if kind == "kernel" || kind == "posting" { board.kernel_broken_by = Some(3); }
        if kind == "posting" {
            board.bounties.get_mut(&0).unwrap().phase = Phase::Validating;
            let results = vec![
                PromiseResult::Successful(serde_json::to_vec("def Wallet.Claim.X : Prop := True").unwrap()),
                PromiseResult::Successful(serde_json::to_vec("def Wallet.Claim.Refute.X : Prop := Not Wallet.Claim.X").unwrap()),
            ];
            testing_env!(ctx.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), results);
            drop(board.on_posted(U64(0)));
            assert_eq!(board.bounties.get(&0).unwrap().refused_because.as_deref(), Some("kernel_broken"));
        } else {
            let answer = serde_json::to_vec(&json!({"wallet": wallet, "code_hash": hash})).unwrap();
            testing_env_with_promise_results(ctx.build(), PromiseResult::Successful(answer));
            drop(board.on_fund_checked(U64(0), wallet, source, U128(123)));
        }
        let transfers: Vec<_> = get_created_receipts().into_iter().flat_map(|r| r.actions.into_iter().filter_map(move |a| match a {
            MockAction::Transfer { deposit, .. } => Some((r.receiver_id.clone(), deposit.as_yoctonear())), _ => None,
        })).collect();
        assert_eq!(transfers.len(), 1);
        (transfers[0].0.clone(), transfers[0].1, board.bounties.get(&0).unwrap().funded.0)
    }

    #[test]
    fn funding_callback_returns_deposit_after_code_refutation() {
        let (receiver, amount, funded) = pending_funding_after_invalidation("code");
        assert_eq!(receiver.as_str(), "sender.near");
        assert_eq!((amount, funded), (123, 0));
    }

    #[test]
    fn funding_callback_returns_deposit_after_kernel_failure() {
        let (receiver, amount, funded) = pending_funding_after_invalidation("kernel");
        assert_eq!(receiver.as_str(), "sender.near");
        assert_eq!((amount, funded), (123, 0));
    }

    #[test]
    fn funding_callback_still_funds_a_valid_wallet() {
        let (receiver, amount, funded) = pending_funding_after_invalidation("healthy");
        assert_eq!(receiver.as_str(), "bob.wallets.near");
        assert_eq!((amount, funded), (123, 123));
    }

    #[test]
    fn posting_callback_returns_reward_after_kernel_failure() {
        let (receiver, amount, funded) = pending_funding_after_invalidation("posting");
        assert_eq!(receiver.as_str(), "sender.near");
        assert_eq!((amount, funded), (1, 0));
    }

}
