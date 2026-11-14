//! Proof Courier wallet factory: one published wallet code, any number of wallets, and an on-chain
//! answer to "which code does this account run?".
//!
//! * `new` publishes the wallet wasm once as a NEAR global contract, identified by its sha256.
//! * `create_wallet` makes `<name>.<factory>` in one transaction: create the account, fund its
//!   storage, point it at the global code by hash, and call the wallet's `init` with the caller as
//!   owner. The new account has no access keys and the wallet has no upgrade method, so it runs that
//!   code for good. Only this factory can create sub-accounts of itself.
//! * `wallet_of(account)` returns the record of a wallet created here (with the code hash), or
//!   nothing. The Proof Courier board calls it before it moves money to a wallet: a proof about the
//!   wallet code then covers every wallet this factory created, whatever caps its owner chose.
//! * `new` may name the factory's board. Every wallet is then told at `init` that this account, and no
//!   other, may freeze it (the board does so when a claim about the wallet code is refuted).
//!
//! No owner, no upgrade method; after setup the factory account has no keys either.
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{json, Map, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise};

/// Paid by the caller of `create_wallet`: the wallet's own storage (its code is global, so only its
/// state counts) plus the factory's record. More can be sent to the wallet later as plain transfers.
pub const MIN_DEPOSIT: NearToken = NearToken::from_millinear(20);
/// Bounds what the factory must hold to return the deposit of a failed setup before the failed
/// receipt's own refund reaches it.
pub const MAX_DEPOSIT: NearToken = NearToken::from_near(1);
/// Kept by the factory for its record of the wallet.
pub const RECORD_FEE: NearToken = NearToken::from_millinear(5);
const INIT_GAS: Gas = Gas::from_tgas(30);
const CREATED_GAS: Gas = Gas::from_tgas(15);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Wallets,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct WalletRecord {
    pub wallet: AccountId,
    pub owner: AccountId,
    /// sha256 (hex) of the wasm the wallet runs: the global contract this factory published.
    pub code_hash: String,
    pub created_at: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    code_hash: [u8; 32],
    wallets: LookupMap<AccountId, WalletRecord>,
    count: u64,
    /// The only account that may freeze this factory's wallets (fixed here, written into each wallet).
    board: Option<AccountId>,
}

fn event(name: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "proof-courier-factory", "version": "1.0.0", "event": name, "data": [data]})
    ));
}

/// A wallet name: the label in front of `.<factory>`.
pub fn valid_label(s: &str) -> bool {
    (2..=32).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        && !s.starts_with(['-', '_'])
        && !s.ends_with(['-', '_'])
}

#[near]
impl Factory {
    /// Publishes `wallet_code` as a global contract (the factory account pays its storage once).
    /// `board`, if given, is the account that may freeze the wallets created here; it need not exist
    /// yet, so name an account only you can create.
    #[init]
    pub fn new(wallet_code: Base64VecU8, board: Option<AccountId>) -> Self {
        require!(!wallet_code.0.is_empty(), "empty_code");
        let code_hash: [u8; 32] = env::sha256_array(&wallet_code.0);
        // Scheduled on its own; the account's balance pays the global contract's storage.
        drop(Promise::new(env::current_account_id()).deploy_global_contract(wallet_code.0));
        event("code_published", json!({"code_hash": hex::encode(code_hash), "board": board}));
        Self { code_hash, wallets: LookupMap::new(Key::Wallets), count: 0, board }
    }

    /// Creates `<name>.<factory>` running the published code, initialised with the caller as owner,
    /// `agent` (optional) and `policy` (the wallet's policy JSON). Attach 0.02 to 1 NEAR; if setup
    /// fails the whole deposit is returned.
    #[payable]
    pub fn create_wallet(&mut self, name: String, agent: Option<AccountId>, policy: Value) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_DEPOSIT, "deposit_too_small");
        require!(deposit <= MAX_DEPOSIT, "deposit_too_large");
        require!(valid_label(&name), "bad_name");
        require!(policy.is_object(), "policy_not_an_object");
        let wallet: AccountId = format!("{}.{}", name, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("bad_name"));
        require!(!self.wallets.contains_key(&wallet), "wallet_exists");
        let owner = env::predecessor_account_id();
        let mut args = Map::new();
        args.insert("owner".into(), json!(owner));
        if let Some(a) = &agent {
            args.insert("agent".into(), json!(a));
        }
        args.insert("policy".into(), policy);
        if let Some(b) = &self.board {
            args.insert("board".into(), json!(b));
        }
        Promise::new(wallet.clone())
            .create_account()
            .transfer(deposit.saturating_sub(RECORD_FEE))
            .use_global_contract(self.code_hash)
            .function_call("init", Value::Object(args).to_string().into_bytes(), NearToken::from_yoctonear(0), INIT_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CREATED_GAS).on_created(wallet, owner, U128(deposit.as_yoctonear())))
    }

    #[private]
    pub fn on_created(&mut self, wallet: AccountId, owner: AccountId, deposit: U128) -> Option<WalletRecord> {
        if env::promise_result_checked(0, 1024).is_ok() {
            let record = WalletRecord {
                wallet: wallet.clone(),
                owner: owner.clone(),
                code_hash: hex::encode(self.code_hash),
                created_at: U64(env::block_timestamp()),
            };
            self.wallets.insert(wallet.clone(), record.clone());
            self.count += 1;
            event("wallet_created", json!({"wallet": wallet, "owner": owner, "code_hash": record.code_hash}));
            Some(record)
        } else {
            // The failed setup's own refund comes back to this account; the caller gets the whole deposit.
            drop(Promise::new(owner.clone()).transfer(NearToken::from_yoctonear(deposit.0)));
            event("wallet_setup_failed", json!({"wallet": wallet, "owner": owner, "refunded": deposit}));
            None
        }
    }

    /// sha256 (hex) of the wallet code every wallet created here runs.
    pub fn wallet_code_hash(&self) -> String {
        hex::encode(self.code_hash)
    }

    /// The record of a wallet created here, or null for any other account.
    pub fn wallet_of(&self, account_id: AccountId) -> Option<WalletRecord> {
        self.wallets.get(&account_id).cloned()
    }

    /// The account that may freeze the wallets created here, if any.
    pub fn board(&self) -> Option<AccountId> {
        self.board.clone()
    }

    pub fn wallet_count(&self) -> U64 {
        U64(self.count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert!(valid_label("alice"));
        assert!(valid_label("bob-2"));
        assert!(!valid_label("a"));
        assert!(!valid_label("x.y"));
        assert!(!valid_label("Alice"));
        assert!(!valid_label("-x"));
        assert!(!valid_label(&"a".repeat(33)));
    }
}
