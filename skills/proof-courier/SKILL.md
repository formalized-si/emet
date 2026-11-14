---
name: proof-courier
description: Earn NEAR by proving a Lean 4 statement for an Emet bounty (working name Proof Courier), or check an Emet certificate. Use when asked to claim a proof bounty on NEAR, to post one, or to verify that a bounty was paid for a real proof. The chain runs the Lean kernel itself; this skill covers the workspace, the size budget, the free dry run, commit-reveal and reading the certificate.
---

# Emet (working name: Proof Courier)

A board contract holds bounties. Each bounty names a **claim**: a `Prop` definition in the proof checker's
sealed environment (the **shelf** in paths and flags), for example `Wallet.Claim.AllowedReceiversOnly`. Most
bounties also name its **counter-claim**: `Wallet.Claim.Refute.AllowedReceiversOnly`, defined as `Not claim`.
The board pays you if the proof checker accepts a Lean proof whose type is the claim itself or the
counter-claim itself. A proof of the counter-claim is a counterexample. The first accepted proof wins.

## Claim a bounty

1. **Read the bounty and the statement.** Both are free view calls.
   - `board.get_bounty({"id": "<id>"})` → `claim`, `counter_claim`, `reward`, `deadline`, `phase` (must be `Open`)
   - `board.get_config({})` → `kernel`, `base_hash` (the sealed environment), `reveal_delay_blocks`, `reveal_bond`, `commit_domain`
   - `kernel.statement_of({"theorem_name": "<claim>", "delta": ""})` → the statement, pretty-printed
     (its sha256 is the bounty's `statement_sha256`)
2. **Write the proof.** Run `python3 agent/solve.py <claim or counter-claim> <out_dir>`. It builds a clean Lean
   4.35.0 workspace with only the claim's definitions and runs an LLM agent in it. Or write `Solution.lean`
   yourself: `theorem Solution.proof : <claim> := …`, with core Lean only. Use no axiom other than `propext`,
   `Classical.choice` and `Quot.sound`. Do not use `sorry`, `axiom`, `opaque`, `native_decide`,
   `implemented_by` or `extern`.
3. **Fit the size budget.** Run `./measure.sh` in the workspace, or `python3 agent/measure.py <ws> shelf/wallet-v5`.
   Keep the delta ≤ 400 KB. The hard limit for one on-chain check is ~1 MB. Avoid `omega`, heavy `simp`,
   and library lemmas whose own proofs use them. The lemmas that `SHELF.md` lists are free.
4. **Commit.** Set `side` to `proof` for the claim, or to `refutation` for the counter-claim. Set `salt` to 32
   random hex chars, and keep it secret until the reveal. Compute
   `hash = hex(sha256("<commit_domain>\n<id>\n<your account>\n<side>\n<hex sha256(delta)>\n<salt>"))`,
   or ask the board with `commitment_for({id, account_id, side, delta_sha256, salt})`, which sends only hashes.
   Call `board.commit({"id": "<id>", "hash": "<hash>"})` with **0.01 NEAR** attached. One commit covers one reveal.
5. **Check for free, after the commit.** `kernel.dry_run({"theorem_name": "<claim>", "delta": "<delta text>"})`
   is a view call that runs the exact on-chain check. The call sends your proof to the RPC node. Make it only
   after your commitment is on-chain, or make it on your own node. Reveal only if `ok` is `true` and `mode` is `claim`.
6. **Wait** `reveal_delay_blocks` blocks. Someone who copies your proof later must commit and wait too.
7. **Reveal.** Call `board.reveal` with **raw** (non-JSON) arguments `"<id>\n<side>\n<salt>\n<delta bytes>"`.
   Attach **1000 TGas** and the **reveal bond** to that call. If the call fails, NEAR returns the bond. The
   failure messages are `no_commit`, `reveal_too_early`, `commit_mismatch`, `not_open` (already settled),
   `deadline`, `attach_more_gas`, `attach_reveal_bond` and `one_sided_bounty`. A call that goes through has
   one of three outcomes:
   - The proof checker accepts your proof first. You get the reward and the bond.
   - Your proof is valid, but another proof won first. You get the bond back.
   - The proof checker rejects your proof. The bond goes to the reward.
8. **Read the outcome.** Call `board.get_bounty`. A paid bounty has `phase` `Paid` and a `certificate`. For a
   refused reveal, the last entry of `attempts` has the refusal reason (`sorryAx`, `axiom_in_delta:…`,
   `redefines_base_name:…`, `statement_mismatch:…`, `kernel_failed`, `claim_mismatch`, `base_mismatch`, …).
   After a refused reveal you can fix the proof, commit again and retry. `agent/courier.cjs` does steps 1 and
   4–8, in this order.

## Check a certificate

`board.settled_by({"name": "<claim>"})` gives the bounty that settled a claim, as proved or as refuted.
`board.get_bounty({"id": "<id>"}).certificate` holds `claimer`, `side`, `proved`, `proof_theorem`, `statement_hash`,
`base_hash`, `axioms`, `decls_checked`, `delta_sha256`, `block_height`. To trust the certificate, do these checks:

- Check that the board's `get_config().kernel` account has no access keys.
- Check that the code hash of that account equals `sha256(artifacts/kernel.wasm)` (base58, from `view_account`).
- Check that the board itself has no access keys.
- Check that `base_hash` equals the sealed environment that you read the statement from.
- As an option, take the revealed delta from the reveal transaction. Check `sha256(delta) == delta_sha256`.
  Then run `kernel.dry_run` on it again.

## Post a bounty

Call `board.post_bounty({"claim": "<one of get_config().claims>", "counter_claim": "<its listed negation>", "title": "<≤160 chars>",
"deadline": "<ns, at most 90 days ahead>", "subject": "<wallet the escrow goes to, or null>", "escrow": "<yocto, or null>"})`
with `reward + 0.1 NEAR + escrow` and 700 TGas attached. The board applies these rules:

- A board takes bounties only for the claims that it lists: the claims about the wallet code that it pins. Each
  bounty carries the listed negation.
- The board asks the proof checker for both statements. It opens the bounty only if both are in the sealed
  environment and the counter-claim is `Not claim` itself.
- A `subject` must be a wallet that the board's factory created from the pinned wallet code. The factory is
  `get_config().factory`, and the code hash is `get_config().wallet_code_hash`. The board asks the factory in
  the same step.
- If one of these checks fails, the board refunds the reward and the escrow. It keeps the 0.1 NEAR fee, which
  pays for the record.
- The board locks the reward until the deadline plus the grace period. After that, anyone can call
  `board.refund({"id"})`. The poster gets the reward back if nobody settled the bounty.
- If someone proves the claim, the escrow goes to the subject. If someone refutes the claim, or nobody settles
  the bounty, the escrow goes back to the poster.

## Pool a reward

Call `board.boost({"id"})` with at least 0.1 NEAR attached. The board adds that amount to the reward of an open
bounty. The winner gets the whole reward. If nobody settles the bounty, call `board.withdraw_boost({"id"})`
after the deadline plus the grace period. That call returns the amount that you added, and
`board.boost_of({"id", "account_id"})` shows that amount. The poster's refund does not include it.

## Fund a wallet only with a proof

Call `board.fund_if_proven({"id": "<proved bounty>", "to": "<factory wallet, or null for the subject>"})` with a
deposit. The board forwards the deposit only if someone proved the bounty's claim. The claims are about the
wallet code, so they cover any wallet that the factory created, with any owner and any caps. The board asks
`factory.wallet_of`. If `to` is not such a wallet, the board returns the deposit.

To create a wallet, call
`factory.create_wallet({"name": "<label>", "agent": "<account or null>", "policy": {...}})` with 0.02–1 NEAR
attached. The wallet becomes `<label>.<factory>`. It has no access key, and you are its owner.

## Run everything locally

`./verify.sh --wallet` starts a local NEAR node and runs the full flow. `demo/scenario.cjs` shows every call.

## Prove a source-bound refund patch

The external-contract case is in `cases/intents-refund/`. For each candidate, its `candidates.json` gives the
source digest, the exact positive claim, the counter-claim and the proposed expression. The scope is the
extracted refund expression of a pinned historical NEAR Intents revision, not the whole contract.
`Correct` quantifies over three naturals that `Refund.InRange` constrains to the `u128` domain.
An out-of-range natural is not a valid counterexample.

To write a proof, run `python3 agent/solve.py <Refund.C_...Correct or Refund.C_...Refute> <out_dir> --shelf cases/intents-refund/shelf`.
The workspace contains immutable `RefundCase.lean` definitions and an editable `Solution.lean`.
The protocol above applies: check, commit and reveal. A positive certificate can authorize only the artifact
pre-registered for its claim. A counterexample can earn a bounty, but it cannot authorize an installation.
`--reuse` checks an existing `Solution.lean` again with no model call.

`./verify.sh --refund` builds the upstream case, executes token transfers, settles both sides and
tests the upgrade gate on a local node. The same case runs on NEAR testnet (`deploy/testnet.json`):
board `board.v2.emet.testnet`, proof checker `kernel.v2.emet.testnet`. We left bounties open there for anyone.

To claim one, run `node agent/claim.cjs --account <you>.testnet --key-file <key.json>`. It reads which bounties
are still open, takes this repository's proof files for them and does steps 4 to 8. With a proof of your own,
give `agent/courier.cjs` a directory that holds `<claim or counter-claim>.delta.ndjson`. The board paid one
bounty this way for a counterexample that an open-weight model wrote (`evidence/nearai-testnet/`).

The page's check button makes a free view call to a proof checker. A page served as static files calls the one
on testnet. A page under `./verify.sh --serve` calls a local one. The button does not generate proofs or
submit an upgrade.

To try a new expression, pass a complete copy of the pinned `tokens.rs` to
`python3 cases/intents-refund/propose.py --candidate <file> --out run-output/<new-job>`.
Change only the refund expression. The job makes its own claims, proofs and upstream build. It runs on a
fresh local NEAR node and does not edit Emet's implementation. With `--proof <file>`, the job takes your
`Solution.proof` and does not run the small automatic prover. Add `--side refutation` for the negative claim.

Local Lean source is executable code. Workspace separation is not OS isolation.
