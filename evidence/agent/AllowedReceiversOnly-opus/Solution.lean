import Policy.Bounties
open Wallet

namespace Solution

theorem accEq_eq : ∀ (a b : Account), accEq a b = true → a = b
  | [], [], _ => rfl
  | [], _ :: _, h => Bool.noConfusion h
  | _ :: _, [], h => Bool.noConfusion h
  | x :: xs, y :: ys, h => by
    unfold accEq at h
    cases hd : decide (x = y) with
    | false => rw [hd] at h; exact Bool.noConfusion h
    | true =>
      rw [hd] at h
      rw [of_decide_eq_true hd, accEq_eq xs ys h]

theorem isAllowed_mem (to : Account) : ∀ (l : List Account), isAllowed to l = true → to ∈ l
  | [], h => Bool.noConfusion h
  | a :: as, h => by
    unfold isAllowed at h
    cases ha : accEq a to with
    | true => rw [accEq_eq a to ha]; exact List.Mem.head _
    | false =>
      rw [ha] at h
      exact List.Mem.tail _ (isAllowed_mem to as h)

theorem step_allow (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64)
    (h : (step p s now to amount).1 = .allow) : isAllowed to p.allowed = true := by
  cases hi : isAllowed to p.allowed with
  | true => rfl
  | false =>
    unfold step at h
    rw [hi] at h
    exact Verdict.noConfusion h

theorem main (p : Policy) : ∀ (s : State) (reqs : List Req),
    ∀ r ∈ acceptedReqs reqs (run p s reqs).2, r.2.1 ∈ p.allowed
  | _, [] => fun r h => nomatch h
  | s, (now, to, amount) :: rest => by
    intro r hr
    have hrun : run p s ((now, to, amount) :: rest) =
        ((run p (step p s now to amount).2 rest).1,
         (step p s now to amount).1 :: (run p (step p s now to amount).2 rest).2) := rfl
    rw [hrun] at hr
    generalize hv : (step p s now to amount).1 = v at hr
    cases v with
    | allow =>
      cases hr with
      | head => exact isAllowed_mem _ _ (step_allow p s now to amount hv)
      | tail _ h => exact main p _ rest r h
    | denyBudget => exact main p _ rest r hr
    | denyPerTx => exact main p _ rest r hr
    | denyDaily => exact main p _ rest r hr
    | denyReceiver => exact main p _ rest r hr
    | denyOverflow => exact main p _ rest r hr

theorem proof : Wallet.Claim.AllowedReceiversOnly := fun p s reqs => main p s reqs

end Solution
