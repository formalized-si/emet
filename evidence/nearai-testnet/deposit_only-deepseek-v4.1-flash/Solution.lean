import RefundCase

namespace Solution

/-- The claim fails: with `requested = 2`, `deposited = 3`, `balance = 1`,
the expression evaluates to `min 2 3 = 2`, more than the balance left on the receiver. -/
theorem proof : Refund.C_31fecb00c80d90f28032c8918c20cbc10ce18781f1463ef9633e028af599e149.Refute :=
  fun h =>
    Nat.not_le_of_gt (m := 1) (n := Nat.min 2 3) (by decide)
      (h ⟨2, 3, 1⟩ ⟨by decide, by decide, by decide⟩).2.2.1

end Solution
