import RefundCase
/-!
# The log budget of a refund

On deposit upstream writes an `mt_mint` event and fails the deposit unless that event, with the refund memo in
place of its own, fits in one log message (16,384 bytes). On refund it writes an `mt_burn` event with, for each
token whose refund is not zero, the token id and the refund amount, and does not check its size: "the refund
memo size was already accounted for in the original mint". That holds if no refund amount is longer, as a
decimal string, than the amount deposited.

This file models the part of the two events that varies, the two JSON lists `token_ids` and `amounts`, and
proves that an expression that meets the rule never makes the lists of the refund event longer than those of
the deposit event. The old expression does. The check made on deposit (`check_refund`) is upstream's code and
is not modelled here.
-/
namespace Refund

/-- How many of 10, 100, …, 10^k are not above `n`. -/
def powersOfTenUpTo (n : Nat) : Nat → Nat
  | 0 => 0
  | k + 1 => powersOfTenUpTo n k + (if 10 ^ (k + 1) ≤ n then 1 else 0)

/-- Decimal length of a u128 amount: 1 for 0 to 9, 2 for 10 to 99, and so on up to 39. -/
def digits (n : Nat) : Nat := 1 + powersOfTenUpTo n 38

/-- One token of a batch: the length of its id as written in an event, and the three inputs of its refund. -/
structure Item where
  idLen : Nat
  inputs : Args

/-- The amount the expression `e` returns for one token. -/
def refundOf (e : Expr) (x : Item) : Nat := eval x.inputs e

/-- Bytes one token adds to an event: `"<id>",` in the list `token_ids` and `"<amount>",` in the list `amounts`. -/
def entryBytes (idLen amount : Nat) : Nat := (idLen + 3) + (digits amount + 3)

/-- The two lists of the deposit event (`mt_mint`): every token of the batch, with the amount deposited. -/
def mintBytes : List Item → Nat
  | [] => 0
  | x :: rest => entryBytes x.idLen x.inputs.deposited + mintBytes rest

/-- The two lists of the refund event (`mt_burn`): the tokens whose refund is not zero, with the amount refunded. -/
def burnBytes (e : Expr) : List Item → Nat
  | [] => 0
  | x :: rest =>
    if refundOf e x = 0 then burnBytes e rest
    else entryBytes x.idLen (refundOf e x) + burnBytes e rest

theorem powersOfTenUpTo_mono {m n : Nat} (h : m ≤ n) : ∀ k, powersOfTenUpTo m k ≤ powersOfTenUpTo n k
  | 0 => Nat.le_refl 0
  | k + 1 => by
    show powersOfTenUpTo m k + (if 10 ^ (k + 1) ≤ m then 1 else 0)
       ≤ powersOfTenUpTo n k + (if 10 ^ (k + 1) ≤ n then 1 else 0)
    apply Nat.add_le_add (powersOfTenUpTo_mono h k)
    cases Nat.lt_or_ge m (10 ^ (k + 1)) with
    | inl hm => rw [ite_eq_right (Nat.not_le_of_gt hm)]; exact Nat.zero_le _
    | inr hm => rw [ite_eq_left hm, ite_eq_left (Nat.le_trans hm h)]; exact Nat.le_refl 1

/-- A larger amount is not shorter. -/
theorem digits_mono {m n : Nat} (h : m ≤ n) : digits m ≤ digits n :=
  Nat.add_le_add_left (powersOfTenUpTo_mono h 38) 1

/-- If no token's refund is above its deposit, the lists of the refund event are not longer than those of the
deposit event. -/
theorem capped_refund_event_fits (e : Expr) :
    ∀ xs : List Item, (∀ x ∈ xs, refundOf e x ≤ x.inputs.deposited) → burnBytes e xs ≤ mintBytes xs
  | [], _ => Nat.le_refl 0
  | x :: rest, h => by
    have ih : burnBytes e rest ≤ mintBytes rest :=
      capped_refund_event_fits e rest (fun y hy => h y (List.Mem.tail x hy))
    show (if refundOf e x = 0 then burnBytes e rest else entryBytes x.idLen (refundOf e x) + burnBytes e rest)
       ≤ entryBytes x.idLen x.inputs.deposited + mintBytes rest
    cases Nat.decEq (refundOf e x) 0 with
    | isTrue hz => rw [ite_eq_left hz]; exact Nat.le_trans ih (Nat.le_add_left _ _)
    | isFalse hz =>
      rw [ite_eq_right hz]
      exact Nat.add_le_add (Nat.add_le_add_left (Nat.add_le_add_right (digits_mono (h x (List.Mem.head rest))) 3) _) ih

/-- The log budget. For any expression that meets the rule and any batch of tokens, whatever the id and the
three inputs of each token are, the lists of the refund event are not longer than those of the deposit event.
The proof uses line 2 of the rule only (`r ≤ a.deposited`), and `digits_mono`. -/
theorem refund_event_fits (e : Expr) (h : meetsRule e) (xs : List Item)
    (hx : ∀ x ∈ xs, InRange x.inputs) : burnBytes e xs ≤ mintBytes xs :=
  capped_refund_event_fits e xs (fun x hxs => (h x.inputs (hx x hxs)).2.1)

/-- Upstream's old expression, `balance_left.min(requested_refund)`, named by the digest of the file it is in. -/
local notation "oldExpression" => C_72245952a41246be823dfbe992b2ff76be05461008b4257b6ad0cb20954fc37e.expression

/-- The old expression has no such bound. One token of upstream's own regression batch: an id of 173 bytes, a
deposit of 1, and a receiver that holds 10^37 + 80 and asks for 10^35 back. The refund event carries 36 digits
where the deposit event carried one. -/
theorem old_refund_event_can_outgrow :
    ∃ xs : List Item, (∀ x ∈ xs, InRange x.inputs) ∧ mintBytes xs < burnBytes oldExpression xs :=
  ⟨[{ idLen := 173, inputs := { requested := 10 ^ 35, deposited := 1, balance := 10 ^ 37 + 80 } }],
   (fun x hx => by
     cases hx with
     | head => exact (by decide : (10 : Nat) ^ 35 ≤ maxU128 ∧ (1 : Nat) ≤ maxU128 ∧ (10 : Nat) ^ 37 + 80 ≤ maxU128)
     | tail _ h => cases h),
   by decide⟩

end Refund
