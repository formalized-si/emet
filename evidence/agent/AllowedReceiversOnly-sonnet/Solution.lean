import Policy.Bounties
open Wallet

namespace Solution

theorem accEq_eq : ∀ (a b : Account), accEq a b = true → a = b
  | [], [], _ => rfl
  | [], _ :: _, h => by simp [accEq] at h
  | _ :: _, [], h => by simp [accEq] at h
  | x :: xs, y :: ys, h => by
    simp only [accEq, Bool.and_eq_true, decide_eq_true_eq] at h
    rw [h.1, accEq_eq xs ys h.2]

theorem isAllowed_mem (to : Account) : ∀ (l : List Account), isAllowed to l = true → to ∈ l
  | [], h => by simp [isAllowed] at h
  | a :: as, h => by
    simp only [isAllowed, Bool.or_eq_true] at h
    cases h with
    | inl h => rw [← accEq_eq a to h]; exact List.Mem.head _
    | inr h => exact List.Mem.tail _ (isAllowed_mem to as h)

theorem step_allow (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64) :
    (step p s now to amount).1 = .allow → to ∈ p.allowed := by
  intro h
  unfold step at h
  split at h
  · exact isAllowed_mem _ _ ‹_›
  · simp at h

theorem run_snd (p : Policy) (s : State) (n : UInt64) (t : Account) (a : UInt64) (rest : List Req) :
    (run p s ((n, t, a) :: rest)).2 = (step p s n t a).1 :: (run p (step p s n t a).2 rest).2 := by
  show (match step p s n t a with
    | (v, s') => match run p s' rest with | (sf, vs) => (sf, v :: vs)).2 = _
  cases step p s n t a
  rename_i v s'
  show (match run p s' rest with | (sf, vs) => (sf, v :: vs)).2 = _
  cases run p s' rest
  rfl

theorem main : ∀ (reqs : List Req) (p : Policy) (s : State),
    ∀ r ∈ acceptedReqs reqs (run p s reqs).2, r.2.1 ∈ p.allowed
  | [], p, s, r, h => by simp [run, acceptedReqs] at h
  | (now, to, amount) :: rest, p, s, r, h => by
    have ih := main rest p (step p s now to amount).2
    rw [run_snd] at h
    have hs := step_allow p s now to amount
    generalize (step p s now to amount).1 = v at h hs
    generalize (run p (step p s now to amount).2 rest).2 = vs at h ih
    cases v <;> simp only [acceptedReqs] at h <;> first
      | exact ih r h
      | (cases h with
         | head => exact hs rfl
         | tail _ h => exact ih r h)

end Solution

theorem Solution.proof : Wallet.Claim.AllowedReceiversOnly :=
  fun p s reqs r h => Solution.main reqs p s r h
