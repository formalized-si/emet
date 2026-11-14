import Policy.Spec
import Policy.CoreV2
/-!
# Policy.Bounties — open questions about the wallet, posted as bounties

The claims in `Policy.Spec` come with the wallet: its author proved them (`Policy.Proofs`,
`Policy.SmallProofs`) and `lake build` re-checks those proofs before any wasm is produced.

The claims below are statements about whole runs that the wallet author did not state or prove.
Some follow from the author's per-step lemmas (`AllowedReceiversOnly`, `PerTxCapAlways`,
`NonceCountsPayments`). The sliding-window pair is new, and its first half is false: the daily
window is anchored at the first payment after the previous one expired, not sliding (see
`Examples.lean`, "windows are anchored, not sliding"). They are what a wallet owner might still
want to know about the same code, so they are posted on the board as bounties. Each comes with
its negation under `Refute`: a bounty pays whoever settles the question, with a proof or with a
counterexample. Like `Spec`, this file contains definitions only.
-/
namespace Wallet.Claim
open Wallet

/-- Over ANY list of requests, every payment the wallet allows goes to an allowlisted receiver.
(A prompt-injected agent cannot get money out to anyone else, whatever it sends, in any order.) -/
def AllowedReceiversOnly : Prop :=
  ∀ (p : Policy) (s : State) (reqs : List Req),
    ∀ r ∈ acceptedReqs reqs (run p s reqs).2, r.2.1 ∈ p.allowed

/-- Over ANY list of requests, every payment the wallet allows is within the per-payment cap. -/
def PerTxCapAlways : Prop :=
  ∀ (p : Policy) (s : State) (reqs : List Req),
    ∀ r ∈ acceptedReqs reqs (run p s reqs).2, r.2.2 ≤ p.perTxCap

/-- The nonce counts the allowed payments exactly, over ANY run. -/
def NonceCountsPayments : Prop :=
  ∀ (p : Policy) (s : State) (reqs : List Req),
    (run p s reqs).1.nonce.toNat = s.nonce.toNat + (acceptedReqs reqs (run p s reqs).2).length

/-- "Within any stretch of time shorter than a day, the wallet pays out at most one day's cap."
This is what most owners assume a daily cap means. -/
def SlidingDayCap : Prop :=
  ∀ (p : Policy) (s : State) (reqs : List Req) (t0 : UInt64),
    s.spentToday ≤ p.perDayCap →
    (∀ r ∈ reqs, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength) →
    allowedSum reqs (run p s reqs).2 ≤ p.perDayCap.toNat

/-- "Within any stretch of time shorter than a day, the wallet pays out at most twice the daily
cap", whatever the agent sends, in any order. -/
def SlidingTwiceCap : Prop :=
  ∀ (p : Policy) (s : State) (reqs : List Req) (t0 : UInt64),
    s.spentToday ≤ p.perDayCap →
    (∀ r ∈ reqs, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength) →
    allowedSum reqs (run p s reqs).2 ≤ 2 * p.perDayCap.toNat

namespace Refute
/-- A counterexample to `AllowedReceiversOnly`. -/
def AllowedReceiversOnly : Prop := ¬ Claim.AllowedReceiversOnly
/-- A counterexample to `PerTxCapAlways`. -/
def PerTxCapAlways : Prop := ¬ Claim.PerTxCapAlways
/-- A counterexample to `NonceCountsPayments`. -/
def NonceCountsPayments : Prop := ¬ Claim.NonceCountsPayments
/-- A counterexample to `SlidingDayCap`. -/
def SlidingDayCap : Prop := ¬ Claim.SlidingDayCap
/-- A counterexample to `SlidingTwiceCap`. -/
def SlidingTwiceCap : Prop := ¬ Claim.SlidingTwiceCap
end Refute

/-! ## v2: the fix for the refuted claim

`Policy.CoreV2` carries the old window's spending into a window that starts less than two window
lengths after it. The same statement as `SlidingDayCap`, for `V2.run`, is the bounty for the fix. -/
namespace V2

/-- "Within any stretch of time shorter than a day, the v2 wallet pays out at most one day's cap",
whatever the agent sends, in any order. -/
def SlidingDayCap : Prop :=
  ∀ (p : Policy) (s : State) (reqs : List Req) (t0 : UInt64),
    s.spentToday ≤ p.perDayCap →
    (∀ r ∈ reqs, t0 ≤ r.1 ∧ r.1 - t0 < p.dayLength) →
    allowedSum reqs (Wallet.V2.run p s reqs).2 ≤ p.perDayCap.toNat

namespace Refute
/-- A counterexample to `V2.SlidingDayCap`. -/
def SlidingDayCap : Prop := ¬ Claim.V2.SlidingDayCap
end Refute

end V2

end Wallet.Claim
