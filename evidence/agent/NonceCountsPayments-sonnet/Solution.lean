import Policy.Bounties
open Wallet

namespace Solution

theorem step_nonce (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64)
    (v : Verdict) (s' : State) (h : step p s now to amount = (v, s')) :
    (v = .allow ∧ s'.nonce.toNat = s.nonce.toNat + 1) ∨ (s' = s ∧ v ≠ .allow) := by
  unfold step at h
  split at h
  · split at h
    · cases h; exact Or.inr ⟨rfl, fun h => Verdict.noConfusion h⟩
    · dsimp only at h
      split at h
      · cases h; exact Or.inr ⟨rfl, fun h => Verdict.noConfusion h⟩
      · split at h
        · cases h; exact Or.inr ⟨rfl, fun h => Verdict.noConfusion h⟩
        · split at h
          · cases h; exact Or.inr ⟨rfl, fun h => Verdict.noConfusion h⟩
          · cases h
            rename_i hn _ _
            refine Or.inl ⟨rfl, ?_⟩
            have hr : (rollDay p s now).nonce = s.nonce := by
              unfold rollDay
              split <;> rfl
            show ((rollDay p s now).nonce + 1).toNat = _
            rw [hr] at hn ⊢
            have hne : s.nonce ≠ U64MAX := by
              intro hc
              apply hn
              rw [decide_eq_true hc]
              generalize decide (U64MAX - (rollDay p s now).spentTotal < amount) = a
              generalize decide (U64MAX - (rollDay p s now).spentToday < amount) = b
              cases a <;> cases b <;> rfl
            rw [UInt64.toNat_add]
            have h1 : (1 : UInt64).toNat = 1 := rfl
            rw [h1]
            apply Nat.mod_eq_of_lt
            have hl := UInt64.toNat_lt s.nonce
            cases Nat.lt_or_ge (s.nonce.toNat + 1) (2^64) with
            | inl h => exact h
            | inr h =>
              exfalso
              apply hne
              have h2 : U64MAX.toNat = 18446744073709551615 := rfl
              exact UInt64.le_antisymm (UInt64.le_iff_toNat_le.mpr (by rw [h2]; exact Nat.le_of_lt_succ hl)) (UInt64.le_iff_toNat_le.mpr (by rw [h2]; exact Nat.le_of_succ_le_succ h))
  · cases h; exact Or.inr ⟨rfl, fun h => Verdict.noConfusion h⟩

theorem proof : Wallet.Claim.NonceCountsPayments := by
  intro p s reqs
  induction reqs generalizing s with
  | nil => rfl
  | cons r rest ih =>
    obtain ⟨now, to, amount⟩ := r
    cases e : step p s now to amount with
    | mk v s' =>
      have hs := step_nonce p s now to amount v s' e
      have ih2 := ih s'
      unfold run
      rw [e]
      dsimp only
      cases e2 : run p s' rest with
      | mk sf vs =>
        rw [e2] at ih2
        dsimp only at ih2 ⊢
        cases v with
        | allow =>
          cases hs with
          | inl h =>
            show sf.nonce.toNat = s.nonce.toNat + ((acceptedReqs rest vs).length + 1)
            rw [ih2, h.2, Nat.add_assoc, Nat.add_comm 1]
          | inr h => exact absurd rfl h.2
        | denyBudget =>
          cases hs with
          | inl h => exact Verdict.noConfusion h.1
          | inr h => cases h.1; exact ih2
        | denyPerTx =>
          cases hs with
          | inl h => exact Verdict.noConfusion h.1
          | inr h => cases h.1; exact ih2
        | denyDaily =>
          cases hs with
          | inl h => exact Verdict.noConfusion h.1
          | inr h => cases h.1; exact ih2
        | denyReceiver =>
          cases hs with
          | inl h => exact Verdict.noConfusion h.1
          | inr h => cases h.1; exact ih2
        | denyOverflow =>
          cases hs with
          | inl h => exact Verdict.noConfusion h.1
          | inr h => cases h.1; exact ih2

end Solution
