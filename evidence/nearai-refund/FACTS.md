# A model writes the patch and its proof; the kernel contract checks it: recorded facts

`python3 -I agent/nearai_patch.py record` writes this file from the records beside it. Do not edit it by hand.

The model runs started between 2026-11-12T09:33:26Z and 2026-11-12T10:37:12Z. The complete jobs started between 2026-11-13T18:25:26Z and 2026-11-13T18:34:07Z, with the kernel `6dd4f5f42d3a7b49…`, the board `bd4c84594c4ce873…` and the gate `259301010dd6ef74…` of `artifacts/`. A job makes no model request: it submits the saved candidate and proof, so a job can be later than its model run. All times are UTC.

Every chain step ran on a local NEAR node (near-sandbox 2.14.0, protocol 88). The scripts sent nothing to testnet or mainnet. Every number
here is in `attempts.json` or in the named file of an attempt directory.

## In short

5 attempts ran, in this order: `deepseek-ai/DeepSeek-V4.1-Flash-1017`, `Qwen/Qwen3.8-27B`, `z-ai/glm-5.3-flash`, `deepseek-ai/DeepSeek-V4.1-Flash-1017`, `z-ai/glm-5.3-flash`. Each got the same prompt: the pinned NEAR Intents source file, the observation and the rule in words. Each model had to propose a replacement for the refund expression. It also had to write a Lean proof of the claim that the extractor generated for its own expression, in 3 rounds at most. 1 of them (`deepseek-v4.1-flash-noaxioms`) asked for a proof with no axiom at all. The others had to stay within propext, as the chain requires for a caller's patch.

4 of 5 ended with an accepted proof (2 in round 1, 2 in round 2). Lean reports these axioms for the accepted proofs: `deepseek-v4.1-flash-2` (none), `qwen3.8-27b-2` (none), `deepseek-v4.1-flash-noaxioms` (none), `glm-5.3-flash-3` (propext).

For each of them the complete job ran on a fresh local NEAR node. The kernel contract checked the proof bytes, and its receipt burnt 159 to 162 TGas. The board paid the account that submitted them. The keyless gate installed the contract that the job built from the model's source (4 of 4 installed). The same contract account answered 100 before the upgrade and 1 after it.

The 19 model requests of these attempts cost USD 0.0978 at list price (billed: USD 0.0869).

## All attempts

| Attempt | Model | Rounds | Axioms of the accepted proof | Requests | Tokens in / out | List price | Billed | Model time | Kernel contract (local node) | Installed by the gate | Signed responses | Attestation (offline) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `deepseek-v4.1-flash-2` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 1: `(requested_refund.min(*deposited)).min(balance_left)` proof accepted | none | 3 | 11,518 / 9,159 | USD 0.0144 | USD 0.0123 | 161 s | accepted, 159 TGas, bounty Paid | yes, 14/14 checks, job 174 s | 3/3 | yes |
| `qwen3.8-27b-2` | `Qwen/Qwen3.8-27B` | 1: `requested_refund.min(*deposited).min(balance_left)` proof rejected; 2: `requested_refund.min(*deposited).min(balance_left)` proof accepted | none | 5 | 21,394 / 40,501 | USD 0.0555 | USD 0.0553 | 809 s | accepted, 162 TGas, bounty Paid | yes, 14/14 checks, job 172 s | 5/5 | yes |
| `glm-5.3-flash-2` | `z-ai/glm-5.3-flash` | none: `balance_left.min(requested_refund).min(*deposited)` bound, no proof submitted | - | 3 | 8,991 / 11,007 | USD 0.0097 | USD 0.0059 | 2028 s | - | - | 3/3 | yes |
| `deepseek-v4.1-flash-noaxioms` (asked for no axiom) | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 1: `requested_refund.min(*deposited).min(balance_left)` proof accepted | none | 2 | 7,157 / 5,264 | USD 0.0085 | USD 0.0069 | 153 s | accepted, 160 TGas, bounty Paid | yes, 14/14 checks, job 173 s | 2/2 | yes |
| `glm-5.3-flash-3` | `z-ai/glm-5.3-flash` | 1: `balance_left.min(requested_refund).min(*deposited)` proof rejected; 2: `balance_left.min(requested_refund).min(*deposited)` proof accepted | propext | 4 | 15,743 / 11,715 | USD 0.0097 | USD 0.0066 | 1209 s | accepted, 159 TGas, bounty Paid | yes, 14/14 checks, job 171 s | 4/4 | yes |

The ledger of this work (`spend.jsonl`), replaced attempts included, has 25 requests: USD 0.1082 at list price, USD 0.0964 billed.

The columns:

- *Rounds*: each expression that the model proposed, and its outcome.
- *List price*: all prompt and completion tokens at the prices of `GET /v1/models`.
- *Billed*: NEAR AI's own figure from `POST /v1/billing/costs` (`billed.json`).
- *Model time*: wall time from the first request to the end of the run, with the local checks in it.
- *Kernel contract*: the gas that the receipt of the kernel contract burnt in the transaction that revealed the proof.
- *Installed by the gate*: the result of the complete job and its wall time, which includes two Rust builds of the
  upstream contract.

## Earlier attempts, replaced

| Attempt | Model | Rounds | Axioms of the accepted proof | Requests | Tokens in / out | List price | Billed | Model time | Kernel contract (local node) | Installed by the gate | Signed responses | Attestation (offline) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `deepseek-v4.1-flash` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 1: `balance_left.min(requested_refund.min(*deposited))` proof accepted | - | 2 | 6,555 / 519 | USD 0.0026 | USD 0.0017 | 13 s | accepted, 131 TGas, bounty Paid | yes, 14/14 checks, job 158 s | 2/2 | yes |
| `qwen3.8-27b` | `Qwen/Qwen3.8-27B` | 1: `requested_refund.min(*deposited).min(balance_left)` proof accepted | - | 2 | 6,932 / 4,305 | USD 0.0061 | USD 0.0061 | 88 s | accepted, 130 TGas, bounty Paid | yes, 14/14 checks, job 167 s | 2/2 | yes |
| `glm-5.3-flash` | `z-ai/glm-5.3-flash` | 1: `requested_refund.min(*deposited).min(balance_left)` proof accepted | - | 2 | 6,024 / 2,376 | USD 0.0017 | USD 0.0017 | 201 s | accepted, 130 TGas, bounty Paid | yes, 14/14 checks, job 157 s | 2/2 | yes |

These 3 attempts are no longer in this tree. The reason: the Lean statement of the rule changed on 12 November 2026, from one equation with min (exactRefund) to four requirements (Rule, meetsRule); these attempts proved the earlier statement. Their rows are in `attempts.json` under `superseded`. Their requests are still in `spend.jsonl`. Their evidence is in an earlier revision of this work, which this repository does not hold. They are not part of the results above, and `./verify.sh --nearai` does not check them again.

## What the model was given

The model got one prompt (`deepseek-v4.1-flash-2/prompt.md`, 9,429 bytes, sha256 `9ae8f6c4edc70c71…`). It holds:

- The pinned upstream file, complete and unchanged. Upstream's own comment `// TEMPORARY LOCAL CHANGE: refunds are NOT capped by deposited amounts` is on the line above the expression.
- "WHAT WAS OBSERVED. On a local NEAR node running this code, an account already held 1000 units of a token in the contract. A deposit of 1 more unit arrived for it, the receiver's mt_on_transfer asked for 100 units back, and resolve_deposit_internal refunded 100."
- "THE RULE. For each token of a transfer, a refund is never more than the amount requested, never more than the amount deposited in this transfer, never more than the receiver's remaining balance, and is exactly one of those three amounts."
- The language that the extractor accepts (requested_refund, *deposited, balance_left, unsigned integer literals, parentheses and .min(...)), the two tools and the limit of 3 rounds.

The prompt does not hold the repaired expression, and it holds no Lean. The answer to an accepted `propose_patch` call then gives the model five things:

- `RefundCase.lean` as `prepare.py` generated it for that expression.
- The name of the claim.
- The shape of `Solution.lean`.
- The rules that the checker enforces.
- The names of the library lemmas in the sealed environment.

Each attempt keeps every request in full in `<attempt>/nearai/NNNN.request.json`.

That generated file states the rule as follows (`deepseek-v4.1-flash-2/RefundCase.lean`):

    /-- The refund rule for one deposit: `r` is the amount returned. -/
    def Rule (a : Args) (r : Nat) : Prop :=
      r ≤ a.requested ∧  -- never more than the receiver asked to return
      r ≤ a.deposited ∧  -- upstream's comment: "refunds are capped by deposited amounts"
      r ≤ a.balance ∧    -- "and balance left on the receiver"
      (r = a.requested ∨ r = a.deposited ∨ r = a.balance)  -- and it is one of the three, so never less than they allow
    def meetsRule (e : Expr) : Prop := ∀ a : Args, InRange a → Rule a (eval a e)

## Round by round

### `deepseek-v4.1-flash-2`: `deepseek-ai/DeepSeek-V4.1-Flash-1017`

The run started at 2026-11-12T09:33:26Z. It made 3 requests and took 161.2 s from the first request to its end. The cost was USD 0.0144 at the list price of USD 0.30 / 1.20 per million tokens in / out. Result: accepted in round 1. 1 of its replies ended at the token limit before any tool call, and the loop asked the model to go on.

- Round 1, expression `(requested_refund.min(*deposited)).min(balance_left)`. The extractor bound it to the claim `Refund.C_2947c314….Correct` (candidate source sha256 `2947c314ccccc30626af77a12695196d1d77e0f7055edca006fa56f6c529bec6`). This is not the text of upstream's fix. The model then called `write_solution` with

      import RefundCase

      namespace Solution

      theorem proof : Refund.C_2947c314ccccc30626af77a12695196d1d77e0f7055edca006fa56f6c529bec6.Correct := by
        intro a _
        show Refund.Rule a (min (min a.requested a.deposited) a.balance)
        have hm1 : min (min a.requested a.deposited) a.balance ≤ a.requested :=
          Nat.le_trans (Refund.min_le_first (min a.requested a.deposited) a.balance)
            (Refund.min_le_first a.requested a.deposited)
        have hm2 : min (min a.requested a.deposited) a.balance ≤ a.deposited :=
          Nat.le_trans (Refund.min_le_first (min a.requested a.deposited) a.balance)
            (Refund.min_le_second a.requested a.deposited)
        have hm3 : min (min a.requested a.deposited) a.balance ≤ a.balance :=
          Refund.min_le_second (min a.requested a.deposited) a.balance
        refine ⟨hm1, hm2, hm3, ?_⟩
        rcases Nat.le_total (min a.requested a.deposited) a.balance with hlow | hlow
        · have hb : min (min a.requested a.deposited) a.balance = min a.requested a.deposited :=
            Nat.min_eq_left hlow
          rcases Nat.le_total a.requested a.deposited with hreq | hdep
          · left
            rw [hb, Nat.min_eq_left hreq]
          · right
            left
            rw [hb, Refund.min_right hdep]
        · have hb : min (min a.requested a.deposited) a.balance = a.balance :=
            Refund.min_right hlow
          right
          right
          exact hb

      end Solution

  Accepted. Lean 4.35.0 elaborated it. The exported proof file (12,401 bytes) declares no axiom. A native build of nanoda type-checked the sealed environment plus the proof. The model's proof is axiom-free: Lean reports that `Solution.proof` does not depend on any axioms.
- Complete job (started 2026-11-13T18:25:26Z, 174 s, near-sandbox 2.14.0, protocol 88): 14 of 14 checks passed. The job elaborated the saved `Solution.lean` and exported it again, because the sealed environment that `prepare.py` generates changed after the model's round. The job has 12,401 proof bytes against environment `e06fb584d91cef99…`. The round had 12,401 bytes against `f01622369c709780…`. The Lean text is the model's, unchanged.

  The certificate of the kernel contract proves `Refund.C_2947c314….Correct` and lists these axioms: none. The receipt of the kernel contract burnt 158.7 TGas (169.6 TGas for all receipts of that transaction). The bounty phase is Paid, and the winner is `prover.test.near`. Installed: yes, wasm `f24d072edcb76a81…`, byte for byte `artifacts/refund/fixed.wasm`. The same account answered `100` before and `1` after.
- `RefundCase.lean` as the model saw it, compared with the file that `prepare.py` generates for this candidate now: the same declarations, other comments.

      shown: (r = a.requested ∨ r = a.deposited ∨ r = a.balance)  -- and it is one of the three, so never less than they allow
      now:   (r = a.requested ∨ r = a.deposited ∨ r = a.balance)  -- and never less than the three allow

### `qwen3.8-27b-2`: `Qwen/Qwen3.8-27B`

The run started at 2026-11-12T09:38:52Z. It made 5 requests and took 808.9 s from the first request to its end. The cost was USD 0.0555 at the list price of USD 0.04 / 1.35 per million tokens in / out. Result: accepted in round 2. 2 of its replies ended at the token limit before any tool call, and the loop asked the model to go on.

- Round 1, expression `requested_refund.min(*deposited).min(balance_left)`. The extractor bound it to the claim `Refund.C_63721259….Correct` (candidate source sha256 `63721259eb182e5e0c4c97d1d21c898759b05f3d91819379c6251573ce4c426f`). This is the expression of upstream's fix (the `repair` candidate of this repository). The model then called `write_solution` with

      import RefundCase

      namespace Solution

      theorem proof : Refund.C_63721259eb182e5e0c4c97d1d21c898759b05f3d91819379c6251573ce4c426f.Correct := by
        intro a _
        constructor
        · exact Nat.le_trans (Refund.min_le_first _ _) (Refund.min_le_first _ _)
        · constructor
          · exact Nat.le_trans (Refund.min_le_first _ _) (Refund.min_le_second _ _)
          · constructor
            · exact Refund.min_le_second _ _
            · cases Nat.le_total (min a.requested a.deposited) a.balance with
              | inl hmn =>
                have hmn_eq : min (min a.requested a.deposited) a.balance = min a.requested a.deposited := Nat.min_eq_left hmn
                cases Nat.le_total a.requested a.deposited with
                | inl hrd =>
                  have hmn_eq_R : min a.requested a.deposited = a.requested := Nat.min_eq_left hrd
                  left
                  rw [hmn_eq, hmn_eq_R]
                | inr hDR =>
                  have hmn_eq_D : min a.requested a.deposited = a.deposited := Refund.min_right hDR
                  right
                  left
                  rw [hmn_eq, hmn_eq_D]
              | inr hBmn =>
                have hB_eq : min (min a.requested a.deposited) a.balance = a.balance := Refund.min_right hBmn
                right
                right
                rw [hB_eq]

      end Solution

  Rejected: error: Solution.lean:20:16: Tactic `rewrite` failed: Did not find an occurrence of the pattern; error: Solution.lean:25:16: Tactic `rewrite` failed: Did not find an occurrence of the pattern; error: Solution.lean:30:14: Tactic `rewrite` failed: Did not find an occurrence of the pattern
- Round 2, expression `requested_refund.min(*deposited).min(balance_left)`. The extractor bound it to the claim `Refund.C_63721259….Correct` (candidate source sha256 `63721259eb182e5e0c4c97d1d21c898759b05f3d91819379c6251573ce4c426f`). This is the expression of upstream's fix (the `repair` candidate of this repository). The model then called `write_solution` with

      import RefundCase

      namespace Solution

      theorem proof : Refund.C_63721259eb182e5e0c4c97d1d21c898759b05f3d91819379c6251573ce4c426f.Correct := by
        intro a _
        constructor
        · exact Nat.le_trans (Refund.min_le_first _ _) (Refund.min_le_first _ _)
        · constructor
          · exact Nat.le_trans (Refund.min_le_first _ _) (Refund.min_le_second _ _)
          · constructor
            · exact Refund.min_le_second _ _
            · cases Nat.le_total (min a.requested a.deposited) a.balance with
              | inl hmn =>
                have hmn_eq : min (min a.requested a.deposited) a.balance = min a.requested a.deposited :=
                  Nat.min_eq_left hmn
                cases Nat.le_total a.requested a.deposited with
                | inl hrd =>
                  have hmn_eq_R : min a.requested a.deposited = a.requested := Nat.min_eq_left hrd
                  left
                  change (min (min a.requested a.deposited) a.balance = a.requested)
                  rw [hmn_eq, hmn_eq_R]
                | inr hDR =>
                  have hmn_eq_D : min a.requested a.deposited = a.deposited := Refund.min_right hDR
                  right
                  left
                  change (min (min a.requested a.deposited) a.balance = a.deposited)
                  rw [hmn_eq, hmn_eq_D]
              | inr hBmn =>
                have hB_eq : min (min a.requested a.deposited) a.balance = a.balance := Refund.min_right hBmn
                right
                right
                change (min (min a.requested a.deposited) a.balance = a.balance)
                rw [hB_eq]

      end Solution

  Accepted. Lean 4.35.0 elaborated it. The exported proof file (16,663 bytes) declares no axiom. A native build of nanoda type-checked the sealed environment plus the proof. The model's proof is axiom-free: Lean reports that `Solution.proof` does not depend on any axioms.
- Complete job (started 2026-11-13T18:28:21Z, 172 s, near-sandbox 2.14.0, protocol 88): 14 of 14 checks passed. The job elaborated the saved `Solution.lean` and exported it again, because the sealed environment that `prepare.py` generates changed after the model's round. The job has 16,663 proof bytes against environment `19df256217ece38d…`. The round had 16,663 bytes against `9463928eb2d59fdb…`. The Lean text is the model's, unchanged.

  The certificate of the kernel contract proves `Refund.C_63721259….Correct` and lists these axioms: none. The receipt of the kernel contract burnt 161.9 TGas (173.2 TGas for all receipts of that transaction). The bounty phase is Paid, and the winner is `prover.test.near`. Installed: yes, wasm `f24d072edcb76a81…`, byte for byte `artifacts/refund/fixed.wasm`. The same account answered `100` before and `1` after.
- `RefundCase.lean` as the model saw it, compared with the file that `prepare.py` generates for this candidate now: the same declarations, other comments.

      shown: (r = a.requested ∨ r = a.deposited ∨ r = a.balance)  -- and it is one of the three, so never less than they allow
      now:   (r = a.requested ∨ r = a.deposited ∨ r = a.balance)  -- and never less than the three allow

### `glm-5.3-flash-2`: `z-ai/glm-5.3-flash`

The run started at 2026-11-12T09:55:12Z. It made 3 requests and took 2027.5 s from the first request to its end. The cost was USD 0.0097 at the list price of USD 0.08 / 0.50 per million tokens in / out. Result: stopped at the time limit of 1800 s. 2 of its replies ended at the token limit before any tool call, and the loop asked the model to go on. 1 of its requests got no response.

- The model proposed `balance_left.min(requested_refund).min(*deposited)`, and the extractor bound it to a claim. The run ended before the checker got a proof of it to judge.

### `deepseek-v4.1-flash-noaxioms`: `deepseek-ai/DeepSeek-V4.1-Flash-1017`

The run started at 2026-11-12T10:29:06Z. It made 2 requests and took 153.4 s from the first request to its end. The cost was USD 0.0085 at the list price of USD 0.30 / 1.20 per million tokens in / out. Result: accepted in round 1. This attempt asked for a proof with no axiom at all. The chain itself admits propext for a caller's patch.

- Round 1, expression `requested_refund.min(*deposited).min(balance_left)`. The extractor bound it to the claim `Refund.C_63721259….Correct` (candidate source sha256 `63721259eb182e5e0c4c97d1d21c898759b05f3d91819379c6251573ce4c426f`). This is the expression of upstream's fix (the `repair` candidate of this repository). The model then called `write_solution` with

      import RefundCase

      namespace Solution

      theorem min_pick (x y : Nat) : min x y = x ∨ min x y = y := by
        cases Nat.le_total x y with
        | inl h => exact Or.inl (Nat.min_eq_left h)
        | inr h => exact Or.inr (Refund.min_right h)

      theorem proof : Refund.C_63721259eb182e5e0c4c97d1d21c898759b05f3d91819379c6251573ce4c426f.Correct := by
        intro a _
        show Refund.Rule a (min (min a.requested a.deposited) a.balance)
        refine ⟨?_, ?_, ?_, ?_⟩
        · exact Nat.le_trans (Refund.min_le_first (min a.requested a.deposited) a.balance)
            (Refund.min_le_first a.requested a.deposited)
        · exact Nat.le_trans (Refund.min_le_first (min a.requested a.deposited) a.balance)
            (Refund.min_le_second a.requested a.deposited)
        · exact Refund.min_le_second (min a.requested a.deposited) a.balance
        · cases Nat.le_total (min a.requested a.deposited) a.balance with
          | inl h =>
            rw [Nat.min_eq_left h]
            cases min_pick a.requested a.deposited with
            | inl h2 => exact Or.inl h2
            | inr h2 => exact Or.inr (Or.inl h2)
          | inr h =>
            rw [Refund.min_right h]
            exact Or.inr (Or.inr rfl)

      end Solution

  Accepted. Lean 4.35.0 elaborated it. The exported proof file (14,189 bytes) declares no axiom. A native build of nanoda type-checked the sealed environment plus the proof. The model's proof is axiom-free: Lean reports that `Solution.proof` does not depend on any axioms.
- Complete job (started 2026-11-13T18:31:13Z, 173 s, near-sandbox 2.14.0, protocol 88): 14 of 14 checks passed. The job elaborated the saved `Solution.lean` and exported it again, because the sealed environment that `prepare.py` generates changed after the model's round. The job has 14,189 proof bytes against environment `19df256217ece38d…`. The round had 14,189 bytes against `9463928eb2d59fdb…`. The Lean text is the model's, unchanged.

  The certificate of the kernel contract proves `Refund.C_63721259….Correct` and lists these axioms: none. The receipt of the kernel contract burnt 159.9 TGas (170.9 TGas for all receipts of that transaction). The bounty phase is Paid, and the winner is `prover.test.near`. Installed: yes, wasm `f24d072edcb76a81…`, byte for byte `artifacts/refund/fixed.wasm`. The same account answered `100` before and `1` after.
- `RefundCase.lean` as the model saw it, compared with the file that `prepare.py` generates for this candidate now: the same declarations, other comments.

      shown: (r = a.requested ∨ r = a.deposited ∨ r = a.balance)  -- and it is one of the three, so never less than they allow
      now:   (r = a.requested ∨ r = a.deposited ∨ r = a.balance)  -- and never less than the three allow

### `glm-5.3-flash-3`: `z-ai/glm-5.3-flash`

The run started at 2026-11-12T10:37:12Z. It made 4 requests and took 1208.8 s from the first request to its end. The cost was USD 0.0097 at the list price of USD 0.08 / 0.50 per million tokens in / out. Result: accepted in round 2. 1 of its replies ended at the token limit before any tool call, and the loop asked the model to go on. 1 of its requests got no response.

- Round 1, expression `balance_left.min(requested_refund).min(*deposited)`. The extractor bound it to the claim `Refund.C_4f5f5c35….Correct` (candidate source sha256 `4f5f5c35f5d1a3f22f5ffed0dc884d8a714fb96209e52b585e71aea6a2dd94d6`). This is not the text of upstream's fix. The model then called `write_solution` with

      import RefundCase

      namespace Solution

      theorem proof : Refund.C_4f5f5c35f5d1a3f22f5ffed0dc884d8a714fb96209e52b585e71aea6a2dd94d6.Correct := by
        intro a _
        simp only [Refund.meetsRule, Refund.Rule] at *
        intro hr hd hb _
        exact ⟨le_min (le_min hb hr) hd,
          Nat.min_eq_right (le_min hb hr) |>.trans
            (Nat.min_eq_right hr |>.trans ⟨⟩)
          ▸ trivial⟩

      end Solution

  Rejected: error: Solution.lean:8:8: Tactic `introN` failed: There are no additional binders or `let` bindings in the goal to introduce
- Round 2, expression `balance_left.min(requested_refund).min(*deposited)`. The extractor bound it to the claim `Refund.C_4f5f5c35….Correct` (candidate source sha256 `4f5f5c35f5d1a3f22f5ffed0dc884d8a714fb96209e52b585e71aea6a2dd94d6`). This is not the text of upstream's fix. The model then called `write_solution` with

      import RefundCase

      namespace Solution

      theorem eval_eq (a : Refund.Args) :
          Refund.eval a
              Refund.C_4f5f5c35f5d1a3f22f5ffed0dc884d8a714fb96209e52b585e71aea6a2dd94d6.expression
            = min (min a.balance a.requested) a.deposited := rfl

      theorem proof : Refund.C_4f5f5c35f5d1a3f22f5ffed0dc884d8a714fb96209e52b585e71aea6a2dd94d6.Correct := by
        intro a _
        unfold Refund.Rule
        rw [eval_eq a]
        refine ⟨?_, ?_, ?_, ?_⟩
        · exact Nat.le_trans (Nat.min_le_left (min a.balance a.requested) a.deposited)
            (Nat.min_le_right a.balance a.requested)
        · exact Nat.min_le_right (min a.balance a.requested) a.deposited
        · exact Nat.le_trans (Nat.min_le_left (min a.balance a.requested) a.deposited)
            (Nat.min_le_left a.balance a.requested)
        · cases Nat.le_total (min a.balance a.requested) a.deposited with
          | inr h => exact Or.inr (Or.inl (Nat.min_eq_right h))
          | inl h =>
            cases Nat.le_total a.balance a.requested with
            | inl h2 => exact Or.inr (Or.inr ((Nat.min_eq_left h).trans (Nat.min_eq_left h2)))
            | inr h2 => exact Or.inl ((Nat.min_eq_left h).trans (Nat.min_eq_right h2))

      end Solution

  Accepted. Lean 4.35.0 elaborated it. The exported proof file (13,648 bytes) declares no axiom. A native build of nanoda type-checked the sealed environment plus the proof. The model's proof is not axiom-free: Lean reports that `Solution.proof` depends on propext.
- Complete job (started 2026-11-13T18:34:07Z, 171 s, near-sandbox 2.14.0, protocol 88): 14 of 14 checks passed. The job elaborated the saved `Solution.lean` and exported it again, because the sealed environment that `prepare.py` generates changed after the model's round. The job has 13,648 proof bytes against environment `e008339e88d5afa7…`. The round had 13,648 bytes against `41792b6b4a50a76a…`. The Lean text is the model's, unchanged.

  The certificate of the kernel contract proves `Refund.C_4f5f5c35….Correct` and lists these axioms: propext. The receipt of the kernel contract burnt 159.2 TGas (170.3 TGas for all receipts of that transaction). The bounty phase is Paid, and the winner is `prover.test.near`. Installed: yes, wasm `a18b6290ed78885a…`. The same account answered `100` before and `1` after.
- `RefundCase.lean` as the model saw it, compared with the file that `prepare.py` generates for this candidate now: the same text.

## Who checked what

- The model and the machine it ran on decide nothing. Their output is two texts: an expression and a Lean file.
- `cases/intents-refund/propose.py` and `prepare.py` are the extractor, which we trust. They refuse anything
  outside the expression language or outside the one patch site. They generate the claim for the sha256 of the
  candidate file.
- Lean 4.35.0 elaborates the model's file and `lean4export` exports it. `export.sh` refuses a proof file that
  declares an axiom.
- nanoda type-checks the export twice: as a native build in the model's loop, and as `artifacts/kernel.wasm` inside
  the kernel contract in the complete job. The board pays only on the contract's verdict. The gate installs only
  the registered wasm of a candidate whose claim has a certificate.

## Re-check

Offline, with no network and no API key:

    ./verify.sh --nearai

For each accepted attempt this runs `python3 -S tools/verify_nearai.py evidence/nearai-refund/<attempt>` and the
same with `--tamper`. It checks:

1. The attestation report and the signature on every response (checks 1 to 7 at the top of
   `tools/verify_nearai.py`).
2. `Solution.lean` is the last `write_solution` call in the signed responses. `candidate.rs` is the pinned upstream
   file, and only the expression of the `propose_patch` call differs. `prompt.md` is the first message of every
   signed request. `RefundCase.lean` is in a signed request.
3. The proof file declares no axiom. Its theorem states `Refund.C_<sha256 of candidate.rs>.Correct` and no other
   claim. A native build of nanoda, from the source of the kernel contract, type-checks the sealed environment
   plus the proof.
4. The recorded job is for these bytes. The certificate names this claim, the sha256 of `proof.ndjson` and of the
   sealed environment, and the axioms that Lean reported. The board paid. The installed wasm is the build of the
   source with the sha256 of `candidate.rs`. The answers are 100 before and 1 after. The kernel, board and gate
   binaries are the ones in `artifacts/`.
5. Each changed copy of the evidence fails. 13 copies change the attestation or the signatures. 8 more change the
   prompt, the candidate, the statement, the proof bytes, the sealed environment, the certificate or the installed
   wasm. Two of them change the certificate: its proof bytes and its axioms.
6. With Lean installed: `propose.py --prepare-only` and `export.sh` derive the claim again from `candidate.rs` and
   elaborate `Solution.lean` again. The sealed environment and the proof bytes must be the same bytes.
   `#print axioms` must give the recorded axioms. `RefundCase.lean` must be the text that the model saw, or the
   same Lean with other comments. The output says which of the two.

The complete job again on a fresh local node (it fetches the pinned upstream revision from GitHub and builds it):

    python3 cases/intents-refund/propose.py \
      --candidate evidence/nearai-refund/deepseek-v4.1-flash-2/candidate.rs \
      --proof evidence/nearai-refund/deepseek-v4.1-flash-2/Solution.lean \
      --side proof --out run-output/my-refund

A new attempt of your own (it needs a NEAR AI Cloud key and costs about what the table shows):

    export NEARAI_API_KEY=...  NEARAI_LEDGER=$PWD/run-output/my-spend.jsonl
    python3 -I agent/nearai_patch.py solve run-output/my-attempt --model deepseek-ai/DeepSeek-V4.1-Flash-1017
    python3 -I agent/nearai_patch.py job run-output/my-attempt
    python3 -S tools/verify_nearai.py run-output/my-attempt

The complete job again for every accepted attempt, with no model request, and this file again (for example after the
contract binaries changed):

    python3 -I agent/nearai_patch.py jobs

The loop itself against a local stand-in for the API, with scripted replies, no key and no network (it needs Lean):

    python3 agent/test_nearai_patch.py

All attempts again. This replaces this record, so commit the current one first. It needs the key:

    python3 -I agent/nearai_patch.py all --because "<why the attempts are replaced>"

## What this does not show

- The attestation shows which key signed a response: a key that an Intel TDX VM of NEAR AI's model service reported
  in its quote. It says nothing about whether the proof is correct. Lean, nanoda and the kernel contract decide
  that, and they do not look at the attestation. A signed wrong proof is still wrong.
- The script does not validate what needs a network service. That is Intel's TCB status, collateral freshness and
  revocation lists for the platform, and the NVIDIA GPU evidence. The script checks only that GPU evidence is
  present and carries the nonce.
- The script does not check these at all:
  - certificate validity dates
  - the identity of the quoting enclave
  - what the measured container images do
  - that the deployment named in the attested action log loads the weights that its name says
  - that the report and the completions came from the same VM

  The action log names: `prod/DeepSeek-V4.1-Flash-1017-vLLM-DEP8-Abliterated.yaml` for `deepseek-v4.1-flash-2`, `prod/small-models.yaml` for `qwen3.8-27b-2`, `prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V12Q8.yaml` for `glm-5.3-flash-2`, `prod/DeepSeek-V4.1-Flash-1017-vLLM-DEP8-Abliterated.yaml` for `deepseek-v4.1-flash-noaxioms`, `prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V12Q8.yaml` for `glm-5.3-flash-3`.
- The nonce and the times in `records.json` are the agent's own. To anyone else they show consistency, not
  freshness. The agent fetched the report before the first completion. The check of the report ran afterwards.
- The record has no testnet or mainnet transaction. `prover.test.near` is an account that the job's script created
  on the local node. That script signed and sent the transactions with the model's proof bytes. The model signed
  nothing.
- The model did not find the bug. The prompt told it the observation and the rule, and the pinned file carries
  upstream's comment about the missing cap. Upstream knows the issue and fixed it.
- The claim is about one expression at one site of one pinned file, in a language of `min`, three inputs and
  literals. It is not a proof of the Intents contract. We trust the extractor, the Rust compiler and the
  registration of a wasm for a source, as `docs/TECHNICAL.md` says.
- 5 attempts with 3 models are not a success rate. A new attempt can propose another expression or fail.
- The loop sent a model back 2 times: `qwen3.8-27b-2` round 1 (proof rejected), `glm-5.3-flash-3` round 1 (proof rejected). No refused patch occurred. No refuted patch occurred. `agent/test_nearai_patch.py` exercises a refuted patch and a rejected proof against a local stand-in for the API. `cases/intents-refund/test_prepare.py` exercises the extractor's refusals.
- Lean elaborated each model's file on the local machine, behind a text filter that refuses `#eval`, `initialize`,
  `run_cmd`, `IO` and similar. That filter is not a sandbox.
- The checks of the recorded job (item 4 above) compare records that this repository wrote itself. They do not run
  a chain. The complete job runs one.

## Files

- `attempts.json`: every attempt as data. `spend.jsonl`: every request with its tokens and list-price cost.
  `billed.json`: what NEAR AI billed per request.
- `<attempt>/prompt.md`: the prompt. `<attempt>/nearai/NNNN.{request,response,signature}.json`: exact request and
  response bytes and NEAR AI's signature. `nearai/attestation.json`, `records.json`, `verification.json`: the report
  fetched before the run, the nonce and hashes, the result of the offline check. `transcript.jsonl`: assistant
  messages and tool results.
- `<attempt>/candidate.rs`: the upstream file with the model's expression. `RefundCase.lean`: the claim generated
  for it, as the model saw it. `Solution.lean`: the model's proof. `proof.ndjson`: its export, the bytes the kernel
  checked. `base.ndjson.gz`: the sealed environment of that candidate.
- `<attempt>/report.json`: the model run and the job. For the run it has the rounds with every proof text, the
  tokens, the cost and the time. For the job it has the command, the wall time, and the sha256 of the kernel, board
  and gate binaries. `result.json`: the result of `propose.py`. `upgrade.json`: the job's transactions without
  their arguments.
- `upgrade-full.json.gz` has the transactions of a job with their arguments. It is about 2.5 MB, most of it the
  two wasm binaries that the job staged. The repository keeps it for no attempt. `result.json` has its sha256 for
  every job, and `python3 -I agent/nearai_patch.py job <attempt> --trace` writes it again.

`attestation.json` contains NEAR AI's measured container configuration, which mentions an `Authorization` header
with a placeholder. The record stores no key of ours: it keeps requests as bodies only.
