import Policy.Bounties
open Wallet

namespace Solution

theorem SL1 {a b c : Nat} (h : b ≤ a) (h2 : a - b < c) : a < c + b := by
  have e := Nat.add_lt_add_right h2 b
  rw [Nat.sub_add_cancel h] at e
  exact e

theorem SL2 {a b c : Nat} (h : b ≤ a) (h2 : a < c + b) : a - b < c := by
  rw [← Nat.sub_add_cancel h] at h2
  exact Nat.lt_of_add_lt_add_right h2

theorem N1 (t x n L : Nat) (h1 : t ≤ x) (h2 : n - t < L) (h3 : x ≤ n) : n - x < L :=
  SL2 h3 (Nat.lt_of_lt_of_le (SL1 (Nat.le_trans h1 h3) h2) (Nat.add_le_add_left h1 L))

theorem and_l {a b : Bool} (h : (a && b) = true) : a = true ∧ b = true := by
  cases a
  · exact Bool.noConfusion h
  · cases b
    · exact Bool.noConfusion h
    · exact ⟨rfl, rfl⟩

theorem N2 (t x n d L : Nat) (h1 : t ≤ x) (_h2 : x - t < L) (h3 : t ≤ n) (h4 : n - t < L)
    (h5 : d ≤ n) (h6 : ¬(d ≤ x ∧ L ≤ x - d)) (h7 : L ≤ n - d) : n - d - L < L := by
  have hn : n < L + t := SL1 h3 h4
  by_cases hd : d ≤ x
  · have hxd : x - d < L := Nat.lt_of_not_le (fun h => h6 ⟨hd, h⟩)
    have hx : x < L + d := SL1 hd hxd
    apply SL2 h7
    apply SL2 h5
    rw [Nat.add_assoc]
    exact Nat.lt_of_lt_of_le hn (Nat.add_le_add_left (Nat.le_trans h1 (Nat.le_of_lt hx)) L)
  · have hx : x < d := Nat.lt_of_not_le hd
    have : n - d < L := SL2 h5
      (Nat.lt_of_lt_of_le hn (Nat.add_le_add_left (Nat.le_trans h1 (Nat.le_of_lt hx)) L))
    exact Nat.lt_of_le_of_lt (Nat.sub_le _ _) this

theorem N3 (c b : Nat) (hb : b ≤ 2 ^ 64) : 2 ^ 64 - b + (c + b) = c + 2 ^ 64 := by
  rw [Nat.add_comm c b, ← Nat.add_assoc, Nat.sub_add_cancel hb, Nat.add_comm]

theorem sub_toNat (a b : UInt64) (h : b ≤ a) : (a - b).toNat = a.toNat - b.toNat := by
  have hb : b.toNat ≤ a.toNat := UInt64.le_iff_toNat_le.mp h
  rw [UInt64.toNat_sub]
  have e := N3 (a.toNat - b.toNat) b.toNat (Nat.le_of_lt (UInt64.toNat_lt b))
  rw [Nat.sub_add_cancel hb] at e
  rw [e, Nat.add_mod_right]
  exact Nat.mod_eq_of_lt (Nat.lt_of_le_of_lt (Nat.sub_le _ _) (UInt64.toNat_lt a))

theorem le_n {a b : UInt64} (h : a ≤ b) : a.toNat ≤ b.toNat := UInt64.le_iff_toNat_le.mp h
theorem n_le {a b : UInt64} (h : a.toNat ≤ b.toNat) : a ≤ b := UInt64.le_iff_toNat_le.mpr h
theorem lt_n {a b : UInt64} (h : a < b) : a.toNat < b.toNat := by
  have h' : ¬ b.toNat ≤ a.toNat := fun h2 => (UInt64.not_lt.mpr (n_le h2)) h
  exact Nat.lt_of_not_le h'
theorem n_lt {a b : UInt64} (h : a.toNat < b.toNat) : a < b := by
  apply Classical.byContradiction
  intro hn
  exact Nat.not_le_of_lt h (le_n (UInt64.not_lt.mp hn))

/-- no reset possible within the window for dayStart d -/
def NR (p : Policy) (t0 d : UInt64) : Prop :=
  ∀ n : UInt64, t0 ≤ n → n - t0 < p.dayLength →
    d ≤ n → p.dayLength ≤ n - d → n - d - p.dayLength < p.dayLength

theorem roll_spent (p : Policy) (t0 : UInt64) (st : State) (n : UInt64)
    (hnr : NR p t0 st.dayStart) (h1 : t0 ≤ n) (h2 : n - t0 < p.dayLength) :
    (V2.rollDay p st n).spentToday = st.spentToday := by
  unfold V2.rollDay
  by_cases hc : (st.dayStart ≤ n && p.dayLength ≤ n - st.dayStart) = true
  · rw [if_pos hc]
    have ha : st.dayStart ≤ n := of_decide_eq_true (and_l hc).1
    have hb : p.dayLength ≤ n - st.dayStart := of_decide_eq_true (and_l hc).2
    rw [if_pos (hnr n h1 h2 ha hb)]
  · rw [if_neg hc]

theorem roll_start (p : Policy) (st : State) (n : UInt64) :
    (V2.rollDay p st n).dayStart = n ∨
      ((V2.rollDay p st n).dayStart = st.dayStart ∧ ¬(st.dayStart ≤ n ∧ p.dayLength ≤ n - st.dayStart)) := by
  unfold V2.rollDay
  by_cases hc : (st.dayStart ≤ n && p.dayLength ≤ n - st.dayStart) = true
  · rw [if_pos hc]
    by_cases hd : n - st.dayStart - p.dayLength < p.dayLength
    · rw [if_pos hd]; exact Or.inl rfl
    · rw [if_neg hd]; exact Or.inl rfl
  · rw [if_neg hc]
    refine Or.inr ⟨rfl, fun ⟨a, b⟩ => hc ?_⟩
    rw [decide_eq_true a, decide_eq_true b]; rfl

theorem K (p : Policy) (t0 : UInt64) (st : State) (x : UInt64)
    (h1 : t0 ≤ x) (h2 : x - t0 < p.dayLength) : NR p t0 (V2.rollDay p st x).dayStart := by
  intro n g1 g2 g3 g4
  rcases roll_start p st x with h | ⟨h, hn⟩
  · rw [h] at g3 g4 ⊢
    exfalso
    have e1 := sub_toNat n t0 g1
    have e2 := sub_toNat n x g3
    have := N1 t0.toNat x.toNat n.toNat p.dayLength.toNat (le_n h1) (e1 ▸ lt_n g2) (le_n g3)
    exact Nat.not_le_of_lt (e2 ▸ this) (le_n g4)
  · rw [h] at g3 g4 ⊢
    have e1 := sub_toNat n t0 g1
    have e2 := sub_toNat n st.dayStart g3
    have e3 := sub_toNat x t0 h1
    have e4 := sub_toNat (n - st.dayStart) p.dayLength g4
    apply n_lt
    rw [e4, e2]
    refine N2 t0.toNat x.toNat n.toNat st.dayStart.toNat p.dayLength.toNat (le_n h1)
      (e3 ▸ lt_n h2) (le_n g1) (e1 ▸ lt_n g2) (le_n g3) ?_ (e2 ▸ le_n g4)
    intro ⟨a, b⟩
    apply hn
    refine ⟨n_le a, n_le ?_⟩
    rw [sub_toNat x st.dayStart (n_le a)]
    exact b

theorem step_spec (p : Policy) (st : State) (x : UInt64) (to : Account) (a : UInt64) :
    (∃ v, v ≠ Verdict.allow ∧ V2.step p st x to a = (v, st)) ∨
    (∃ s', V2.step p st x to a = (.allow, s') ∧
      s'.spentToday = (V2.rollDay p st x).spentToday + a ∧
      (V2.rollDay p st x).spentToday.toNat + a.toNat < 2 ^ 64 ∧
      s'.spentToday ≤ p.perDayCap ∧
      s'.dayStart = (V2.rollDay p st x).dayStart) := by
  unfold V2.step
  by_cases h1 : isAllowed to p.allowed = true
  · rw [if_pos h1]
    by_cases h2 : p.perTxCap < a
    · rw [if_pos h2]; exact Or.inl ⟨_, fun h => Verdict.noConfusion h, rfl⟩
    · rw [if_neg h2]
      generalize V2.rollDay p st x = r
      by_cases h3 : (U64MAX - r.spentTotal < a || U64MAX - r.spentToday < a ||
          decide (r.nonce = U64MAX)) = true
      · rw [if_pos h3]; exact Or.inl ⟨_, fun h => Verdict.noConfusion h, rfl⟩
      · rw [if_neg h3]
        by_cases h4 : p.budgetTotal < r.spentTotal + a
        · rw [if_pos h4]; exact Or.inl ⟨_, fun h => Verdict.noConfusion h, rfl⟩
        · rw [if_neg h4]
          by_cases h5 : p.perDayCap < r.spentToday + a
          · rw [if_pos h5]; exact Or.inl ⟨_, fun h => Verdict.noConfusion h, rfl⟩
          · rw [if_neg h5]
            refine Or.inr ⟨_, rfl, rfl, ?_, UInt64.not_lt.mp h5, rfl⟩
            have h6 : ¬ U64MAX - r.spentToday < a := fun h => h3 (by rw [decide_eq_true h, Bool.or_true, Bool.true_or])
            have h7 := le_n (UInt64.not_lt.mp h6)
            rw [sub_toNat _ _ (n_le (Nat.le_of_lt_succ (UInt64.toNat_lt _)))] at h7
            have h8 : r.spentToday.toNat + a.toNat ≤ U64MAX.toNat :=
              Nat.add_comm _ _ ▸ Nat.add_le_of_le_sub (Nat.le_of_lt_succ (UInt64.toNat_lt _)) h7
            exact Nat.lt_succ_of_le h8
  · rw [if_neg h1]; exact Or.inl ⟨_, fun h => Verdict.noConfusion h, rfl⟩

theorem toNat_add_ok {a b : UInt64} (h : a.toNat + b.toNat < 2 ^ 64) :
    (a + b).toNat = a.toNat + b.toNat := by
  rw [UInt64.toNat_add]; exact Nat.mod_eq_of_lt h

theorem run_cons (p : Policy) (st s' : State) (x : UInt64) (to : Account) (a : UInt64)
    (rest : List Req) (v : Verdict) (he : V2.step p st x to a = (v, s')) :
    (V2.run p st ((x, to, a) :: rest)).2 = v :: (V2.run p s' rest).2 := by
  simp only [V2.run, he]

theorem deny_sum (x : UInt64) (to : Account) (a : UInt64) (rest : List Req) (vs : List Verdict)
    (v : Verdict) (hv : v ≠ .allow) : allowedSum ((x, to, a) :: rest) (v :: vs) = allowedSum rest vs := by
  cases v
  · exact absurd rfl hv
  all_goals rfl

theorem lemA (p : Policy) (t0 : UInt64) (reqs : List Req) : ∀ (st : State),
    (∀ r ∈ reqs, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength) →
    st.spentToday ≤ p.perDayCap →
    (NR p t0 st.dayStart →
      st.spentToday.toNat + allowedSum reqs (V2.run p st reqs).2 ≤ p.perDayCap.toNat) ∧
    allowedSum reqs (V2.run p st reqs).2 ≤ p.perDayCap.toNat := by
  induction reqs with
  | nil => intro st _ hs; exact ⟨fun _ => le_n hs, Nat.zero_le _⟩
  | cons r rest ihr =>
    obtain ⟨x, to, a⟩ := r
    intro st hw hs
    have hx := hw (x, to, a) (List.Mem.head _)
    have hw' : ∀ r ∈ rest, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength :=
      fun r hr => hw r (List.Mem.tail _ hr)
    rcases step_spec p st x to a with ⟨v, hv, he⟩ | ⟨s', he, e1, e2, e3, e4⟩
    · rw [run_cons p st st x to a rest v he, deny_sum x to a rest _ v hv]
      exact ihr st hw' hs
    · have ih := (ihr s' hw' e3).1 (e4 ▸ K p t0 st x hx.1 hx.2)
      rw [run_cons p st s' x to a rest .allow he]
      show (_ → _ + (a.toNat + _) ≤ _) ∧ a.toNat + _ ≤ _
      rw [e1, toNat_add_ok e2] at ih
      refine ⟨fun hnr => ?_, Nat.le_trans (Nat.add_le_add_right (Nat.le_add_left _ _) _) ih⟩
      rw [roll_spent p t0 st x hnr hx.1 hx.2] at ih
      rw [← Nat.add_assoc]; exact ih

theorem proof : Wallet.Claim.V2.SlidingDayCap :=
  fun p s reqs t0 hs hw => (lemA p t0 reqs s hw hs).2

end Solution
