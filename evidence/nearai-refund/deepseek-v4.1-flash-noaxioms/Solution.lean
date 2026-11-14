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
