# The log budget of a refund

The deployed revision failed on an assumption about the size of an event.

On deposit, upstream writes an `mt_mint` event with the token ids and the amounts deposited. It then calls `check_refund()` on that event (upstream `crates/near/nep245/src/checked.rs`). The deposit fails unless that event, with the refund memo in place of its own, fits within 16,384 bytes. That is the most that a call can write to the log.

On refund, `resolve_deposit_internal` ([upstream/tokens.rs](upstream/tokens.rs)) writes an `mt_burn` event. The event has the id and the refund amount of every token whose refund is not zero. The function does not check the size of that event. Its comment: *"No need for `check_refund()` here since this IS the refund. The refund memo size was already accounted for in the original mint."*

The comment is sound if no refund amount is longer, as a decimal string, than the amount deposited. With `balance_left.min(requested_refund)` a refund can be 10^35 for a deposit of 1. In upstream's regression batch of 80 tokens the refund event comes to 17,353 bytes. The callback fails, and the 80 credits made at deposit time stay.

## The statements

The statements are in [LogBudget.lean](LogBudget.lean). The two theorems at the end are roots of the sealed environment (`shelf/base.ndjson`). They are roots for the catalog and for a caller's own patch alike. Because they are roots, the proof checker type-checks them with everything they depend on.

```lean
/-- How many of 10, 100, …, 10^k are not above `n`. -/
def powersOfTenUpTo (n : Nat) : Nat → Nat
  | 0 => 0
  | k + 1 => powersOfTenUpTo n k + (if 10 ^ (k + 1) ≤ n then 1 else 0)

/-- Decimal length of a u128 amount: 1 for 0 to 9, 2 for 10 to 99, and so on up to 39. -/
def digits (n : Nat) : Nat := 1 + powersOfTenUpTo n 38

/-- One token of a batch: the length of its id as written in an event, and the three inputs of its refund. -/
structure Item where
  idLen : Nat
  inputs : Args

/-- The amount the expression `e` returns for one token. -/
def refundOf (e : Expr) (x : Item) : Nat := eval x.inputs e

/-- Bytes one token adds to an event: `"<id>",` in the list `token_ids` and `"<amount>",` in the list `amounts`. -/
def entryBytes (idLen amount : Nat) : Nat := (idLen + 3) + (digits amount + 3)

/-- The two lists of the deposit event (`mt_mint`): every token of the batch, with the amount deposited. -/
def mintBytes : List Item → Nat
  | [] => 0
  | x :: rest => entryBytes x.idLen x.inputs.deposited + mintBytes rest

/-- The two lists of the refund event (`mt_burn`): the tokens whose refund is not zero, with the amount refunded. -/
def burnBytes (e : Expr) : List Item → Nat
  | [] => 0
  | x :: rest =>
    if refundOf e x = 0 then burnBytes e rest
    else entryBytes x.idLen (refundOf e x) + burnBytes e rest

theorem digits_mono {m n : Nat} (h : m ≤ n) : digits m ≤ digits n

theorem capped_refund_event_fits (e : Expr) :
    ∀ xs : List Item, (∀ x ∈ xs, refundOf e x ≤ x.inputs.deposited) → burnBytes e xs ≤ mintBytes xs

theorem refund_event_fits (e : Expr) (h : meetsRule e) (xs : List Item)
    (hx : ∀ x ∈ xs, InRange x.inputs) : burnBytes e xs ≤ mintBytes xs

theorem old_refund_event_can_outgrow :
    ∃ xs : List Item, (∀ x ∈ xs, InRange x.inputs) ∧
      mintBytes xs < burnBytes C_72245952a41246be823dfbe992b2ff76be05461008b4257b6ad0cb20954fc37e.expression xs
```

`Expr`, `Args`, `eval`, `InRange` and `meetsRule` are those of [RefundCase.lean](RefundCase.lean). `C_7224….expression` is the old expression, `balance_left.min(requested_refund)`. Its name carries the digest of upstream's file.

## What they say

- `refund_event_fits` is about any expression that meets the rule and any batch. For them, the two lists of the refund event are not longer than the two lists of the deposit event.
- "Any batch" is any finite list of tokens. Each token has any id length and any three inputs (requested, deposited, balance) within u128, independent of the other tokens. The real loop reads the balance again for every token, after the refunds before it. If the receiver's answer is missing or unusable, the loop takes the deposit as the request. Each run reads one such list, so the statement covers every run of the loop. It also covers lists that no run can produce.
- The proof of `refund_event_fits` is one line. It takes line 2 of the rule (`r ≤ a.deposited`) for each token and applies `capped_refund_event_fits`. That lemma needs nothing else from the expression. It rests on `digits_mono`: a larger amount is not shorter.
- `old_refund_event_can_outgrow`: for the old expression there is a batch within u128 whose refund lists are longer. The witness is one token of upstream's regression batch. It has an id of 173 bytes and a deposit of 1. Its receiver holds 10^37 + 80 and asks for 10^35 back. The refund carries 36 digits where the deposit carried one.
- A certificate that a patch meets the rule is a proof of `meetsRule` for its expression. `refund_event_fits` then gives the bound for that patch. The proof checker checks the theorem and the certificate's proof. The one application that joins them is not a separate term on chain.

With upstream's check the bound becomes a bound on the event. In the recorded runs (below), this holds in bytes:

    refund event = deposit event + (6 - length of the deposit memo) + burnBytes - mintBytes

`deposit event + (6 - length of the deposit memo)` is the length that `check_refund` compares with 16,384 before it lets the deposit through. So if `burnBytes ≤ mintBytes`, the refund event is not longer than the length checked on deposit. This step uses two facts of upstream's source. First, the three callers of `deposit` that lead to a refund all pass the memo `deposit`. For an event without a memo, `check_refund` adds 16 bytes instead. Second, the node's limit is on all the logs of one call together, and the refund callback writes this event and no other log.

## What they do not say

- This is a model of two JSON lists. It does not model the whole event, and it does not model Rust. We read three facts from upstream's source.
  - First: apart from the memo, the rest of the event has the same length in both events. The names `mt_mint` and `mt_burn` have the same length. The recorded logs measure this fact.
  - Second: the refund event lists the tokens in the order of the deposit, with the ids written the same way. The recorded logs show that the refund event lists the same ids. They do not show the order of different tokens, because every recorded batch is one token repeated.
  - Third: the refund event leaves out a token with a refund of zero. No recorded run has a refund of zero, so no log measures this fact.
- `check_refund`, the check made on deposit, is upstream's code. The model includes neither that check nor the limit of 16,384 bytes.
- Amounts are u128 values. `digits` is the decimal length for every amount below 10^39. That range includes every u128. Above it, the value stays at 39. The tests check it at both ends of every decade and against Lean's own decimal string. `digits_mono` covers what lies between.
- The model counts a comma after every entry. JSON writes none after the last one, so the two lists of a real event are 2 bytes shorter than the count. The contract writes an event only if the event lists at least one token. So the difference is the same 2 bytes on both sides.
- We trust the extractor's reading of the Rust expression and sample it against rustc, as for the rule.
- Nothing here is about other events (transfers, withdrawals) or other paths of the contract.

## Axioms

No statement here uses an axiom. `#print axioms` reports "does not depend on any axioms" for `powersOfTenUpTo`, `digits`, `Item`, `refundOf`, `entryBytes`, `mintBytes`, `burnBytes`, `powersOfTenUpTo_mono`, `digits_mono`, `capped_refund_event_fits`, `refund_event_fits` and `old_refund_event_can_outgrow`. The sealed environment of the catalog still has no axiom declaration. A caller's patch gets an environment that admits `propext`, as before. These theorems do not use that axiom.

## Measured

`check_log_model.py` reads the recorded transactions (`evidence/refund/replay.json` and its full trace). For each deposit it takes the `mt_mint` event that the contract wrote. It computes the refund of each token from the candidate's expression, the request and the balance, which falls with each refund. It then compares the model with the `mt_burn` event.

If the contract wrote that event, the script uses the event itself. If the node refused the log, the script uses the length that the node reports. The node reports the total of the logs of that call, and the refund event is its only log.

| Recorded transaction | Deposit event | Outside the lists + mintBytes - 2 | Checked on deposit | burnBytes - mintBytes | Refund event | Model |
|---|---|---|---|---|---|---|
| old code, 1 token, 100 asked back | 239 | 156 + 85 - 2 | 238 | 87 - 85 = 2 | 240, written | 240 |
| old code, 80 tokens, id 173 bytes, 10^35 asked back | 14,554 | 156 + 14,400 - 2 | 14,553 | 17,200 - 14,400 = 2,800 | 17,353, refused by the node | 17,353 |
| fixed code, 1 token, 100 asked back | 239 | 156 + 85 - 2 | 238 | 85 - 85 = 0 | 238, written | 238 |
| fixed code, 80 tokens, id 173 bytes, 10^35 asked back | 14,554 | 156 + 14,400 - 2 | 14,553 | 14,400 - 14,400 = 0 | 14,553, written | 14,553 |
| old code, 80 tokens moved by a NEP-245 transfer, id 175 bytes | 14,714 | 156 + 14,560 - 2 | 14,713 | 17,360 - 14,560 = 2,800 | 17,513, refused by the node | 17,513 |
| fixed code, the same transfer | 14,714 | 156 + 14,560 - 2 | 14,713 | 14,560 - 14,560 = 0 | 14,713, written | 14,713 |

Every deposit is of 1 per token, with the memo `deposit` (7 bytes, against 6 for the refund memo). All six lengths agree with the model to the byte. The script also checks three things. Each deposit event lists every token that its transaction sent. Each event is the only log of its call. The record holds both a refused and a written refund event.

These six runs do not exercise four cases:

- Amounts of other lengths than 1, 3 and 36 digits. The tests cover `digits` at every length.
- A balance that limits a refund. In each run the request or the deposit limits it.
- A refund of zero.
- A batch of different tokens.

The proof checker type-checked the environment with these theorems on a local node (534 declarations, 877,505 bytes, sha256 `72efd27b…`). Sealing took 144.6 TGas. The five calls after it took 168.3, 163.3, 179.8, 172.9 and 172.5 TGas. These figures are from one rehearsal (`node deploy/live-refund.cjs --claim-open`). The record of that rehearsal is not in this repository. `./verify.sh --rehearse` measures the figures again and writes `run-output/live-refund-sandbox.json`.

## Re-check

```
bash cases/intents-refund/export.sh                      # Lean builds LogBudget.lean; the environment and the five proofs are exported; nanoda checks each
grep -c '"axiom"' cases/intents-refund/shelf/base.ndjson # 0
python3 cases/intents-refund/test_prepare.py             # digits, upstream's batch (80 × 35 = 2,800), the Python model against Lean, #print axioms
python3 cases/intents-refund/check_log_model.py          # the table above, from the recorded logs
```
