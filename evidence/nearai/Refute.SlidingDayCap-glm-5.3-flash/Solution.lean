import Policy.Bounties

namespace Solution

open Wallet

/- Counterexample to `Wallet.Claim.SlidingDayCap`.
`dayLength = 4`, `perDayCap = 1`, initial window anchored at `dayStart = 0`.
One allowed payment of 1 at time `2`: the window `[0,4)` has not expired
(`4 ≤ 2-0` is false), so no roll. Next payment of 1 at time `4`: the window
`[0,4)` has now expired (`4 ≤ 4-0`), so the state resets to
`spentToday = 0`, `dayStart = 4`, and the payment is allowed again.
Both timestamps lie in the stretch `[1,5)` of length `4 = dayLength` (not
strictly shorter, so the hypothesis only asks `r.1 - 1 < 4`, which holds),
and they fall into two *different anchored windows* — the daily cap is not
a sliding cap. Allowed sum `1 + 1 = 2 > perDayCap.toNat = 1`. -/
def pC : Policy :=
  { budgetTotal := 10, perTxCap := 10, perDayCap := 1, dayLength := 4, allowed := [[0]] }

def sC : State :=
  { spentTotal := 0, spentToday := 0, dayStart := 0, nonce := 0 }

def reqsC : List Req := [(2, [0], 1), (4, [0], 1)]

theorem proof : Wallet.Claim.Refute.SlidingDayCap := by
  intro h
  have h1 : sC.spentToday ≤ pC.perDayCap := by decide
  have h2 : ∀ r ∈ reqsC, (1 : UInt64) ≤ r.1 ∧ r.1 - 1 < pC.dayLength := by
    intro r hr
    cases hr with
    | head => exact ⟨by decide, by decide⟩
    | tail _ hr' =>
      cases hr' with
      | head => exact ⟨by decide, by decide⟩
      | tail _ hr'' => cases hr''
  have hc : allowedSum reqsC (run pC sC reqsC).2 ≤ pC.perDayCap.toNat :=
    h pC sC reqsC 1 h1 h2
  have hrun : (run pC sC reqsC).2 = [Verdict.allow, Verdict.allow] := rfl
  rw [hrun] at hc
  exact Nat.not_succ_le_self 1 hc

end Solution
