import Policy.Core
/-!
# Policy.CoreV2 — the fix for the anchored day window

A bounty on the v1 wallet paid for a counterexample to "within any stretch shorter than a day, the
wallet pays out at most one day's cap" (`Wallet.Claim.Refute.SlidingDayCap`): the v1 window is
anchored at the first payment after the previous window expired, so the cap can be spent at the
end of one window and again at the start of the next.

v2 changes one thing, the day roll. When a window expires and the new one would start less than
two windows after the old one started, the old window's spending is **carried** into the new window
instead of being reset to zero. The old window's payments happened in `[dayStart, dayStart + dayLength)`;
a new window that starts before `dayStart + 2·dayLength` still lies within one window length of some
of them, so they keep counting; a later window drops them. The state and the policy are the same as v1 (same 32-byte state, same policy bytes), so the
contract shim and the wire format are unchanged; only `step` differs.

After two window lengths without a successful rolling request the old spending can be dropped.
That is not a bound on waiting: zero-value requests can keep carrying the old spending forward.
The claim `Wallet.Claim.V2.SlidingDayCap` (in `Policy.Bounties`) proves the spending bound, not liveness.
-/
namespace Wallet.V2
open Wallet

/-- Day-window roll with carry. Same expiry test as v1; the subtraction `now - dayStart - dayLength`
is evaluated only after `dayLength ≤ now - dayStart`, so it never wraps. -/
def rollDay (p : Policy) (s : State) (now : UInt64) : State :=
  if s.dayStart ≤ now && p.dayLength ≤ now - s.dayStart then
    if now - s.dayStart - p.dayLength < p.dayLength then { s with dayStart := now }
    else { s with spentToday := 0, dayStart := now }
  else s

/-- The v2 decision function: v1's `step` with `V2.rollDay`. -/
def step (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64) :
    Verdict × State :=
  if isAllowed to p.allowed then
    if p.perTxCap < amount then (.denyPerTx, s)
    else
      let r := rollDay p s now
      if U64MAX - r.spentTotal < amount || U64MAX - r.spentToday < amount ||
          decide (r.nonce = U64MAX) then (.denyOverflow, s)
      else if p.budgetTotal < r.spentTotal + amount then (.denyBudget, s)
      else if p.perDayCap < r.spentToday + amount then (.denyDaily, s)
      else (.allow, { r with spentTotal := r.spentTotal + amount,
                             spentToday := r.spentToday + amount,
                             nonce := r.nonce + 1 })
  else (.denyReceiver, s)

/-- Fold of `V2.step` over a request list. -/
def run (p : Policy) : State → List Req → State × List Verdict
  | s, [] => (s, [])
  | s, (now, to, amount) :: rest =>
    match step p s now to amount with
    | (v, s') =>
      match run p s' rest with
      | (sf, vs) => (sf, v :: vs)

end Wallet.V2
