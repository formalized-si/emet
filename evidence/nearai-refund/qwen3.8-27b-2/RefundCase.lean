import Init
namespace Refund
inductive Expr where
  | requested | deposited | balance | literal (n : Nat) | least (a b : Expr)
structure Args where
  requested : Nat
  deposited : Nat
  balance : Nat
def eval (a : Args) : Expr → Nat
  | .requested => a.requested
  | .deposited => a.deposited
  | .balance => a.balance
  | .literal n => n
  | .least x y => min (eval a x) (eval a y)
def maxU128 : Nat := 340282366920938463463374607431768211455
def InRange (a : Args) : Prop := a.requested ≤ maxU128 ∧ a.deposited ≤ maxU128 ∧ a.balance ≤ maxU128
/-- The refund rule for one deposit: `r` is the amount returned. -/
def Rule (a : Args) (r : Nat) : Prop :=
  r ≤ a.requested ∧  -- never more than the receiver asked to return
  r ≤ a.deposited ∧  -- upstream's comment: "refunds are capped by deposited amounts"
  r ≤ a.balance ∧    -- "and balance left on the receiver"
  (r = a.requested ∨ r = a.deposited ∨ r = a.balance)  -- and it is one of the three, so never less than they allow
def meetsRule (e : Expr) : Prop := ∀ a : Args, InRange a → Rule a (eval a e)
theorem min_right {x y : Nat} (h : y ≤ x) : min x y = y := by
  cases Nat.le_total x y with
  | inl hxy => exact (Nat.min_eq_left hxy).trans (Nat.le_antisymm hxy h)
  | inr _ =>
    rw [Nat.min_def]
    cases Nat.lt_or_ge y x with
    | inl hlt => exact ite_eq_right (Nat.not_le_of_gt hlt)
    | inr hge => exact (ite_eq_left hge).trans (Nat.le_antisymm hge h)
theorem min_le_first (x y : Nat) : min x y ≤ x := by
  cases Nat.le_total x y with
  | inl h => rw [Nat.min_eq_left h]; exact Nat.le_refl x
  | inr h => rw [min_right h]; exact h
theorem min_le_second (x y : Nat) : min x y ≤ y := by
  cases Nat.le_total x y with
  | inl h => rw [Nat.min_eq_left h]; exact h
  | inr h => rw [min_right h]; exact Nat.le_refl y
theorem min_repeat (x y : Nat) : min x (min x y) = min x y := by rw [← Nat.min_assoc, Nat.min_self]
namespace C_72245952a41246be823dfbe992b2ff76be05461008b4257b6ad0cb20954fc37e
def sourceDigest : String := "72245952a41246be823dfbe992b2ff76be05461008b4257b6ad0cb20954fc37e"
def expression : Expr := (.least .balance .requested)
def Correct : Prop := meetsRule expression
def Refute : Prop := ¬ Correct
end C_72245952a41246be823dfbe992b2ff76be05461008b4257b6ad0cb20954fc37e
namespace C_63721259eb182e5e0c4c97d1d21c898759b05f3d91819379c6251573ce4c426f
def sourceDigest : String := "63721259eb182e5e0c4c97d1d21c898759b05f3d91819379c6251573ce4c426f"
def expression : Expr := (.least (.least .requested .deposited) .balance)
def Correct : Prop := meetsRule expression
def Refute : Prop := ¬ Correct
end C_63721259eb182e5e0c4c97d1d21c898759b05f3d91819379c6251573ce4c426f
end Refund
