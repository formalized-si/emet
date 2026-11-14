import Policy.Spec
/-!
# Policy.SmallProofs — small-closure proofs of the `Spec` claims

Independent of `Policy.Proofs`: no `omega`, no `simp` lemma sets, only `split`,
`rfl`, structural induction and direct applications of core lemmas. The point is
the size of the exported proof closure (what an on-chain kernel must check).
-/
namespace Wallet.Small
open Wallet

/-! ## Allowlist membership, by hand -/

theorem accEq_eq : ∀ (a b : Account), accEq a b = true → a = b
  | [], [], _ => rfl
  | [], _ :: _, h => (Bool.false_ne_true h).elim
  | _ :: _, [], h => (Bool.false_ne_true h).elim
  | x :: xs, y :: ys, h => by
    have h' := (Bool.and_eq_true _ _).mp h
    rw [of_decide_eq_true h'.1, accEq_eq xs ys h'.2]

theorem accEq_refl : ∀ (a : Account), accEq a a = true
  | [] => rfl
  | x :: xs => by
    show (decide (x = x) && accEq xs xs) = true
    rw [decide_eq_true rfl, accEq_refl xs]
    rfl

theorem mem_of_isAllowed (to : Account) : ∀ (l : List Account), isAllowed to l = true → to ∈ l
  | [], h => (Bool.false_ne_true h).elim
  | a :: as, h => by
    cases (Bool.or_eq_true_iff).mp h with
    | inl h1 => rw [accEq_eq a to h1]; exact List.Mem.head _
    | inr h2 => exact List.Mem.tail _ (mem_of_isAllowed to as h2)

theorem isAllowed_of_mem (to : Account) : ∀ (l : List Account), to ∈ l → isAllowed to l = true
  | _ :: _, .head _ => by
    show (accEq to to || _) = true
    rw [accEq_refl]; rfl
  | a :: as, .tail _ h => by
    show (accEq a to || isAllowed to as) = true
    rw [isAllowed_of_mem to as h, Bool.or_true]

theorem isAllowed_of_subset : ∀ (l l' : List Account), subsetB l l' = true →
    ∀ (x : Account), isAllowed x l = true → isAllowed x l' = true
  | [], _, _, _, h => (Bool.false_ne_true h).elim
  | a :: as, l', hs, x, hx => by
    have hs' := (Bool.and_eq_true _ _).mp hs
    cases (Bool.or_eq_true_iff).mp hx with
    | inl h1 => rw [← accEq_eq a x h1]; exact hs'.1
    | inr h2 => exact isAllowed_of_subset as l' hs'.2 x h2

/-! ## The shape of `step` -/

/-- The overflow guard of `step`, as written there. -/
def OvfGuard (r : State) (amount : UInt64) : Prop :=
  (decide (U64MAX - r.spentTotal < amount) || decide (U64MAX - r.spentToday < amount) ||
    decide (r.nonce = U64MAX)) = true

/-- The state `step` writes on allow. -/
def newState (r : State) (amount : UInt64) : State :=
  { r with spentTotal := r.spentTotal + amount, spentToday := r.spentToday + amount,
           nonce := r.nonce + 1 }

/-- Every `step` either returns the input state with a non-allow verdict, or allows
with all its guards passed and writes `newState`. -/
theorem step_shape (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64) :
    ((step p s now to amount).1 ≠ .allow ∧ (step p s now to amount).2 = s) ∨
    ((step p s now to amount).1 = .allow ∧ isAllowed to p.allowed = true ∧
      ¬ p.perTxCap < amount ∧ ¬ OvfGuard (rollDay p s now) amount ∧
      ¬ p.budgetTotal < (rollDay p s now).spentTotal + amount ∧
      ¬ p.perDayCap < (rollDay p s now).spentToday + amount ∧
      (step p s now to amount).2 = newState (rollDay p s now) amount) := by
  unfold step
  dsimp only
  split
  · rename_i hA
    split
    · exact Or.inl ⟨nofun, rfl⟩
    · rename_i hT
      split
      · exact Or.inl ⟨nofun, rfl⟩
      · rename_i hO
        split
        · exact Or.inl ⟨nofun, rfl⟩
        · rename_i hB
          split
          · exact Or.inl ⟨nofun, rfl⟩
          · rename_i hD
            exact Or.inr ⟨rfl, hA, hT, hO, hB, hD, rfl⟩
  · exact Or.inl ⟨nofun, rfl⟩

/-- Conversely, when every guard passes, `step` allows and writes `newState`. -/
theorem step_of_guards (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64)
    (hA : isAllowed to p.allowed = true) (hT : ¬ p.perTxCap < amount)
    (hO : ¬ OvfGuard (rollDay p s now) amount)
    (hB : ¬ p.budgetTotal < (rollDay p s now).spentTotal + amount)
    (hD : ¬ p.perDayCap < (rollDay p s now).spentToday + amount) :
    step p s now to amount = (.allow, newState (rollDay p s now) amount) := by
  unfold step OvfGuard at *
  dsimp only
  rw [ite_eq_left hA, ite_eq_right hT, ite_eq_right hO, ite_eq_right hB, ite_eq_right hD]
  rfl

theorem run_cons (p : Policy) (s : State) (now : UInt64) (to : Account) (a : UInt64)
    (rs : List Req) :
    (run p s ((now, to, a) :: rs)).1 = (run p (step p s now to a).2 rs).1 := rfl

/-! ## Spec claims -/

theorem stepDenyPreserves : Spec.StepDenyPreserves := fun p s now to a h =>
  match step_shape p s now to a with
  | .inl ⟨_, hs⟩ => hs
  | .inr ⟨hv, _⟩ => absurd hv h

theorem stepAllowBounds : Spec.StepAllowBounds := fun p s s' now to a h =>
  match step_shape p s now to a with
  | .inl ⟨hv, _⟩ => absurd (by rw [h]) hv
  | .inr ⟨_, hA, hT, _, hB, hD, hs⟩ => by
    rw [h] at hs
    subst hs
    exact ⟨UInt64.not_lt.mp hB, UInt64.not_lt.mp hD, UInt64.not_lt.mp hT,
      mem_of_isAllowed to p.allowed hA⟩

theorem receiverGate : Spec.ReceiverGate := fun p s now to a hto => by
  unfold step
  dsimp only
  rw [ite_eq_right (fun h => hto (mem_of_isAllowed to p.allowed h))]

theorem step_budget (p : Policy) (s : State) (now : UInt64) (to : Account) (a : UInt64)
    (h : s.spentTotal ≤ p.budgetTotal) : (step p s now to a).2.spentTotal ≤ p.budgetTotal :=
  match step_shape p s now to a with
  | .inl ⟨_, hs⟩ => by rw [hs]; exact h
  | .inr ⟨_, _, _, _, hB, _, hs⟩ => by rw [hs]; exact UInt64.not_lt.mp hB

theorem budgetInvariant : Spec.BudgetInvariant := by
  intro p s reqs
  induction reqs generalizing s with
  | nil => exact id
  | cons r rs ih =>
    obtain ⟨now, to, a⟩ := r
    intro h
    rw [run_cons]
    exact ih _ (step_budget p s now to a h)

theorem step_daily (p : Policy) (s : State) (now : UInt64) (to : Account) (a : UInt64)
    (h : s.spentToday ≤ p.perDayCap) : (step p s now to a).2.spentToday ≤ p.perDayCap :=
  match step_shape p s now to a with
  | .inl ⟨_, hs⟩ => by rw [hs]; exact h
  | .inr ⟨_, _, _, _, _, hD, hs⟩ => by rw [hs]; exact UInt64.not_lt.mp hD

theorem dailyInvariant : Spec.DailyInvariant := by
  intro p s reqs
  induction reqs generalizing s with
  | nil => exact id
  | cons r rs ih =>
    obtain ⟨now, to, a⟩ := r
    intro h
    rw [run_cons]
    exact ih _ (step_daily p s now to a h)

theorem tightenSound : Spec.TightenSound := by
  intro p p' s now to a ht hv
  have h1 := (Bool.and_eq_true _ _).mp ht
  have h2 := (Bool.and_eq_true _ _).mp h1.1
  have h3 := (Bool.and_eq_true _ _).mp h2.1
  have h4 := (Bool.and_eq_true _ _).mp h3.1
  have hb : p'.budgetTotal ≤ p.budgetTotal := of_decide_eq_true h4.1
  have htx : p'.perTxCap ≤ p.perTxCap := of_decide_eq_true h4.2
  have hd : p'.perDayCap ≤ p.perDayCap := of_decide_eq_true h3.2
  have hl : p'.dayLength = p.dayLength := of_decide_eq_true h2.2
  have hroll : rollDay p s now = rollDay p' s now := by unfold rollDay; rw [hl]
  match step_shape p' s now to a with
  | .inl ⟨hv', _⟩ => exact absurd hv hv'
  | .inr ⟨_, hA, hT, hO, hB, hD, _⟩ =>
    have hA' := isAllowed_of_subset p'.allowed p.allowed h1.2 to hA
    have hT' : ¬ p.perTxCap < a := fun c => hT (UInt64.lt_of_le_of_lt htx c)
    have hB' : ¬ p.budgetTotal < (rollDay p s now).spentTotal + a := by
      rw [hroll]; exact fun c => hB (UInt64.lt_of_le_of_lt hb c)
    have hD' : ¬ p.perDayCap < (rollDay p s now).spentToday + a := by
      rw [hroll]; exact fun c => hD (UInt64.lt_of_le_of_lt hd c)
    have hO' : ¬ OvfGuard (rollDay p s now) a := by rw [hroll]; exact hO
    rw [step_of_guards p s now to a hA' hT' hO' hB' hD',
      step_of_guards p' s now to a hA hT hO hB hD, hroll]

/-! ## ℕ accounting without `omega` -/

theorem toNat_U64MAX : U64MAX.toNat = 18446744073709551615 := rfl

theorem toNat_le_max (x : UInt64) : x.toNat ≤ 18446744073709551615 :=
  Nat.le_of_lt_succ (UInt64.toNat_lt x)

/-- `(2^64-1) - x` never wraps. Proved from the unconditional `UInt64.toNat_sub`:
`UInt64.toNat_sub_of_le` would also do, but its Init proof uses `omega`
(4.4 MB of closure). -/
theorem toNat_max_sub (x : UInt64) : (U64MAX - x).toNat = 18446744073709551615 - x.toNat := by
  rw [UInt64.toNat_sub, toNat_U64MAX]
  have e1 : 2 ^ 64 - x.toNat = (18446744073709551615 - x.toNat) + 1 :=
    Nat.succ_sub (toNat_le_max x)
  have e2 : 1 + 18446744073709551615 = 2 ^ 64 := rfl
  rw [e1, Nat.add_assoc, e2, Nat.add_mod_right,
    Nat.mod_eq_of_lt (Nat.lt_of_le_of_lt (Nat.sub_le _ _) (by decide))]

/-- Passing the overflow guard means `x + a` fits in 64 bits. -/
theorem fits_of_guard (x a : UInt64) (h : ¬ U64MAX - x < a) : x.toNat + a.toNat < 2 ^ 64 := by
  have h1 : a.toNat ≤ (U64MAX - x).toNat := UInt64.le_iff_toNat_le.mp (UInt64.not_lt.mp h)
  rw [toNat_max_sub] at h1
  have h3 : a.toNat + x.toNat ≤ 18446744073709551615 := Nat.add_le_of_le_sub (toNat_le_max x) h1
  rw [Nat.add_comm] at h3
  exact Nat.lt_succ_of_le h3

theorem toNat_add_fits (x a : UInt64) (h : x.toNat + a.toNat < 2 ^ 64) :
    (x + a).toNat = x.toNat + a.toNat := by
  rw [UInt64.toNat_add, Nat.mod_eq_of_lt h]

theorem not_ovf_total (r : State) (a : UInt64) (h : ¬ OvfGuard r a) : ¬ U64MAX - r.spentTotal < a :=
  fun c => h (by unfold OvfGuard; rw [decide_eq_true c]; rfl)

theorem rollDay_spentTotal_eq (p : Policy) (s : State) (now : UInt64) :
    (rollDay p s now).spentTotal = s.spentTotal := by
  unfold rollDay; split <;> rfl

theorem noOverflow : Spec.NoOverflow := fun p s s' now to a h =>
  match step_shape p s now to a with
  | .inl ⟨hv, _⟩ => absurd (by rw [h]) hv
  | .inr ⟨_, _, _, hO, _, _, hs⟩ => by
    rw [h] at hs
    subst hs
    have hfit := fits_of_guard _ a (not_ovf_total _ a hO)
    rw [rollDay_spentTotal_eq] at hfit
    refine ⟨hfit, ?_⟩
    show ((rollDay p s now).spentTotal + a).toNat = _
    rw [rollDay_spentTotal_eq]
    exact toNat_add_fits _ _ hfit

theorem allowedSum_cons (now : UInt64) (to : Account) (a : UInt64) (rs : List Req)
    (v : Verdict) (vs : List Verdict) (hv : v ≠ .allow) :
    allowedSum ((now, to, a) :: rs) (v :: vs) = allowedSum rs vs := by
  cases v
  · exact absurd rfl hv
  all_goals rfl

theorem run_spentTotal (p : Policy) (s : State) (reqs : List Req) :
    (run p s reqs).1.spentTotal.toNat = s.spentTotal.toNat + allowedSum reqs (run p s reqs).2 := by
  induction reqs generalizing s with
  | nil => rfl
  | cons r rs ih =>
    obtain ⟨now, to, a⟩ := r
    show (run p (step p s now to a).2 rs).1.spentTotal.toNat =
      s.spentTotal.toNat + allowedSum ((now, to, a) :: rs)
        ((step p s now to a).1 :: (run p (step p s now to a).2 rs).2)
    rw [ih]
    match hst : step p s now to a, step_shape p s now to a with
    | (v, s'), .inl ⟨hv, hs⟩ =>
      have hs' : s' = s := hs
      show s'.spentTotal.toNat + allowedSum rs (run p s' rs).2 =
        s.spentTotal.toNat + allowedSum ((now, to, a) :: rs) (v :: (run p s' rs).2)
      rw [allowedSum_cons now to a rs v _ hv, hs']
    | (v, s'), .inr ⟨hv, _⟩ =>
      have hv' : v = .allow := hv
      subst hv'
      have hno := (noOverflow p s s' now to a hst).2
      show s'.spentTotal.toNat + allowedSum rs (run p s' rs).2 =
        s.spentTotal.toNat + (a.toNat + allowedSum rs (run p s' rs).2)
      rw [hno, Nat.add_assoc]

theorem noBypassSequence : Spec.NoBypassSequence := fun p s reqs h => by
  rw [← run_spentTotal]
  exact UInt64.le_iff_toNat_le.mp (budgetInvariant p s reqs h)

/-! ## Daily window, ℕ form -/

theorem rollDay_noExpire (p : Policy) (s : State) (now : UInt64)
    (hw : ¬ Expired p s.dayStart now) : rollDay p s now = s := by
  unfold rollDay
  rw [ite_eq_right (fun c => hw ⟨of_decide_eq_true ((Bool.and_eq_true _ _).mp c).1,
    of_decide_eq_true ((Bool.and_eq_true _ _).mp c).2⟩)]

theorem not_ovf_today (r : State) (a : UInt64) (h : ¬ OvfGuard r a) :
    ¬ U64MAX - r.spentToday < a :=
  fun c => h (by unfold OvfGuard; rw [decide_eq_true c, Bool.or_true]; rfl)

theorem run_spentToday_window (p : Policy) (reqs : List Req) : ∀ (s : State),
    (∀ r ∈ reqs, ¬ Expired p s.dayStart r.1) →
    (run p s reqs).1.spentToday.toNat = s.spentToday.toNat + allowedSum reqs (run p s reqs).2 := by
  induction reqs with
  | nil => intro s _; rfl
  | cons r rs ih =>
    intro s hw
    obtain ⟨now, to, a⟩ := r
    have hw0 : ¬ Expired p s.dayStart now := hw (now, to, a) (List.Mem.head _)
    show (run p (step p s now to a).2 rs).1.spentToday.toNat =
      s.spentToday.toNat + allowedSum ((now, to, a) :: rs)
        ((step p s now to a).1 :: (run p (step p s now to a).2 rs).2)
    match step p s now to a, step_shape p s now to a with
    | (v, s'), .inl ⟨hv, hs⟩ =>
      have hs' : s' = s := hs
      subst hs'
      show (run p s' rs).1.spentToday.toNat =
        s'.spentToday.toNat + allowedSum ((now, to, a) :: rs) (v :: (run p s' rs).2)
      rw [allowedSum_cons now to a rs v _ hv]
      exact ih s' (fun r hr => hw r (List.Mem.tail _ hr))
    | (v, s'), .inr ⟨hv, _, _, hO, _, _, hs⟩ =>
      have hv' : v = .allow := hv
      subst hv'
      have hs' : s' = newState s a := by
        have := hs; rw [rollDay_noExpire p s now hw0] at this; exact this
      subst hs'
      have hO' : ¬ OvfGuard s a := by rw [rollDay_noExpire p s now hw0] at hO; exact hO
      have hfit := fits_of_guard s.spentToday a (not_ovf_today s a hO')
      show (run p (newState s a) rs).1.spentToday.toNat =
        s.spentToday.toNat + (a.toNat + allowedSum rs (run p (newState s a) rs).2)
      rw [ih (newState s a) (fun r hr => hw r (List.Mem.tail _ hr)), ← Nat.add_assoc]
      show (s.spentToday + a).toNat + _ = _
      rw [toNat_add_fits _ _ hfit]

theorem noBypassDaily : Spec.NoBypassDaily := fun p s reqs h hw => by
  rw [← run_spentToday_window p reqs s hw]
  exact UInt64.le_iff_toNat_le.mp (dailyInvariant p s reqs h)

end Wallet.Small
