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
