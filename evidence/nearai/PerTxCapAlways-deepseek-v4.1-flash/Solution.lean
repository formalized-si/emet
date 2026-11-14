import Policy.Bounties
open Wallet

namespace Solution

theorem step_perTx (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64)
    (h : (step p s now to amount).1 = .allow) : amount ≤ p.perTxCap := by
  unfold step at h
  by_cases hlt : p.perTxCap < amount
  · by_cases ha : isAllowed to p.allowed = true
    · rw [ite_eq_left ha, ite_eq_left hlt] at h
      exact absurd h (by intro hh; cases hh)
    · rw [ite_eq_right ha] at h
      exact absurd h (by intro hh; cases hh)
  · exact UInt64.not_lt.mp hlt

theorem key (p : Policy) : ∀ (reqs : List Req) (s : State),
    ∀ r ∈ acceptedReqs reqs (run p s reqs).2, r.2.2 ≤ p.perTxCap := by
  intro reqs
  induction reqs with
  | nil =>
    intro s r hr
    exact absurd hr List.not_mem_nil
  | cons q rest ih =>
    obtain ⟨now, to, amount⟩ := q
    intro s r hr
    cases hstep : step p s now to amount with
    | mk v s' =>
      cases hrun : run p s' rest with
      | mk sf vs =>
        have hrun2 : run p s ((now, to, amount) :: rest) = (sf, v :: vs) := by
          show (match step p s now to amount with
                | (v, s') => match run p s' rest with
                  | (sf, vs) => (sf, v :: vs)) = (sf, v :: vs)
          rw [hstep, hrun]
        rw [hrun2] at hr
        cases v
        case allow =>
          rw [hrun] at ih
          intro hmem
        all_goals sorry

end Solution
