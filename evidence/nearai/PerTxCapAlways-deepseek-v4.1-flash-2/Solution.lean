import Policy.Bounties
open Wallet

namespace Solution

/-- An allowed step never lets through more than the per-payment cap. -/
theorem step_allow_cap (p : Policy) (s s' : State) (now : UInt64) (to : Account)
    (amount : UInt64) (h : step p s now to amount = (.allow, s')) : amount ≤ p.perTxCap := by
  unfold step at h
  split at h
  · split at h
    · cases h
    · next hnlt => exact UInt64.not_lt.mp hnlt
  · cases h

/-- The verdict list of a non-empty run: the head verdict followed by the tail run's. -/
theorem run_snd_cons (p : Policy) (s : State) (now : UInt64) (to : Account)
    (amount : UInt64) (qs : List Req) (v : Verdict) (s' : State)
    (h : step p s now to amount = (v, s')) :
    (run p s ((now, to, amount) :: qs)).2 = v :: (run p s' qs).2 := by
  have hh : run p s ((now, to, amount) :: qs) =
      (match run p (step p s now to amount).2 qs with
       | (sf, vs) => (sf, (step p s now to amount).1 :: vs)) := rfl
  rw [h] at hh
  cases e2 : run p s' qs with
  | mk sf vs =>
    rw [e2] at hh
    rw [hh]

/-- Main induction: every accepted request of a run is within the per-payment cap. -/
theorem key (p : Policy) : ∀ (reqs : List Req) (s : State),
    ∀ r ∈ acceptedReqs reqs (run p s reqs).2, r.2.2 ≤ p.perTxCap := by
  intro reqs
  induction reqs with
  | nil =>
    intro s r hr
    cases hr
  | cons q qs ih =>
    intro s r hr
    obtain ⟨now, to, amount⟩ := q
    cases e : step p s now to amount with
    | mk v s' =>
      rw [run_snd_cons p s now to amount qs v s' e] at hr
      cases v with
      | allow =>
        unfold acceptedReqs at hr
        cases hr with
        | head => exact step_allow_cap p s s' now to amount e
        | tail _ hmem => exact ih s' r hmem
      | denyBudget => unfold acceptedReqs at hr; exact ih s' r hr
      | denyPerTx => unfold acceptedReqs at hr; exact ih s' r hr
      | denyDaily => unfold acceptedReqs at hr; exact ih s' r hr
      | denyReceiver => unfold acceptedReqs at hr; exact ih s' r hr
      | denyOverflow => unfold acceptedReqs at hr; exact ih s' r hr

theorem proof : Wallet.Claim.PerTxCapAlways := by
  intro p s reqs r hr
  exact key p reqs s r hr

end Solution
