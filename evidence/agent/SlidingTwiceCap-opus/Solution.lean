import Policy.Bounties
open Wallet

namespace Solution

theorem sub_toNat (a b : UInt64) (h : b ≤ a) : (a - b).toNat = a.toNat - b.toNat := by
  have hb : b.toNat ≤ 2 ^ 64 := Nat.le_of_lt (UInt64.toNat_lt b)
  have e : 2 ^ 64 - b.toNat + a.toNat = (a.toNat - b.toNat) + 2 ^ 64 := by
    rw [← Nat.sub_add_cancel (UInt64.le_iff_toNat_le.mp h), Nat.add_sub_cancel,
      Nat.add_left_comm, Nat.sub_add_cancel hb, Nat.add_comm]
  rw [UInt64.toNat_sub, e, Nat.add_mod_right]
  exact Nat.mod_eq_of_lt (Nat.lt_of_le_of_lt (Nat.sub_le _ _) (UInt64.toNat_lt a))

theorem add_toNat (x a : UInt64) (h : ¬ (U64MAX - x < a)) :
    (x + a).toNat = x.toNat + a.toNat := by
  have h1 : a.toNat ≤ (U64MAX - x).toNat := UInt64.le_iff_toNat_le.mp (UInt64.not_lt.mp h)
  have hx : x ≤ U64MAX := UInt64.le_iff_toNat_le.mpr (Nat.le_of_lt_succ (UInt64.toNat_lt x))
  rw [sub_toNat _ _ hx] at h1
  have h2 : a.toNat + x.toNat ≤ U64MAX.toNat := Nat.add_le_of_le_sub (UInt64.le_iff_toNat_le.mp hx) h1
  rw [UInt64.toNat_add, Nat.add_comm x.toNat]
  exact Nat.mod_eq_of_lt (Nat.lt_succ_of_le h2)

theorem step_spec (p : Policy) (s : State) (now : UInt64) (to : Account) (a : UInt64) :
    ((step p s now to a).1 ≠ .allow ∧ (step p s now to a).2 = s) ∨
    ((step p s now to a).1 = .allow ∧
      (step p s now to a).2.spentToday.toNat = (rollDay p s now).spentToday.toNat + a.toNat ∧
      (step p s now to a).2.spentToday ≤ p.perDayCap ∧
      (step p s now to a).2.dayStart = (rollDay p s now).dayStart) := by
  unfold step
  dsimp only
  split
  · split
    · exact Or.inl ⟨fun h => Verdict.noConfusion h, rfl⟩
    · split
      · exact Or.inl ⟨fun h => Verdict.noConfusion h, rfl⟩
      · rename_i h1
        split
        · exact Or.inl ⟨fun h => Verdict.noConfusion h, rfl⟩
        · split
          · exact Or.inl ⟨fun h => Verdict.noConfusion h, rfl⟩
          · rename_i h3
            have hB : ¬ (U64MAX - (rollDay p s now).spentToday < a) := fun h => h1 (by
              rw [decide_eq_true h]
              cases decide (U64MAX - (rollDay p s now).spentTotal < a) <;> rfl)
            exact Or.inr ⟨rfl, add_toNat _ _ hB,
              UInt64.not_lt.mp h3, rfl⟩
  · exact Or.inl ⟨fun h => Verdict.noConfusion h, rfl⟩

theorem roll_spec (p : Policy) (s : State) (now : UInt64) :
    rollDay p s now = s ∨
    ((rollDay p s now).spentToday = 0 ∧ (rollDay p s now).dayStart = now) := by
  unfold rollDay
  split
  · exact Or.inr ⟨rfl, rfl⟩
  · exact Or.inl rfl

theorem no_roll (p : Policy) (s : State) (now t0 : UInt64) (h0 : t0 ≤ s.dayStart)
    (hw : t0 ≤ now ∧ now - t0 < p.dayLength) : rollDay p s now = s := by
  unfold rollDay
  split
  · rename_i h
    exfalso
    cases hA : decide (s.dayStart ≤ now) <;> cases hB : decide (p.dayLength ≤ now - s.dayStart)
      <;> rw [hA, hB] at h <;> try cases h
    have h1 : s.dayStart ≤ now := of_decide_eq_true hA
    have h2 : p.dayLength ≤ now - s.dayStart := of_decide_eq_true hB
    have e1 := sub_toNat _ _ h1
    have e2 := sub_toNat _ _ hw.1
    have h3 := UInt64.le_iff_toNat_le.mp h2
    have h4 : (now - t0).toNat < p.dayLength.toNat := hw.2
    rw [e1] at h3
    rw [e2] at h4
    have h5 : now.toNat - s.dayStart.toNat ≤ now.toNat - t0.toNat :=
      Nat.sub_le_sub_left (UInt64.le_iff_toNat_le.mp h0) _
    exact Nat.lt_irrefl _ (Nat.lt_of_le_of_lt (Nat.le_trans h3 h5) h4)
  · rfl

theorem run_cons (p : Policy) (s : State) (now : UInt64) (to : Account) (a : UInt64)
    (rest : List Req) :
    run p s ((now, to, a) :: rest) =
      ((run p (step p s now to a).2 rest).1,
       (step p s now to a).1 :: (run p (step p s now to a).2 rest).2) := by
  rw [run.eq_2]

theorem sum_deny (v : Verdict) (hv : v ≠ .allow) (r : Req) (rs : List Req) (vs : List Verdict) :
    allowedSum (r :: rs) (v :: vs) = allowedSum rs vs := by
  cases v <;> first | exact absurd rfl hv | rfl

theorem phase2 (p : Policy) (t0 : UInt64) : ∀ (reqs : List Req) (s : State),
    s.spentToday ≤ p.perDayCap → t0 ≤ s.dayStart →
    (∀ r ∈ reqs, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength) →
    s.spentToday.toNat + allowedSum reqs (run p s reqs).2 ≤ p.perDayCap.toNat
  | [], s, hs, _, _ => UInt64.le_iff_toNat_le.mp hs
  | (now, to, a) :: rest, s, hs, h0, hw => by
    have hw' : ∀ r ∈ rest, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength :=
      fun r hr => hw r (List.Mem.tail _ hr)
    have hnow := hw (now, to, a) (List.Mem.head _)
    rw [run_cons]
    rcases step_spec p s now to a with ⟨hv, hs'⟩ | ⟨hv, e, hc, hd⟩
    · rw [sum_deny _ hv]
      rw [hs']
      exact phase2 p t0 rest s hs h0 hw'
    · rw [hv]
      have hr := no_roll p s now t0 h0 hnow
      rw [hr] at e hd
      have := phase2 p t0 rest _ hc (by rw [hd]; exact h0) hw'
      rw [e, Nat.add_assoc] at this
      exact this

theorem phase1 (p : Policy) (t0 : UInt64) : ∀ (reqs : List Req) (s : State),
    s.spentToday ≤ p.perDayCap →
    (∀ r ∈ reqs, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength) →
    s.spentToday.toNat + allowedSum reqs (run p s reqs).2 ≤ p.perDayCap.toNat + p.perDayCap.toNat
  | [], s, hs, _ => Nat.le_trans (UInt64.le_iff_toNat_le.mp hs) (Nat.le_add_right _ _)
  | (now, to, a) :: rest, s, hs, hw => by
    have hw' : ∀ r ∈ rest, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength :=
      fun r hr => hw r (List.Mem.tail _ hr)
    have hnow := hw (now, to, a) (List.Mem.head _)
    rw [run_cons]
    rcases step_spec p s now to a with ⟨hv, hs'⟩ | ⟨hv, e, hc, hd⟩
    · rw [sum_deny _ hv]
      rw [hs']
      exact phase1 p t0 rest s hs hw'
    · rw [hv]
      rcases roll_spec p s now with hr | ⟨hz, hds⟩
      · rw [hr] at e
        have := phase1 p t0 rest _ hc hw'
        rw [e, Nat.add_assoc] at this
        exact this
      · rw [hz] at e
        rw [hds] at hd
        have := phase2 p t0 rest _ hc (by rw [hd]; exact hnow.1) hw'
        rw [e] at this
        have := (Nat.zero_add a.toNat ▸ this : a.toNat + _ ≤ _)
        exact Nat.add_le_add (UInt64.le_iff_toNat_le.mp hs) this

theorem proof : Wallet.Claim.SlidingTwiceCap := by
  intro p s reqs t0 hs hw
  have := phase1 p t0 reqs s hs hw
  rw [← Nat.two_mul] at this
  exact Nat.le_trans (Nat.le_add_left _ _) this

end Solution
