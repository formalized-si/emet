import Policy.Bounties
/-!
# What a lying prover agent might send, and what NEAR answers

Each theorem below "claims" the bounty `Wallet.Claim.AllowedReceiversOnly` without proving it.
`tools/make_cheats.sh` exports each one as a delta against the sealed shelf; the scenario
reveals every one on-chain and records the reason the board refused to pay.
Four more cheats cannot be written in Lean at all, so they are forged at the export level
(`tools/forge_cheats.py`): two redefinitions of a shelf axiom, a swapped wallet function,
and an ill-typed proof term.
-/
namespace Cheat
open Wallet

/-- "Trust me": the proof is `sorry`. -/
theorem viaSorry : Wallet.Claim.AllowedReceiversOnly := by sorry

/-- A private axiom that makes everything true. -/
axiom magic : False
theorem viaAxiom : Wallet.Claim.AllowedReceiversOnly := magic.elim

/-- A true but different statement: "if it holds, then True". -/
theorem weaker : Wallet.Claim.AllowedReceiversOnly → True := fun _ => trivial

/-- The claim for the empty request list only, not for every request sequence. -/
theorem noRequests (p : Policy) (s : State) :
    ∀ r ∈ acceptedReqs [] (run p s []).2, r.2.1 ∈ p.allowed :=
  fun _ h => nomatch h

end Cheat
