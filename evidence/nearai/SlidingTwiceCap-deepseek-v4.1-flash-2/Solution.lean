import Policy.Bounties
open Wallet

namespace Solution

example (p : Policy) (s s' : State) (now : UInt64) (to : Account) (amount : UInt64)
    (h : step p s now to amount = (.allow, s')) : True := by
  simp only [step] at h
  split at h
  · split at h
    · split at h
      · split at h
        · split at h
          · trace_state
            trivial
          · trace_state
            trivial
        · trace_state
          trivial
      · trace_state
        trivial
    · trace_state
      trivial
  · trace_state
    trivial

theorem proof : Wallet.Claim.SlidingTwiceCap := by
  sorry

end Solution
