import Policy.Bounties
open Wallet

namespace Solution

theorem proof : Wallet.Claim.Refute.SlidingDayCap := by
  intro h
  have := h ⟨100, 10, 10, 10, [[1]]⟩ ⟨0, 0, 0, 0⟩ [(5, [1], 10), (10, [1], 10)] 5
    (by decide) (by
      intro r hr
      cases hr with
      | head => exact ⟨by decide, by decide⟩
      | tail _ hr =>
        cases hr with
        | head => exact ⟨by decide, by decide⟩
        | tail _ hr => cases hr)
  revert this
  decide

end Solution
