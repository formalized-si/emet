import Policy.Bounties
open Wallet

namespace Solution

example (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64)
    (s' : State) (h : step p s now to amount = (.allow, s')) :
    (rollDay p s now).nonce ≠ U64MAX := by
  unfold Wallet.step at h
  dsimp only at h
  split at h
  · next hb => exact absurd (Prod.mk.inj h).1 (by decide)
  · next hb =>
    split at h
    · exact absurd (Prod.mk.inj h).1 (by decide)
    · split at h
      · next hov => exact absurd (Prod.mk.inj h).1 (by decide)

end Solution
