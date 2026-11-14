import Policy.Bounties
open Wallet

namespace Solution

/-- If `accEq` returns `true`, the accounts are equal. -/
theorem accEq_sound : ∀ (a b : Account), accEq a b = true → a = b
  | [], [] => fun _ => rfl
  | [], _ :: _ => fun h => by cases h
  | _ :: _, [] => fun h => by cases h
  | a :: as, b :: bs => fun h => by
    have h1 : (accEq (a :: as) (b :: bs)) = true := h
    rw [Wallet.accEq] at h1
    cases hd : decide (a = b) with
    | false => rw [hd] at h1; cases h1
    | true =>
      have h2 : accEq as bs = true := by rw [hd] at h1; exact h1
      have hab : a = b := of_decide_eq_true hd
      rw [hab, accEq_sound as bs h2]

/-- If `isAllowed` returns `true`, the account is in the allowlist. -/
theorem isAllowed_sound (to : Account) :
    ∀ (l : List Account), isAllowed to l = true → to ∈ l
  | [], h => by cases h
  | a :: as, h => by
    cases hb : accEq a to with
    | true =>
      have hab : a = to := accEq_sound a to hb
      rw [hab]
      exact List.mem_cons_self
    | false =>
      have h2 : isAllowed to as = true := by
        have h1 : (accEq a to || isAllowed to as) = true := h
        rw [hb] at h1
        exact h1
      exact List.mem_cons_of_mem a (isAllowed_sound to as h2)

/-- `step` returns `allow` only if the receiver is allowlisted. -/
theorem step_allow_isAllowed (p : Policy) (s : State) (now : UInt64) (to : Account)
    (amount : UInt64) (h : (step p s now to amount).1 = .allow) :
    isAllowed to p.allowed = true := by
  unfold Wallet.step at h
  split at h
  · assumption
  · cases h

theorem step_allow_mem (p : Policy) (s : State) (now : UInt64) (to : Account)
    (amount : UInt64) (h : (step p s now to amount).1 = .allow) : to ∈ p.allowed :=
  isAllowed_sound to p.allowed (step_allow_isAllowed p s now to amount h)

/-- Unfolding `run` at a cons. -/
theorem run_cons (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64)
    (rest : List Req) (v : Verdict) (s' : State)
    (h1 : step p s now to amount = (v, s')) :
    run p s ((now, to, amount) :: rest)
      = ((run p s' rest).1, v :: (run p s' rest).2) := by
  rw [Wallet.run.eq_2, h1]

theorem proof : Wallet.Claim.AllowedReceiversOnly := by
  intro p s reqs
  induction reqs generalizing s with
  | nil =>
    intro r hr
    cases hr
  | cons hd tl ih =>
    intro r hr
    obtain ⟨now, to, amount⟩ := hd
    cases hstep : step p s now to amount with
    | mk v s' =>
      rw [run_cons p s now to amount tl v s' hstep] at hr
      cases v with
      | allow =>
        rw [Wallet.acceptedReqs.eq_3] at hr
        cases hr with
        | head =>
          exact step_allow_mem p s now to amount (by rw [hstep])
        | tail _ h => exact ih s' r h
      | denyBudget =>
        rw [Wallet.acceptedReqs.eq_4] at hr
        exact ih s' r hr
      | denyPerTx =>
        rw [Wallet.acceptedReqs.eq_5] at hr
        exact ih s' r hr
      | denyDaily =>
        rw [Wallet.acceptedReqs.eq_6] at hr
        exact ih s' r hr
      | denyReceiver =>
        rw [Wallet.acceptedReqs.eq_7] at hr
        exact ih s' r hr
      | denyOverflow =>
        rw [Wallet.acceptedReqs.eq_8] at hr
        exact ih s' r hr

end Solution
