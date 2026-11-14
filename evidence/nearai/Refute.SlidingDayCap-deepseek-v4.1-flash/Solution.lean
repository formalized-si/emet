import Policy.Bounties
open Wallet

/-!
# A counterexample to `Wallet.Claim.SlidingDayCap`

The v1 wallet's day window is *anchored*, not sliding: `rollDay` moves `dayStart` to the
timestamp of the first payment after expiry and resets `spentToday`. So the whole daily cap can
be spent at the very end of one window and the whole cap again a moment later, at the start of
the next one — both payments inside a single stretch of time shorter than one `dayLength`.

Concretely: `dayLength = 100`, `perDayCap = perTxCap = 10`, one allowed receiver `[1]`, state
with `dayStart = 0` and nothing spent. Pay 10 at `t = 99` (still inside the window `[0,100)`),
then 10 at `t = 100` (the window has expired, so `spentToday` resets). Both requests lie in
`[99, 199)`, of length 100, but 20 > 10 is paid out.
-/

namespace Solution

/-- A generous lifetime budget, a cap of 10 per tx and per day, 100ns days, one allowed receiver. -/
def p : Policy :=
  { budgetTotal := 100, perTxCap := 10, perDayCap := 10, dayLength := 100, allowed := [[1]] }

/-- Nothing spent yet, current window anchored at 0. -/
def s : State :=
  { spentTotal := 0, spentToday := 0, dayStart := 0, nonce := 0 }

/-- Pay the cap at `t = 99` (end of the window), then again at `t = 100` (the window has just
rolled over). -/
def reqs : List Req := [(99, [1], 10), (100, [1], 10)]

/-- Both requests fall inside the 100ns stretch starting at `t0 = 99`, which is shorter than
`p.dayLength = 100`. -/
theorem mem_req : ∀ r ∈ reqs, (99 : UInt64) ≤ r.1 ∧ r.1 - 99 < p.dayLength := by
  intro r hr
  cases hr with
  | head => decide
  | tail _ h =>
    cases h with
    | head => decide
    | tail _ h' => cases h'

/-- Both payments are allowed (the second one after the day roll reset `spentToday` to 0). -/
theorem run_res : (run p s reqs).2 = [Verdict.allow, Verdict.allow] := rfl

/-- The hypothesis `s.spentToday ≤ p.perDayCap` holds, yet 20 units are paid out. -/
theorem proof : Wallet.Claim.Refute.SlidingDayCap := by
  intro h
  have h1 : s.spentToday ≤ p.perDayCap := by decide
  have h3 := h p s reqs 99 h1 mem_req
  rw [run_res] at h3
  exact absurd h3 (by decide)

end Solution
