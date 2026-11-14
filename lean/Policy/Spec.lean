import Policy.Core
/-!
# Policy.Spec — the claims, as `Prop`s over the exact `Policy.Core` definitions

This file imports nothing but `Policy.Core` and contains no proofs. Each claim is a
closed `Prop`, so a third party (e.g. a bounty) can be asked to "prove
`Wallet.Spec.NoBypassSequence` for this exact `Core`" and the result checked by any
Lean kernel. `Policy.Proofs` / `Policy.SmallProofs` are two independent solutions.
-/
namespace Wallet

/-- The day-roll condition of `rollDay`, as a `Prop`. -/
abbrev Expired (p : Policy) (dayStart now : UInt64) : Prop :=
  dayStart ≤ now ∧ p.dayLength ≤ now - dayStart

/-- ℕ-sum of the amounts of the requests whose verdict is `allow`.
(Exhaustive patterns keep the statement's closure small.) -/
def allowedSum : List Req → List Verdict → Nat
  | [], _ => 0
  | _ :: _, [] => 0
  | (_, _, a) :: rs, v :: vs =>
    match v with
    | .allow => a.toNat + allowedSum rs vs
    | .denyBudget | .denyPerTx | .denyDaily | .denyReceiver | .denyOverflow => allowedSum rs vs

/-- The requests a run allowed, in order. -/
def acceptedReqs : List Req → List Verdict → List Req
  | [], _ => []
  | _ :: _, [] => []
  | r :: rs, v :: vs =>
    match v with
    | .allow => r :: acceptedReqs rs vs
    | .denyBudget | .denyPerTx | .denyDaily | .denyReceiver | .denyOverflow => acceptedReqs rs vs

namespace Spec

/-- Allow ⇒ every bound holds for the new state. -/
def StepAllowBounds : Prop :=
  ∀ (p : Policy) (s s' : State) (now : UInt64) (to : Account) (amount : UInt64),
    step p s now to amount = (.allow, s') →
    s'.spentTotal ≤ p.budgetTotal ∧ s'.spentToday ≤ p.perDayCap ∧
    amount ≤ p.perTxCap ∧ to ∈ p.allowed

/-- Deny ⇒ the state is returned unchanged. -/
def StepDenyPreserves : Prop :=
  ∀ (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64),
    (step p s now to amount).1 ≠ .allow → (step p s now to amount).2 = s

/-- Allow ⇒ no u64 wrap: the ℕ sum fits and is what gets stored. -/
def NoOverflow : Prop :=
  ∀ (p : Policy) (s s' : State) (now : UInt64) (to : Account) (amount : UInt64),
    step p s now to amount = (.allow, s') →
    s.spentTotal.toNat + amount.toNat < 2 ^ 64 ∧
    s'.spentTotal.toNat = s.spentTotal.toNat + amount.toNat

/-- Receivers outside the allowlist are denied, state untouched. -/
def ReceiverGate : Prop :=
  ∀ (p : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64),
    to ∉ p.allowed → step p s now to amount = (.denyReceiver, s)

/-- Headline (ℕ form): over ANY request list, what was spent plus everything
allowed never exceeds the lifetime budget. -/
def NoBypassSequence : Prop :=
  ∀ (p : Policy) (s : State) (reqs : List Req),
    s.spentTotal ≤ p.budgetTotal →
    s.spentTotal.toNat + allowedSum reqs (run p s reqs).2 ≤ p.budgetTotal.toNat

/-- Headline (u64 invariant form): the stored total stays within budget over ANY run. -/
def BudgetInvariant : Prop :=
  ∀ (p : Policy) (s : State) (reqs : List Req),
    s.spentTotal ≤ p.budgetTotal → (run p s reqs).1.spentTotal ≤ p.budgetTotal

/-- Within one day window, today's spend plus everything allowed stays within the cap. -/
def NoBypassDaily : Prop :=
  ∀ (p : Policy) (s : State) (reqs : List Req),
    s.spentToday ≤ p.perDayCap → (∀ r ∈ reqs, ¬ Expired p s.dayStart r.1) →
    s.spentToday.toNat + allowedSum reqs (run p s reqs).2 ≤ p.perDayCap.toNat

/-- The stored daily total stays within the daily cap over ANY run (any times). -/
def DailyInvariant : Prop :=
  ∀ (p : Policy) (s : State) (reqs : List Req),
    s.spentToday ≤ p.perDayCap → (run p s reqs).1.spentToday ≤ p.perDayCap

/-- A tightened policy never allows what the original forbids (same verdict, same state). -/
def TightenSound : Prop :=
  ∀ (p p' : Policy) (s : State) (now : UInt64) (to : Account) (amount : UInt64),
    tighten p p' = true → (step p' s now to amount).1 = .allow →
    step p s now to amount = step p' s now to amount

end Spec
end Wallet
