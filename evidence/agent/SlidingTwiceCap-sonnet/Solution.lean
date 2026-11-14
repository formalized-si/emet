import Policy.Bounties
open Wallet

namespace Solution

theorem sub_nat (a b : UInt64) (h : b ≤ a) : a.toNat = b.toNat + (a - b).toNat := by
  have hb := UInt64.le_iff_toNat_le.1 h
  have ha := UInt64.toNat_lt a
  have hb2 := UInt64.toNat_lt b
  obtain ⟨D, hD⟩ := Nat.exists_eq_add_of_le hb
  rw [UInt64.toNat_sub]
  have e : 2 ^ 64 - b.toNat + a.toNat = D + 2 ^ 64 := by
    rw [hD, ← Nat.add_assoc, Nat.sub_add_cancel (Nat.le_of_lt hb2), Nat.add_comm]
  rw [e, Nat.add_mod_right, Nat.mod_eq_of_lt]
  · exact hD
  · rw [hD] at ha
    exact Nat.lt_of_le_of_lt (Nat.le_add_left _ _) ha

theorem add_nat (a b : UInt64) (h : b ≤ U64MAX - a) : (a + b).toNat = a.toNat + b.toNat := by
  have h1 : a ≤ U64MAX := UInt64.le_iff_toNat_le.2 (Nat.le_of_lt_succ (UInt64.toNat_lt a))
  have h2 := UInt64.le_iff_toNat_le.1 h
  have h3 := sub_nat _ _ h1
  rw [UInt64.toNat_add]
  apply Nat.mod_eq_of_lt
  have h4 : a.toNat + b.toNat ≤ U64MAX.toNat :=
    Nat.le_trans (Nat.add_le_add_left h2 _) (Nat.le_of_eq h3.symm)
  exact Nat.lt_of_le_of_lt h4 (by decide)

theorem and_dec1 (A B : Prop) [Decidable A] [Decidable B] (h : (decide A && decide B) = true) :
    A ∧ B := by
  by_cases hA : A
  · by_cases hB : B
    · exact ⟨hA, hB⟩
    · have e : (decide A && decide B) = false := by
        rw [decide_eq_false hB]; cases decide A <;> rfl
      exact absurd (h.symm.trans e) (by intro e; cases e)
  · have e : (decide A && decide B) = false := by
      rw [decide_eq_false hA]; rfl
    exact absurd (h.symm.trans e) (by intro e; cases e)

theorem and_dec2 (A B : Prop) [Decidable A] [Decidable B] (h : A ∧ B) :
    (decide A && decide B) = true := by
  rw [decide_eq_true h.1, decide_eq_true h.2]
  rfl

theorem roll_spec (p : Policy) (s : State) (now : UInt64) :
    (rollDay p s now = s ∧ ¬ Expired p s.dayStart now) ∨
    (Expired p s.dayStart now ∧ (rollDay p s now).spentToday = 0 ∧ (rollDay p s now).dayStart = now) := by
  unfold rollDay
  split
  · rename_i hc
    exact Or.inr ⟨and_dec1 _ _ hc, rfl, rfl⟩
  · rename_i hc
    exact Or.inl ⟨rfl, fun hE => hc (and_dec2 _ _ hE)⟩

def SS (p : Policy) (s : State) (now : UInt64) (a : UInt64) (v : Verdict) (s' : State) : Prop :=
    (v ≠ .allow ∧ s' = s) ∨
    (v = .allow ∧ ¬ Expired p s.dayStart now ∧ s'.dayStart = s.dayStart ∧
      s'.spentToday.toNat = s.spentToday.toNat + a.toNat ∧ s'.spentToday ≤ p.perDayCap) ∨
    (v = .allow ∧ Expired p s.dayStart now ∧ s'.dayStart = now ∧
      s'.spentToday.toNat = a.toNat ∧ s'.spentToday ≤ p.perDayCap)

theorem dn (p : Policy) (s : State) (now : UInt64) (a : UInt64) (v : Verdict) (s' : State)
    (w : Verdict) (h : (w, s) = (v, s')) (hw : w ≠ .allow) : SS p s now a v s' := by
  injection h with h1 h2; subst h1; subst h2; exact Or.inl ⟨hw, rfl⟩

/-- classification of a step -/
theorem step_spec (p : Policy) (s : State) (now : UInt64) (to : Account) (a : UInt64)
    (v : Verdict) (s' : State) (h : step p s now to a = (v, s')) : SS p s now a v s' := by
  have hr := roll_spec p s now
  unfold step at h
  generalize rollDay p s now = r at h hr
  split at h
  · split at h
    · exact dn _ _ _ _ _ _ _ h (by nofun)
    · simp only [] at h
      split at h
      · exact dn _ _ _ _ _ _ _ h (by nofun)
      · rename_i h3
        split at h
        · exact dn _ _ _ _ _ _ _ h (by nofun)
        · split at h
          · exact dn _ _ _ _ _ _ _ h (by nofun)
          · rename_i h5
            injection h with h1 h2; subst h1; subst h2
            have h3' : ¬ (U64MAX - r.spentToday < a) := by
              intro hh; apply h3; simp [hh]
            have hn := add_nat _ _ (UInt64.not_lt.1 h3')
            have h5' := UInt64.not_lt.1 h5
            rcases hr with ⟨e, hE⟩ | ⟨hE, e1, e2⟩
            · subst e
              exact Or.inr (Or.inl ⟨rfl, hE, rfl, hn, h5'⟩)
            · refine Or.inr (Or.inr ⟨rfl, hE, e2, ?_, h5'⟩)
              show (r.spentToday + a).toNat = _
              rw [hn, e1]
              show 0 + a.toNat = _
              exact Nat.zero_add _
  · exact dn _ _ _ _ _ _ _ h (by nofun)

theorem run_cons (p : Policy) (s : State) (n : UInt64) (t : Account) (a : UInt64) (rest : List Req)
    (v : Verdict) (s' : State) (hst : step p s n t a = (v, s')) :
    (run p s ((n, t, a) :: rest)).2 = v :: (run p s' rest).2 := by
  show (match step p s n t a with
    | (v, s') => match run p s' rest with | (sf, vs) => (sf, v :: vs)).2 = _
  rw [hst]

theorem sum_allow (n : UInt64) (t : Account) (a : UInt64) (rest : List Req) (vs : List Verdict) :
    allowedSum ((n, t, a) :: rest) (.allow :: vs) = a.toNat + allowedSum rest vs := rfl

theorem sum_deny (n : UInt64) (t : Account) (a : UInt64) (rest : List Req) (vs : List Verdict) (v : Verdict)
    (h : v ≠ .allow) :
    allowedSum ((n, t, a) :: rest) (v :: vs) = allowedSum rest vs := by
  cases v <;> first | exact absurd rfl h | rfl

theorem noexp (p : Policy) (t0 d n : UInt64) (h0 : t0 ≤ d) (h1 : t0 ≤ n) (h2 : n - t0 < p.dayLength) :
    ¬ Expired p d n := by
  intro ⟨a, b⟩
  have b1 := UInt64.le_iff_toNat_le.1 b
  have h2' := UInt64.lt_iff_toNat_lt.1 h2
  have e1 := sub_nat _ _ a
  have e2 := sub_nat _ _ h0
  have e3 := sub_nat _ _ h1
  -- n = d + (n-d), d = t0 + (d-t0), n = t0 + (n-t0)
  have e4 : t0.toNat + (n - t0).toNat = t0.toNat + ((d - t0).toNat + (n - d).toNat) := by
    rw [← e3, e1, e2, Nat.add_assoc]
  have e5 := Nat.add_left_cancel e4
  exact Nat.lt_irrefl _ (Nat.lt_of_le_of_lt (Nat.le_trans b1 (e5 ▸ Nat.le_add_left _ _)) h2')

theorem L1 (p : Policy) (t0 : UInt64) (reqs : List Req) :
    ∀ s : State, t0 ≤ s.dayStart → (∀ r ∈ reqs, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength) →
    s.spentToday ≤ p.perDayCap →
    s.spentToday.toNat + allowedSum reqs (run p s reqs).2 ≤ p.perDayCap.toNat := by
  induction reqs with
  | nil =>
    intro s _ _ h
    exact UInt64.le_iff_toNat_le.1 h
  | cons r rest ih =>
    obtain ⟨n, t, a⟩ := r
    intro s h0 hw hc
    have hn := hw (n, t, a) (List.Mem.head _)
    have hw' : ∀ r ∈ rest, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength := fun r hr => hw r (List.Mem.tail _ hr)
    obtain ⟨v, s', hst⟩ : ∃ v s', step p s n t a = (v, s') := ⟨_, _, rfl⟩
    have hs := step_spec p s n t a v s' hst
    rw [run_cons p s n t a rest v s' hst]
    rcases hs with ⟨hv, e⟩ | ⟨e, hE, hd, hsp, hcap⟩ | ⟨e, hE, _⟩
    · subst e
      rw [sum_deny _ _ _ _ _ _ hv]
      exact ih _ h0 hw' hc
    · subst e
      rw [sum_allow]
      have := ih s' (hd ▸ h0) hw' hcap
      rw [hsp, Nat.add_assoc] at this
      exact this
    · exact absurd hE (noexp p t0 _ _ h0 hn.1 hn.2)

theorem L2 (p : Policy) (t0 : UInt64) (reqs : List Req) :
    ∀ s : State, (∀ r ∈ reqs, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength) →
    s.spentToday ≤ p.perDayCap →
    s.spentToday.toNat + allowedSum reqs (run p s reqs).2 ≤ p.perDayCap.toNat + p.perDayCap.toNat := by
  induction reqs with
  | nil =>
    intro s _ h
    exact Nat.le_trans (UInt64.le_iff_toNat_le.1 h) (Nat.le_add_right _ _)
  | cons r rest ih =>
    obtain ⟨n, t, a⟩ := r
    intro s hw hc
    have hn := hw (n, t, a) (List.Mem.head _)
    have hw' : ∀ r ∈ rest, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength := fun r hr => hw r (List.Mem.tail _ hr)
    obtain ⟨v, s', hst⟩ : ∃ v s', step p s n t a = (v, s') := ⟨_, _, rfl⟩
    have hs := step_spec p s n t a v s' hst
    rw [run_cons p s n t a rest v s' hst]
    have hc' := UInt64.le_iff_toNat_le.1 hc
    rcases hs with ⟨hv, e⟩ | ⟨e, hE, hd, hsp, hcap⟩ | ⟨e, hE, hd, hsp, hcap⟩
    · subst e
      rw [sum_deny _ _ _ _ _ _ hv]
      exact ih _ hw' hc
    · subst e
      rw [sum_allow]
      have := ih s' hw' hcap
      rw [hsp, Nat.add_assoc] at this
      exact this
    · subst e
      rw [sum_allow]
      have := L1 p t0 rest s' (hd ▸ hn.1) hw' hcap
      rw [hsp] at this
      exact Nat.add_le_add hc' this

theorem proof : Wallet.Claim.SlidingTwiceCap := by
  intro p s reqs t0 hs hw
  have := L2 p t0 reqs s hw hs
  rw [Nat.two_mul]
  exact Nat.le_trans (Nat.le_add_left _ _) this

end Solution
