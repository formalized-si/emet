import Policy.Bounties
open Wallet

namespace Solution

def pC : Policy := { budgetTotal := 2, perTxCap := 1, perDayCap := 1, dayLength := 10, allowed := [[1]] }
def sC : State := { spentTotal := 0, spentToday := 0, dayStart := 0, nonce := 0 }
def accC : Account := [1]
def reqsC : List Req := [(9, accC, 1), (10, accC, 1)]
def t0C : UInt64 := 1

theorem proof : Wallet.Claim.Refute.SlidingDayCap := by
  intro H
  have hpre : sC.spentToday ≤ pC.perDayCap := by decide
  have hrange : ∀ r ∈ reqsC, t0C ≤ r.1 ∧ r.1 - t0C < pC.dayLength := by
    intro r hr
    cases hr
    case head => exact ⟨by decide, by decide⟩
    case tail hr2 =>
      cases hr2
      case head => exact ⟨by decide, by decide⟩
      case tail hr3 => cases hr3
  have h := H pC sC reqsC t0C hpre hrange
  have hsum : allowedSum reqsC (run pC sC reqsC).2 = 2 := by decide
  have hcap : pC.perDayCap.toNat = 1 := by decide
  rw [hsum, hcap] at h
  have hnot : ¬ (2 : Nat) ≤ 1 := by decide
  exact hnot h

end Solution
