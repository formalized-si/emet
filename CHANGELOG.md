# Changelog

This file lists the changes by day. We wrote the project for NEAR HACKATHON 2026, from 5 to 14 November.

## 14 November 2026

- The README names the two people who made the project, and the name of its entry in the hackathon's project
  list: "No Proof, No Upgrade (Emet)". Another team's entry in that list is also named EMET, and the FAQ says so.
- The README says when we wrote the earlier prototype that the proof checker contract came from: after the
  hackathon's announcement of 19 October 2026.
- The README gave 96 as the number of invalid proofs in one place. The number is 98.
- The page is at https://emet.formalized.si/. The earlier address, formalized-si.github.io/emet, redirects to it:
  a browser that knows formalized.si showed a warning about a look-alike address there.

## 13 November 2026

- **A review found the first deployment's checker unsound, and we redeployed.** A proof file could declare a name
  the checker computes by itself (`Nat.gcd` and five more, and in the wallet's environment also `String` and
  `Char.ofNat`), which the sealed environment did not declare, and so prove `False`. We claimed the bounty for a
  proof of `False` on `board.v1.emet.testnet` with that file: the board paid 1 NEAR and recorded its checker broken
  on chain (`deploy/v1/false-claim.json`). The fix refuses a delta that declares any of the 31 names the checker
  computes by itself, and every sealed environment now declares them; the two proofs are regression tests. The live
  deployment is now `v2.emet.testnet` with the fixed checker (`nanoda_lib-0.4.32/pinned-base/v4`), and the second
  checker is `arena2.emet.testnet`. See the README section "Our first deployment was unsound".
- The extractor now reads `*deposited.min(x)` as rustc does, and refuses it: a method call on the dereference needs
  `(*deposited).min(x)`.
- We rewrote every document, the text of the page and the help of `./verify.sh` in plain technical English. The
  rules are short active sentences, simple tenses and one name for one thing.
- The page and the video follow the design of formalized.si. The page uses Inter Tight and IBM Plex Mono. It has a
  dark stage with the checker in it, a row of numbers, and sections with a label column. We recorded the video
  again from that page.

## 12 November 2026

- **Deployed on NEAR testnet.** `deploy/live-refund.cjs` ran the refund case under `v1.emet.testnet` in 52
  transactions. The gate refused to upgrade without a proof, and refused a binary that differed in one bit. It
  installed the NEAR Intents team's own fix after the proof checker accepted the proof.
- **A model's proof paid on testnet.** An open-weight model on NEAR AI Cloud wrote a counterexample to a wrong
  patch. A courier submitted it, and the board paid bounty 3.
- **NEAR Proof Arena.** A second proof checker on testnet sealed the Arena's transfer relation and accepted the Arena's own
  proofs of two theorems about it.
- We stated the refund rule as four requirements, and its proofs use no axiom. We added a second theorem: it ties
  the rule to the size of the refund event. Its model gives the length of the log that testnet refused, to the byte.
- Three open-weight models proposed a patch for the refund expression and proved it on a local node.
- The seven Rust-built binaries rebuild to the same bytes on macOS arm64 and Linux x86_64. A mode that the host
  cannot run re-runs itself in a pinned container.
- A static page asks the proof checker contract from the browser. `tools/check_live.py` checks the deployment
  with read-only calls.
- `./verify.sh` without options runs the offline checks and the read-only checks of the deployment. The wallet
  scenario is `./verify.sh --wallet`. Every local node removes its directory when the run ends.
- We removed what no check and no statement used. That is the deployment script of the wallet board with its mode
  `--deploy`, and the mode `--all`. The Lean Kernel Arena fixtures now run with `tools/check_arena.sh`. We also
  removed a helper that collected testnet NEAR, and styles of elements that the page no longer has.

## 11 November 2026

- **The pinned type checker accepted two forged proofs of `False`** from the Lean Kernel Arena. We updated to
  nanoda_lib 0.4.32. Both proofs became regression tests, and we recorded the runs again.
- We sent 96 invalid proofs, the Arena's and our own, through the proof checker on a local node. It admitted none.
- An accepted counterexample freezes the wallet in the transaction that pays it. A bounty for a proof of `False`
  records a broken proof checker.
- Open-weight models on NEAR AI Cloud took the wallet's bounties. An offline check verifies their signed responses
  again.
- The upgrade gate on real NEAR Intents code replaced the model ledger as the main case.

## 9 November 2026

- We added a wallet factory on a global contract. One proof covers every wallet made from the same code.
- The corrected wallet policy has a proof. The refuted claim holds for it.
- We tested failure paths: a reward or an escrow transfer that fails, pooled rewards, retries.
- Two independent reviews led to fixes: a freed claim name, squatting, undeliverable refunds, stale verdicts. We
  named the project Emet.

## 8 November 2026

- We brought together the work of 5 to 7 November. It has the proof checker contract with nanoda, carried over
  from an earlier prototype of ours, with its tests and measurements.
- It also has the bounty board with commit and reveal, two-sided bounties, and the agent wallet compiled from a
  Lean policy. The prover agent, the first recorded scenario and `verify.sh` complete it.
