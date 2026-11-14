import Policy.Bounties
/-!
# Do the bounty claims bite? Four buggy wallets, each caught by one claim

Each namespace below is `Wallet.step` with one realistic bug, and `run` over it. For each, the
matching bounty claim (stated here for the mutant's `run`) is proved **false** with a concrete
counterexample, checked by Lean's kernel (`decide`). So a wallet with any of these bugs could not
have been certified: its claim has no proof, and its refutation would win the bounty.

`tools/check_lean.sh` builds this file; it is not part of the wallet build.
-/
namespace Mutant
open Wallet

/-! Bug 1: the allowlist check is gone. Caught by `AllowedReceiversOnly`. -/
namespace NoAllowlist
def step (p : Policy) (s : State) (now : UInt64) (_to : Account) (amount : UInt64) : Verdict × State :=
  if p.perTxCap < amount then (.denyPerTx, s)
  else
    let r := rollDay p s now
    if U64MAX - r.spentTotal < amount || U64MAX - r.spentToday < amount || decide (r.nonce = U64MAX) then (.denyOverflow, s)
    else if p.budgetTotal < r.spentTotal + amount then (.denyBudget, s)
    else if p.perDayCap < r.spentToday + amount then (.denyDaily, s)
    else (.allow, { r with spentTotal := r.spentTotal + amount, spentToday := r.spentToday + amount, nonce := r.nonce + 1 })
def run (p : Policy) : State → List Req → State × List Verdict
  | s, [] => (s, [])
  | s, (now, to, amount) :: rest =>
    match step p s now to amount with
    | (v, s') => match run p s' rest with | (sf, vs) => (sf, v :: vs)
theorem caught : ¬ ∀ (p : Policy) (s : State) (reqs : List Req), ∀ r ∈ acceptedReqs reqs (run p s reqs).2, r.2.1 ∈ p.allowed := by
  intro h
  have := h ⟨10, 5, 10, 1, [[1]]⟩ ⟨0, 0, 0, 0⟩ [(0, [9], 1)] (0, [9], 1) (by decide)
  revert this; decide
end NoAllowlist

/-! Bug 2: the per-payment check compares against twice the cap. Caught by `PerTxCapAlways`. -/
namespace DoubleCap
def step (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64) : Verdict × State :=
  if isAllowed to p.allowed then
    if p.perTxCap + p.perTxCap < amount then (.denyPerTx, s)
    else
      let r := rollDay p s now
      if U64MAX - r.spentTotal < amount || U64MAX - r.spentToday < amount || decide (r.nonce = U64MAX) then (.denyOverflow, s)
      else if p.budgetTotal < r.spentTotal + amount then (.denyBudget, s)
      else if p.perDayCap < r.spentToday + amount then (.denyDaily, s)
      else (.allow, { r with spentTotal := r.spentTotal + amount, spentToday := r.spentToday + amount, nonce := r.nonce + 1 })
  else (.denyReceiver, s)
def run (p : Policy) : State → List Req → State × List Verdict
  | s, [] => (s, [])
  | s, (now, to, amount) :: rest =>
    match step p s now to amount with
    | (v, s') => match run p s' rest with | (sf, vs) => (sf, v :: vs)
theorem caught : ¬ ∀ (p : Policy) (s : State) (reqs : List Req), ∀ r ∈ acceptedReqs reqs (run p s reqs).2, r.2.2 ≤ p.perTxCap := by
  intro h
  have := h ⟨10, 3, 10, 1, [[1]]⟩ ⟨0, 0, 0, 0⟩ [(0, [1], 5)] (0, [1], 5) (by decide)
  revert this; decide
end DoubleCap

/-! Bug 3: no overflow check, so the day's running total can wrap around. Caught by `SlidingTwiceCap`:
with a 6 NEAR daily cap and no per-payment cap, 6 NEAR and then one huge payment both pass, because
`6 + (2^64 - 6)` wraps to `0 ≤ 6`. -/
namespace WrapAdd
def step (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64) : Verdict × State :=
  if isAllowed to p.allowed then
    if p.perTxCap < amount then (.denyPerTx, s)
    else
      let r := rollDay p s now
      if p.budgetTotal < r.spentTotal + amount then (.denyBudget, s)
      else if p.perDayCap < r.spentToday + amount then (.denyDaily, s)
      else (.allow, { r with spentTotal := r.spentTotal + amount, spentToday := r.spentToday + amount, nonce := r.nonce + 1 })
  else (.denyReceiver, s)
def run (p : Policy) : State → List Req → State × List Verdict
  | s, [] => (s, [])
  | s, (now, to, amount) :: rest =>
    match step p s now to amount with
    | (v, s') => match run p s' rest with | (sf, vs) => (sf, v :: vs)
theorem caught : ¬ ∀ (p : Policy) (s : State) (reqs : List Req) (t0 : UInt64),
    s.spentToday ≤ p.perDayCap →
    (∀ r ∈ reqs, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength) →
    allowedSum reqs (run p s reqs).2 ≤ 2 * p.perDayCap.toNat := by
  intro h
  have := h ⟨U64MAX, U64MAX, 6, 10, [[1]]⟩ ⟨0, 0, 0, 0⟩ [(0, [1], 6), (0, [1], U64MAX - 5)] 0
    (by decide) (by decide)
  revert this; decide
end WrapAdd

/-! Bug 4: an allowed payment does not advance the nonce. Caught by `NonceCountsPayments`. -/
namespace NonceSkip
def step (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64) : Verdict × State :=
  if isAllowed to p.allowed then
    if p.perTxCap < amount then (.denyPerTx, s)
    else
      let r := rollDay p s now
      if U64MAX - r.spentTotal < amount || U64MAX - r.spentToday < amount || decide (r.nonce = U64MAX) then (.denyOverflow, s)
      else if p.budgetTotal < r.spentTotal + amount then (.denyBudget, s)
      else if p.perDayCap < r.spentToday + amount then (.denyDaily, s)
      else (.allow, { r with spentTotal := r.spentTotal + amount, spentToday := r.spentToday + amount })
  else (.denyReceiver, s)
def run (p : Policy) : State → List Req → State × List Verdict
  | s, [] => (s, [])
  | s, (now, to, amount) :: rest =>
    match step p s now to amount with
    | (v, s') => match run p s' rest with | (sf, vs) => (sf, v :: vs)
theorem caught : ¬ ∀ (p : Policy) (s : State) (reqs : List Req),
    (run p s reqs).1.nonce.toNat = s.nonce.toNat + (acceptedReqs reqs (run p s reqs).2).length := by
  intro h
  have := h ⟨10, 5, 10, 1, [[1]]⟩ ⟨0, 0, 0, 0⟩ [(0, [1], 1)]
  revert this; decide
end NonceSkip

end Mutant
