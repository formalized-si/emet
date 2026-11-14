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