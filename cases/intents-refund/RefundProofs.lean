import RefundCase
set_option linter.unusedSimpArgs false
namespace Refund
theorem original : C_72245952a41246be823dfbe992b2ff76be05461008b4257b6ad0cb20954fc37e.Refute := by
  intro h
  have valid : InRange ⟨100, 1, 1001⟩ := by unfold InRange; decide
  have bad : Rule ⟨100, 1, 1001⟩ (eval ⟨100, 1, 1001⟩ C_72245952a41246be823dfbe992b2ff76be05461008b4257b6ad0cb20954fc37e.expression) := h ⟨100, 1, 1001⟩ valid
  revert bad
  unfold Rule
  decide
theorem deposit_only : C_31fecb00c80d90f28032c8918c20cbc10ce18781f1463ef9633e028af599e149.Refute := by
  intro h
  have valid : InRange ⟨1, 1, 0⟩ := by unfold InRange; decide
  have bad : Rule ⟨1, 1, 0⟩ (eval ⟨1, 1, 0⟩ C_31fecb00c80d90f28032c8918c20cbc10ce18781f1463ef9633e028af599e149.expression) := h ⟨1, 1, 0⟩ valid
  revert bad
  unfold Rule
  decide
theorem ignore_request : C_6641e563c26dbb57124c0650e7346e620d729c48e6efca343c9a7fea8316a0da.Refute := by
  intro h
  have valid : InRange ⟨1, 2, 2⟩ := by unfold InRange; decide
  have bad : Rule ⟨1, 2, 2⟩ (eval ⟨1, 2, 2⟩ C_6641e563c26dbb57124c0650e7346e620d729c48e6efca343c9a7fea8316a0da.expression) := h ⟨1, 2, 2⟩ valid
  revert bad
  unfold Rule
  decide
theorem zero_refund : C_c196307c0e68c8b8632bad817235cd14d544cb0ac666a64e28979ebb1e50b878.Refute := by
  intro h
  have valid : InRange ⟨100, 1, 1001⟩ := by unfold InRange; decide
  have bad : Rule ⟨100, 1, 1001⟩ (eval ⟨100, 1, 1001⟩ C_c196307c0e68c8b8632bad817235cd14d544cb0ac666a64e28979ebb1e50b878.expression) := h ⟨100, 1, 1001⟩ valid
  revert bad
  unfold Rule
  decide
theorem repair : C_9ceacc45c79c529b7c5176cb562c983378487348c42bcd1dfbd8c90c42d77bb1.Correct := by
  intro a h
  have e : eval a C_9ceacc45c79c529b7c5176cb562c983378487348c42bcd1dfbd8c90c42d77bb1.expression = min (min a.requested a.deposited) a.balance := by
    rfl
  unfold Rule
  rw [e]
  refine ⟨Nat.le_trans (min_le_first _ _) (min_le_first _ _), Nat.le_trans (min_le_first _ _) (min_le_second _ _), min_le_second _ _, ?_⟩
  cases Nat.le_total (min a.requested a.deposited) a.balance with
  | inl h1 =>
    rw [Nat.min_eq_left h1]
    cases Nat.le_total a.requested a.deposited with
    | inl h2 => exact Or.inl (Nat.min_eq_left h2)
    | inr h2 => exact Or.inr (Or.inl (min_right h2))
  | inr h1 => exact Or.inr (Or.inr (min_right h1))
end Refund
