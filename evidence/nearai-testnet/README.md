# A model's counterexample, paid on NEAR testnet

On 12 November 2026 the testnet board (`board.v2.emet.testnet`) paid bounty 3 for a proof that an
open-weight model wrote. Every number below is in `claim.json` or in the attempt directory beside it.

**The bounty.** The bounty is on the patch `requested_refund.min(*deposited)`. The patch caps a refund by the
deposit and forgets the receiver's balance. The board pays for a proof that the patch meets the refund rule, or for a proof that it does
not.

**The model.** The model is `deepseek-ai/DeepSeek-V4.1-Flash-1017`, served by NEAR AI Cloud. It got the name of
the claim and a workspace. The workspace had the definitions (`RefundCase.lean`), a list of library lemmas and an
empty `Solution.lean`. It had no counterexample and no proof. The prompt is the first message of
`deposit_only-deepseek-v4.1-flash/nearai/0001.request.json`.

The model wrote 12 versions of `Solution.lean` in 29 requests and 13 minutes. Lean reported an error on 6 of its
10 runs. Its first accepted version used requested 1, deposited 1, balance 0. It then made the proof smaller and
ended with requested 2, deposited 3, balance 1. With those values the patch returns 2, more than the balance left.
The cost was USD 0.085 at list price.

**The proof.** The proof is [`Solution.lean`](deposit_only-deepseek-v4.1-flash/Solution.lean), exported to
`delta.ndjson`. The export has 5,095 bytes, two declarations and no axiom.

**The chain.** `agent/courier.cjs` sent two transactions from `courier.emet.testnet`:
[commit](https://testnet.nearblocks.io/txns/777RRUW4Y1Ds673K4MAiNKYpm8BpxCp7TofXk45NokgZ) and
[reveal](https://testnet.nearblocks.io/txns/3cpPvWLdChwgP6yE95eMn63Lm6yknzeLwXXSpVGFqawy). The proof checker
checked the bytes in 122 TGas. The board paid 0.3 NEAR and returned the 0.01 NEAR bond. The certificate on
the board names the sha256 of `delta.ndjson`, `d72c631c…5274b7`.

## Check it

| Statement | Command |
|---|---|
| The board paid this account for these bytes | `./verify.sh --live` |
| NEAR AI's attested key signed all 29 responses. `Solution.lean` is the last file that the model wrote. Lean and nanoda accept it, and the export is the same bytes | `./verify.sh --nearai` |
| The record agrees with the files | `./verify.sh --offline` |

## What this does not show

- The model sent nothing and holds no key. This project created and funded the account `courier.emet.testnet`,
  and a script signed with its key. This project posted the bounty too. Nobody outside the project took part.
- The task is small: one counterexample to an expression of two terms.
- The attestation shows which key signed the responses. It does not show that the proof is right: the proof
  checker decides that. [`../nearai-refund/FACTS.md`](../nearai-refund/FACTS.md) lists what the offline check of
  the attestation leaves out, under "What this does not show".
- `report.json` counts 10 failed Lean runs. Its counter matched the word "errors" in "compiled with no errors". The
  transcript shows 6. We corrected the counter in `agent/nearai.py` after this run.
