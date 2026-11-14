import Policy.Spec
/-!
# Policy.Proofs — theorems about the exact definitions in `Policy.Core`

All statements about money are made over `UInt64.toNat`, i.e. in unbounded
natural numbers, so "no wrap-around" is part of what is proved, not assumed.
Tactics: core Lean 4.35 only (`simp`, `omega`, `split`, `cases`, induction).
-/
namespace Wallet

/-! ## Allowlist membership -/

theorem accEq_iff (a b : Account) : accEq a b = true ↔ a = b := by
  induction a generalizing b with
  | nil => cases b <;> simp [accEq]
  | cons x xs ih =>
    cases b with
    | nil => simp [accEq]
    | cons y ys => simp only [accEq, Bool.and_eq_true, decide_eq_true_eq, ih, List.cons.injEq]

theorem isAllowed_iff (to : Account) (l : List Account) : isAllowed to l = true ↔ to ∈ l := by
  induction l with
  | nil => simp [isAllowed]
  | cons a as ih =>
    simp only [isAllowed, Bool.or_eq_true, accEq_iff, ih, List.mem_cons]
    rw [@eq_comm _ a to]

theorem subsetB_iff (l l' : List Account) : subsetB l l' = true ↔ ∀ a ∈ l, a ∈ l' := by
  induction l with
  | nil => simp [subsetB]
  | cons a as ih => simp [subsetB, isAllowed_iff, ih]

/-! ## Day roll -/

theorem rollDay_eq (p : Policy) (s : State) (now : UInt64) :
    rollDay p s now =
      if Expired p s.dayStart now then { s with spentToday := 0, dayStart := now } else s := by
  unfold rollDay Expired
  by_cases h : s.dayStart ≤ now ∧ p.dayLength ≤ now - s.dayStart
  · rw [ite_eq_left h, ite_eq_left (by simp [h.1, h.2])]
  · rw [ite_eq_right h, ite_eq_right (by simpa using h)]

@[simp] theorem rollDay_spentTotal (p : Policy) (s : State) (now : UInt64) :
    (rollDay p s now).spentTotal = s.spentTotal := by
  rw [rollDay_eq]; split <;> rfl

@[simp] theorem rollDay_nonce (p : Policy) (s : State) (now : UInt64) :
    (rollDay p s now).nonce = s.nonce := by
  rw [rollDay_eq]; split <;> rfl

theorem rollDay_noExpire (p : Policy) (s : State) (now : UInt64)
    (h : ¬ Expired p s.dayStart now) : rollDay p s now = s := by
  rw [rollDay_eq, ite_eq_right h]

theorem rollDay_spentToday_le (p : Policy) (s : State) (now : UInt64) :
    (rollDay p s now).spentToday.toNat ≤ s.spentToday.toNat := by
  rw [rollDay_eq]; split <;> simp

/-- **Roll semantics.** The window expires exactly when `now ≥ dayStart + dayLength`
(in ℕ, so the sum cannot overflow). `rollDay` never computes that sum in u64. -/
theorem expired_iff (p : Policy) (d now : UInt64) :
    Expired p d now ↔ d.toNat + p.dayLength.toNat ≤ now.toNat := by
  unfold Expired
  constructor
  · intro ⟨h1, h2⟩
    rw [UInt64.le_iff_toNat_le, UInt64.toNat_sub_of_le _ _ h1] at h2
    rw [UInt64.le_iff_toNat_le] at h1
    omega
  · intro h
    have h1 : d ≤ now := UInt64.le_iff_toNat_le.mpr (by omega)
    refine ⟨h1, ?_⟩
    rw [UInt64.le_iff_toNat_le, UInt64.toNat_sub_of_le _ _ h1]
    omega

/-! ## The master case split of `step`

Every call of `step` is either a deny that returns the input state untouched,
or an allow whose preconditions hold **in ℕ** and whose new state is the
mathematically exact (non-wrapped) update. Everything else follows from this. -/

theorem toNat_U64MAX : U64MAX.toNat = 18446744073709551615 := rfl

theorem le_U64MAX (x : UInt64) : x ≤ U64MAX := by
  rw [UInt64.le_iff_toNat_le, toNat_U64MAX]; have := UInt64.toNat_lt x; omega

theorem toNat_max_sub (x : UInt64) : (U64MAX - x).toNat = 18446744073709551615 - x.toNat := by
  rw [UInt64.toNat_sub_of_le _ _ (le_U64MAX x), toNat_U64MAX]

/-- The new state written on `allow`. -/
def allowState (p : Policy) (s : State) (now amount : UInt64) : State :=
  let r := rollDay p s now
  { r with spentTotal := r.spentTotal + amount, spentToday := r.spentToday + amount,
           nonce := r.nonce + 1 }

/-- Exact Nat-level conditions under which `step` allows. -/
def AllowCond (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64) : Prop :=
  to ∈ p.allowed ∧ amount.toNat ≤ p.perTxCap.toNat ∧
  s.spentTotal.toNat + amount.toNat ≤ p.budgetTotal.toNat ∧
  (rollDay p s now).spentToday.toNat + amount.toNat ≤ p.perDayCap.toNat ∧
  s.nonce.toNat < 2 ^ 64 - 1

theorem step_cases (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64) :
    ((step p s now to amount).1 ≠ .allow ∧ (step p s now to amount).2 = s ∧
        ¬ AllowCond p s now to amount) ∨
    ((step p s now to amount).1 = .allow ∧
        (step p s now to amount).2 = allowState p s now amount ∧
        AllowCond p s now to amount) := by
  have hT := UInt64.toNat_lt s.spentTotal
  have hD := UInt64.toNat_lt (rollDay p s now).spentToday
  have hN := UInt64.toNat_lt s.nonce
  have hA := UInt64.toNat_lt amount
  have hB := UInt64.toNat_lt p.budgetTotal
  have hC := UInt64.toNat_lt p.perDayCap
  unfold step AllowCond
  simp only [isAllowed_iff]
  by_cases hto : to ∈ p.allowed
  · simp only [hto, ite_true, true_and]
    by_cases htx : p.perTxCap < amount
    · rw [UInt64.lt_iff_toNat_lt] at htx
      left; rw [ite_eq_left (by rw [UInt64.lt_iff_toNat_lt]; exact htx)]
      simp only [ne_eq, reduceCtorEq, not_false_eq_true, true_and]
      omega
    · rw [ite_eq_right htx]
      rw [UInt64.lt_iff_toNat_lt] at htx
      simp only [rollDay_spentTotal, rollDay_nonce, Bool.or_eq_true, decide_eq_true_eq]
      by_cases hov : (U64MAX - s.spentTotal < amount ∨
          U64MAX - (rollDay p s now).spentToday < amount) ∨ s.nonce = U64MAX
      · left; rw [ite_eq_left hov]
        simp only [ne_eq, reduceCtorEq, not_false_eq_true, true_and]
        simp only [UInt64.lt_iff_toNat_lt, toNat_max_sub, toNat_U64MAX,
          ← UInt64.toNat_inj] at hov
        omega
      · rw [ite_eq_right hov]
        simp only [UInt64.lt_iff_toNat_lt, toNat_max_sub, toNat_U64MAX,
          ← UInt64.toNat_inj, not_or] at hov
        have e1 : (s.spentTotal + amount).toNat = s.spentTotal.toNat + amount.toNat := by
          rw [UInt64.toNat_add]; omega
        have e2 : ((rollDay p s now).spentToday + amount).toNat =
            (rollDay p s now).spentToday.toNat + amount.toNat := by
          rw [UInt64.toNat_add]; omega
        by_cases hb : p.budgetTotal < s.spentTotal + amount
        · left; rw [ite_eq_left hb]
          simp only [ne_eq, reduceCtorEq, not_false_eq_true, true_and]
          rw [UInt64.lt_iff_toNat_lt, e1] at hb
          omega
        · rw [ite_eq_right hb]
          rw [UInt64.lt_iff_toNat_lt, e1] at hb
          by_cases hd : p.perDayCap < (rollDay p s now).spentToday + amount
          · left; rw [ite_eq_left hd]
            simp only [ne_eq, reduceCtorEq, not_false_eq_true, true_and]
            rw [UInt64.lt_iff_toNat_lt, e2] at hd
            omega
          · rw [ite_eq_right hd]
            rw [UInt64.lt_iff_toNat_lt, e2] at hd
            right
            refine ⟨rfl, ?_, ?_⟩
            · simp [allowState]
            · omega
  · left
    simp only [hto, ite_false, false_and, not_false_eq_true, and_true]
    simp

/-! ## Single-step theorems -/

/-- **Allow ⇒ every bound holds.** If `step` allows, the new totals are within the
budget and the daily cap, the payment is within the per-tx cap, and the receiver
is allowlisted. No hypothesis on the starting state is needed. -/
theorem step_allow_bounds (p : Policy) (s s' : State) (now : UInt64) (to : Account)
    (amount : UInt64) (h : step p s now to amount = (.allow, s')) :
    s'.spentTotal ≤ p.budgetTotal ∧ s'.spentToday ≤ p.perDayCap ∧
    amount ≤ p.perTxCap ∧ to ∈ p.allowed := by
  rcases step_cases p s now to amount with ⟨hv, -, -⟩ | ⟨-, hs, hc⟩
  · rw [h] at hv; exact absurd rfl hv
  · rw [h] at hs
    obtain ⟨hto, htx, hb, hd, hn⟩ := hc
    subst hs
    have hT := UInt64.toNat_lt s.spentTotal
    have hD := UInt64.toNat_lt (rollDay p s now).spentToday
    have hA := UInt64.toNat_lt amount
    simp only [allowState, rollDay_spentTotal, UInt64.le_iff_toNat_le, UInt64.toNat_add]
    refine ⟨?_, ?_, htx, hto⟩ <;> omega

/-- **Deny is a no-op.** On any non-`allow` verdict the returned state is exactly
the input state (spentTotal, spentToday, dayStart and nonce all unchanged; the
day roll is *not* committed on deny). -/
theorem step_deny_preserves (p : Policy) (s : State) (now : UInt64) (to : Account)
    (amount : UInt64) (h : (step p s now to amount).1 ≠ .allow) :
    (step p s now to amount).2 = s := by
  rcases step_cases p s now to amount with ⟨-, hs, -⟩ | ⟨hv, -, -⟩
  · exact hs
  · exact absurd hv h

/-- **Exact allow condition (no spurious denials).** `step` allows iff the receiver
is allowlisted and the per-tx, lifetime and daily limits hold in ℕ (after the day
roll), and the payment counter is not exhausted. So the u64 implementation
decides exactly the mathematical policy: it neither over-allows (wrap-around)
nor over-denies. -/
theorem step_allow_iff (p : Policy) (s : State) (now : UInt64) (to : Account)
    (amount : UInt64) :
    (step p s now to amount).1 = .allow ↔ AllowCond p s now to amount := by
  rcases step_cases p s now to amount with ⟨hv, -, hc⟩ | ⟨hv, -, hc⟩
  · exact ⟨fun h => absurd h hv, fun h => absurd h hc⟩
  · exact ⟨fun _ => hc, fun _ => hv⟩

/-- **No overflow.** Every allow is computed without wrap-around: the true ℕ sums
are `< 2^64`, and the stored counters equal the ℕ sums. -/
theorem no_overflow (p : Policy) (s s' : State) (now : UInt64) (to : Account)
    (amount : UInt64) (h : step p s now to amount = (.allow, s')) :
    s.spentTotal.toNat + amount.toNat < 2 ^ 64 ∧
    s'.spentTotal.toNat = s.spentTotal.toNat + amount.toNat ∧
    s'.spentToday.toNat = (rollDay p s now).spentToday.toNat + amount.toNat ∧
    s'.nonce.toNat = s.nonce.toNat + 1 := by
  rcases step_cases p s now to amount with ⟨hv, -, -⟩ | ⟨-, hs, hc⟩
  · rw [h] at hv; exact absurd rfl hv
  · rw [h] at hs
    obtain ⟨-, -, hb, hd, hn⟩ := hc
    subst hs
    have hB := UInt64.toNat_lt p.budgetTotal
    have hC := UInt64.toNat_lt p.perDayCap
    simp only [allowState, rollDay_spentTotal, rollDay_nonce, UInt64.toNat_add,
      UInt64.toNat_one]
    refine ⟨?_, ?_, ?_, ?_⟩ <;> omega

/-- **The triggering payment counts in the NEW window.** If the window has expired and
`step` allows, the new window starts at `now` and its total is exactly this payment. -/
theorem step_allow_rolled (p : Policy) (s s' : State) (now : UInt64) (to : Account)
    (amount : UInt64) (hexp : Expired p s.dayStart now)
    (h : step p s now to amount = (.allow, s')) : s'.dayStart = now ∧ s'.spentToday = amount := by
  rcases step_cases p s now to amount with ⟨hv, -, -⟩ | ⟨-, hs, -⟩
  · rw [h] at hv; exact absurd rfl hv
  · rw [h] at hs
    subst hs
    simp only [allowState]
    rw [rollDay_eq, ite_eq_left hexp]
    exact ⟨rfl, UInt64.zero_add amount⟩

/-- **Receiver gate.** A receiver outside the allowlist is always denied, and the
state is untouched. -/
theorem receiver_gate (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64)
    (h : to ∉ p.allowed) : step p s now to amount = (.denyReceiver, s) := by
  have : isAllowed to p.allowed = false := by
    cases hb : isAllowed to p.allowed
    · rfl
    · exact absurd ((isAllowed_iff _ _).mp hb) h
  simp [step, this]

/-- An empty allowlist denies everything. -/
theorem empty_allowlist_denies (p : Policy) (s : State) (now : UInt64) (to : Account)
    (amount : UInt64) (h : p.allowed = []) : step p s now to amount = (.denyReceiver, s) :=
  receiver_gate p s now to amount (by simp [h])

/-- Over-cap payments are denied (for allowlisted receivers; otherwise `denyReceiver`). -/
theorem perTx_gate (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64)
    (hto : to ∈ p.allowed) (h : p.perTxCap < amount) :
    step p s now to amount = (.denyPerTx, s) := by
  have : isAllowed to p.allowed = true := (isAllowed_iff _ _).mpr hto
  simp [step, this, h]

/-! ## Sequences: the headline theorems -/

theorem allowedSum_cons (now : UInt64) (to : Account) (a : UInt64) (rs : List Req)
    (v : Verdict) (vs : List Verdict) :
    allowedSum ((now, to, a) :: rs) (v :: vs) =
      (if v = .allow then a.toNat else 0) + allowedSum rs vs := by
  cases v <;> simp [allowedSum]

theorem run_cons (p : Policy) (s : State) (now : UInt64) (to : Account) (a : UInt64)
    (rs : List Req) :
    run p s ((now, to, a) :: rs) =
      ((run p (step p s now to a).2 rs).1,
       (step p s now to a).1 :: (run p (step p s now to a).2 rs).2) := by
  simp only [run]

theorem run_length (p : Policy) (s : State) (reqs : List Req) :
    (run p s reqs).2.length = reqs.length := by
  induction reqs generalizing s with
  | nil => rfl
  | cons r rs ih =>
    obtain ⟨now, to, a⟩ := r
    simp [run_cons, ih]

/-- **Exact accounting.** The final `spentTotal` is the starting one plus the ℕ-sum
of exactly the allowed payments: nothing is lost, double-counted, or wrapped. -/
theorem run_spentTotal (p : Policy) (s : State) (reqs : List Req) :
    (run p s reqs).1.spentTotal.toNat =
      s.spentTotal.toNat + allowedSum reqs (run p s reqs).2 := by
  induction reqs generalizing s with
  | nil => simp [run, allowedSum]
  | cons r rs ih =>
    obtain ⟨now, to, a⟩ := r
    rw [run_cons, allowedSum_cons, ih]
    rcases step_cases p s now to a with ⟨hv, hs, -⟩ | ⟨hv, hs, hc⟩
    · rw [hs, ite_eq_right hv]; omega
    · rw [ite_eq_left hv]
      have := no_overflow p s (step p s now to a).2 now to a (by rw [← hv])
      omega

/-- Lifetime-budget invariant: `step` preserves `spentTotal ≤ budgetTotal`. -/
theorem step_budget_inv (p : Policy) (s : State) (now : UInt64) (to : Account) (a : UInt64)
    (h : s.spentTotal ≤ p.budgetTotal) : (step p s now to a).2.spentTotal ≤ p.budgetTotal := by
  rcases step_cases p s now to a with ⟨-, hs, -⟩ | ⟨hv, -, -⟩
  · rw [hs]; exact h
  · exact (step_allow_bounds p s _ now to a (by rw [← hv])).1

/-- **No bypass by sequencing (lifetime budget).** For ANY list of requests — any
order, any timestamps, any receivers — starting from a state within budget, the
ℕ-sum of all individually-allowed payments plus what was already spent never
exceeds `budgetTotal`; and the final state is within budget. -/
theorem no_bypass_sequence (p : Policy) (s : State) (reqs : List Req)
    (h : s.spentTotal ≤ p.budgetTotal) :
    s.spentTotal.toNat + allowedSum reqs (run p s reqs).2 ≤ p.budgetTotal.toNat ∧
    (run p s reqs).1.spentTotal ≤ p.budgetTotal := by
  have inv : (run p s reqs).1.spentTotal ≤ p.budgetTotal := by
    induction reqs generalizing s with
    | nil => exact h
    | cons r rs ih =>
      obtain ⟨now, to, a⟩ := r
      rw [run_cons]
      exact ih _ (step_budget_inv p s now to a h)
  refine ⟨?_, inv⟩
  rw [← run_spentTotal]
  exact UInt64.le_iff_toNat_le.mp inv

/-- Daily invariant: `step` preserves `spentToday ≤ perDayCap` (at any time,
across rolls). -/
theorem step_daily_inv (p : Policy) (s : State) (now : UInt64) (to : Account) (a : UInt64)
    (h : s.spentToday ≤ p.perDayCap) : (step p s now to a).2.spentToday ≤ p.perDayCap := by
  rcases step_cases p s now to a with ⟨-, hs, -⟩ | ⟨hv, -, -⟩
  · rw [hs]; exact h
  · exact (step_allow_bounds p s _ now to a (by rw [← hv])).2.1

/-- For any run (any timestamps, across any number of day rolls) the final
`spentToday` stays within `perDayCap`. -/
theorem run_daily_inv (p : Policy) (s : State) (reqs : List Req)
    (h : s.spentToday ≤ p.perDayCap) : (run p s reqs).1.spentToday ≤ p.perDayCap := by
  induction reqs generalizing s with
  | nil => exact h
  | cons r rs ih =>
    obtain ⟨now, to, a⟩ := r
    rw [run_cons]
    exact ih _ (step_daily_inv p s now to a h)

/-- Inside one window, `step` keeps `dayStart` and adds exactly the allowed amount
to `spentToday`. -/
theorem step_noExpire (p : Policy) (s : State) (now : UInt64) (to : Account) (a : UInt64)
    (hw : ¬ Expired p s.dayStart now) :
    (step p s now to a).2.dayStart = s.dayStart ∧
    (step p s now to a).2.spentToday.toNat =
      s.spentToday.toNat + (if (step p s now to a).1 = .allow then a.toNat else 0) := by
  rcases step_cases p s now to a with ⟨hv, hs, -⟩ | ⟨hv, hs, -⟩
  · rw [hs, ite_eq_right hv]; exact ⟨rfl, by omega⟩
  · rw [ite_eq_left hv]
    have hno := no_overflow p s (step p s now to a).2 now to a (by rw [← hv])
    rw [rollDay_noExpire p s now hw] at hno
    refine ⟨?_, hno.2.2.1⟩
    rw [hs]; simp [allowState, rollDay_noExpire p s now hw]

/-- Inside one window, `spentToday` grows by exactly the allowed amounts. -/
theorem run_spentToday_window (p : Policy) (reqs : List Req) : ∀ (s : State),
    (∀ r ∈ reqs, ¬ Expired p s.dayStart r.1) →
    (run p s reqs).1.spentToday.toNat = s.spentToday.toNat + allowedSum reqs (run p s reqs).2 := by
  induction reqs with
  | nil => intro s _; simp [run, allowedSum]
  | cons r rs ih =>
    intro s hw
    obtain ⟨now, to, a⟩ := r
    have hw0 : ¬ Expired p s.dayStart now := hw (now, to, a) (by simp)
    obtain ⟨hds, hsp⟩ := step_noExpire p s now to a hw0
    rw [run_cons, allowedSum_cons,
      ih (step p s now to a).2 (by intro r hr; rw [hds]; exact hw r (by simp [hr]))]
    omega

/-- **No bypass within a day window.** If every request's timestamp lies inside the
current window `[dayStart, dayStart + dayLength)` and the state starts within the
daily cap, the ℕ-sum of everything allowed (plus what was already spent today)
never exceeds `perDayCap` — splitting a large payment into many small ones in
one day does not help. -/
theorem no_bypass_daily (p : Policy) (s : State) (reqs : List Req)
    (h : s.spentToday ≤ p.perDayCap)
    (hw : ∀ r ∈ reqs, ¬ Expired p s.dayStart r.1) :
    s.spentToday.toNat + allowedSum reqs (run p s reqs).2 ≤ p.perDayCap.toNat := by
  rw [← run_spentToday_window p reqs s hw]
  exact UInt64.le_iff_toNat_le.mp (run_daily_inv p s reqs h)

/-! ## Tightening -/

theorem tighten_iff (p p' : Policy) :
    tighten p p' = true ↔
      p'.budgetTotal ≤ p.budgetTotal ∧ p'.perTxCap ≤ p.perTxCap ∧
      p'.perDayCap ≤ p.perDayCap ∧ p'.dayLength = p.dayLength ∧
      ∀ a ∈ p'.allowed, a ∈ p.allowed := by
  simp [tighten, subsetB_iff, and_assoc]

theorem tighten_refl (p : Policy) : tighten p p = true := by
  simp [tighten_iff]

/-- **A tightened policy never allows what the original forbids.** If
`tighten p p' = true` and `p'` allows a request from state `s`, then `p` allows
the same request from `s`, and both produce the identical new state. -/
theorem tighten_sound (p p' : Policy) (s : State) (now : UInt64) (to : Account) (a : UInt64)
    (ht : tighten p p' = true) (h : (step p' s now to a).1 = .allow) :
    step p s now to a = step p' s now to a := by
  obtain ⟨hb, htx, hd, hl, hal⟩ := (tighten_iff p p').mp ht
  have hroll : rollDay p s now = rollDay p' s now := by
    simp only [rollDay, hl]
  have c' := (step_allow_iff p' s now to a).mp h
  obtain ⟨hto, h1, h2, h3, h4⟩ := c'
  have c : AllowCond p s now to a := by
    rw [UInt64.le_iff_toNat_le] at hb htx hd
    refine ⟨hal _ hto, by omega, by omega, ?_, h4⟩
    rw [hroll]; omega
  rcases step_cases p s now to a with ⟨-, -, hc⟩ | ⟨hv, hs, -⟩
  · exact absurd c hc
  · rcases step_cases p' s now to a with ⟨hv', -, -⟩ | ⟨-, hs', -⟩
    · exact absurd h hv'
    · have e : allowState p s now a = allowState p' s now a := by
        simp only [allowState, hroll]
      ext <;> simp [hv, h, hs, hs', e]

/-- **Tightening, sequence form.** Whatever a tightened policy `p'` let through
over a whole run, the original `p` lets through too: replaying exactly the
requests `p'` accepted under `p` accepts all of them and reaches the same final
state. -/
theorem tighten_run_sound (p p' : Policy) (s : State) (reqs : List Req)
    (ht : tighten p p' = true) :
    run p s (acceptedReqs reqs (run p' s reqs).2) =
      ((run p' s reqs).1,
       (acceptedReqs reqs (run p' s reqs).2).map (fun _ => Verdict.allow)) := by
  induction reqs generalizing s with
  | nil => simp [run, acceptedReqs]
  | cons r rs ih =>
    obtain ⟨now, to, a⟩ := r
    rw [run_cons p' s now to a rs]
    rcases step_cases p' s now to a with ⟨hv, hs, -⟩ | ⟨hv, -, -⟩
    · have hacc : acceptedReqs ((now, to, a) :: rs)
          ((step p' s now to a).1 :: (run p' (step p' s now to a).2 rs).2) =
          acceptedReqs rs (run p' (step p' s now to a).2 rs).2 := by
        cases hstep : (step p' s now to a).1 <;> simp_all [acceptedReqs]
      rw [hacc, hs, ih]
    · have hacc : acceptedReqs ((now, to, a) :: rs)
          ((step p' s now to a).1 :: (run p' (step p' s now to a).2 rs).2) =
          (now, to, a) :: acceptedReqs rs (run p' (step p' s now to a).2 rs).2 := by
        rw [hv]; rfl
      rw [hacc, run_cons, tighten_sound p p' s now to a ht hv, ih, hv]
      simp

/-! ## The `Spec` claims, discharged -/

namespace Spec
theorem stepAllowBounds : StepAllowBounds := step_allow_bounds
theorem stepDenyPreserves : StepDenyPreserves := step_deny_preserves
theorem noOverflow : NoOverflow := fun p s s' now to a h =>
  ⟨(no_overflow p s s' now to a h).1, (no_overflow p s s' now to a h).2.1⟩
theorem receiverGate : ReceiverGate := receiver_gate
theorem noBypassSequence : NoBypassSequence := fun p s reqs h => (no_bypass_sequence p s reqs h).1
theorem budgetInvariant : BudgetInvariant := fun p s reqs h => (no_bypass_sequence p s reqs h).2
theorem noBypassDaily : NoBypassDaily := no_bypass_daily
theorem dailyInvariant : DailyInvariant := run_daily_inv
theorem tightenSound : TightenSound := fun p p' s now to a ht h => tighten_sound p p' s now to a ht h
end Spec

end Wallet
