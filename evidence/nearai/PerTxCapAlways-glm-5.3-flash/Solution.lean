import Policy.Bounties

open Wallet

namespace Solution

theorem acc_nil_rw (a : Req) (h : a ∈ acceptedReqs ([] : List Req) ([] : List Verdict)) :
    False := by
  exact nomatch h

theorem rw_hyp_of_eq (p : Policy) (s s' : State)
    (hEq : (run p s ([] : List Req)).snd = ([] : List Verdict))
    (h : s = s') :
    (run p s ([] : List Req)).snd = ([] : List Verdict) := by
  rw [h]
  exact hEq

theorem exist_tail_noneq (s : State) (t : State) (h : s = t) :
    ∃ hEq : ({ s with spentTotal := 3 } : State) = ({ t with spentTotal := 3 } : State), True := by
  rw [h]
  exact ⟨rfl, trivial⟩

theorem membership_nil (p : Policy) (s : State) (r : Req) :
    ¬ (r ∈ (run p s ([] : List Req)).snd) := by
  intro h
  rw [(show (run p s ([] : List Req)).snd = ([] : List Verdict) from rfl)] at h
  exact nomatch h

end Solution
