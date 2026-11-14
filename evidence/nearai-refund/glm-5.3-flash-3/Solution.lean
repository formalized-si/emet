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