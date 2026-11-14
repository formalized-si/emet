/-!
# Policy.Core — the spend-policy decision function that runs on NEAR

This module is compiled (Lean → C → wasm32) into the wallet contract, and the
theorems in `Policy.Proofs` are about exactly these definitions.

Executable-subset discipline (the wasm runtime is a minimal C subset of the
Lean runtime: no GMP bignums, no closures, no String primitives, no Init code):

* money and time are `UInt64`; every comparison is overflow-checked, nothing
  relies on wrapping;
* accounts are `List UInt8` (the UTF-8/ASCII bytes of a NEAR account id),
  compared by our own recursive byte equality — no `String`, no `BEq` dictionaries;
* all recursion is first-order and structural; no higher-order functions, so the
  compiler emits no closures; no `Nat` arithmetic on the hot path;
* no `deriving Repr`/string literals here (they would need runtime string
  functions in the module initializer). Pretty-printing lives in `Policy.Examples`.
-/
namespace Wallet

/-- A NEAR account id as its bytes (NEAR ids are ASCII `[a-z0-9._-]`, 2..64 bytes). -/
abbrev Account := List UInt8

/-- The spending policy an owner sets for an agent. Amounts are plain u64 "units". -/
structure Policy where
  /-- Lifetime budget: total ever spent must stay `≤ budgetTotal`. -/
  budgetTotal : UInt64
  /-- Every single payment must be `≤ perTxCap`. -/
  perTxCap    : UInt64
  /-- Spending inside one day window must stay `≤ perDayCap`. -/
  perDayCap   : UInt64
  /-- Length of a day window in nanoseconds (NEAR `block_timestamp` units). -/
  dayLength   : UInt64
  /-- Receiver allowlist. Empty list = deny every payment. -/
  allowed     : List Account

/-- Mutable contract state, persisted between calls. -/
structure State where
  spentTotal : UInt64
  spentToday : UInt64
  /-- Start (ns) of the current day window. -/
  dayStart   : UInt64
  /-- Number of payments allowed so far. -/
  nonce      : UInt64

/-- The outcome of one payment request. -/
inductive Verdict where
  | allow
  | denyBudget
  | denyPerTx
  | denyDaily
  | denyReceiver
  | denyOverflow
deriving DecidableEq

/-- `2^64 - 1`. -/
def U64MAX : UInt64 := 0xFFFFFFFFFFFFFFFF

/-- Byte-wise account equality (own recursion: no `BEq`/`DecidableEq` dictionary).
Patterns are exhaustive on purpose: a wildcard arm compiles to a sparse `casesOn`
over `Nat.hasNotBit`, which adds ~0.6 MB to every exported proof closure. -/
def accEq : Account → Account → Bool
  | [], [] => true
  | [], _ :: _ => false
  | _ :: _, [] => false
  | a :: as, b :: bs => decide (a = b) && accEq as bs

/-- `to` occurs in the allowlist. -/
def isAllowed (to : Account) : List Account → Bool
  | [] => false
  | a :: as => accEq a to || isAllowed to as

/-- Day-window roll. The window `[dayStart, dayStart + dayLength)` has expired iff
`dayStart ≤ now ∧ dayLength ≤ now - dayStart`; the subtraction is only evaluated
when `dayStart ≤ now`, so it never wraps, and `dayStart + dayLength` is never
computed (it could overflow). A clock that runs backwards (`now < dayStart`)
never rolls. On a roll the new window starts at `now`. -/
def rollDay (p : Policy) (s : State) (now : UInt64) : State :=
  if s.dayStart ≤ now && p.dayLength ≤ now - s.dayStart then
    { s with spentToday := 0, dayStart := now }
  else s

/-- **The one decision function.**

Checks, in order: receiver allowlisted; `amount ≤ perTxCap`; no u64 overflow of
`spentTotal + amount`, `spentToday + amount` (after the day roll) or `nonce + 1`;
`spentTotal + amount ≤ budgetTotal`; `spentToday + amount ≤ perDayCap`.

Design decision: **a deny returns the input state unchanged** — not even the day
roll or the nonce is written. The roll is recomputed from `dayStart` on the next
request, so committing it only on `allow` loses nothing, and "deny is a no-op"
is the simplest possible audit property (`step_deny_preserves`). -/
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

/-- Every element of the first list occurs in the second. -/
def subsetB : List Account → List Account → Bool
  | [], _ => true
  | a :: as, l => isAllowed a l && subsetB as l

/-- `p'` is at most as permissive as `p`: every cap `≤`, allowlist `⊆`, and the
**same** `dayLength` (a different window length is not comparable step-wise:
windows are anchored at the first spend after expiry, so they drift apart). -/
def tighten (p p' : Policy) : Bool :=
  p'.budgetTotal ≤ p.budgetTotal && p'.perTxCap ≤ p.perTxCap &&
  p'.perDayCap ≤ p.perDayCap && decide (p'.dayLength = p.dayLength) &&
  subsetB p'.allowed p.allowed

/-- One payment request: `(now, to, amount)`. -/
abbrev Req := UInt64 × Account × UInt64

/-- Fold of `step` over a request list: final state and the verdict of each request. -/
def run (p : Policy) : State → List Req → State × List Verdict
  | s, [] => (s, [])
  | s, (now, to, amount) :: rest =>
    match step p s now to amount with
    | (v, s') =>
      match run p s' rest with
      | (sf, vs) => (sf, v :: vs)

end Wallet
