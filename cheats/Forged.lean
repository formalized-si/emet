import Policy.Bounties
import ForgedRec
/-!
# Two cheats that only the kernel's check of a recursor rule can refuse

`ForgedRec.lean` is the Lean Kernel Arena's `tests/bugs/rec-proof-irrel.lean`, unchanged: it replaces
one rule of a recursor in the environment, without checking it, by an ill-typed proof, and derives
`False` (the arena's tests `bugs/rec-rule-proof-irrel` and `bugs/rec-rule-proof-irrel-nested`).
From `False` the bounty claim follows. Each delta declares inductive types, definitions and theorems
only: no axiom, no `sorry`, no shelf name redefined, and the statement is exactly the claim. So the
scans before the kernel pass, and the kernel itself must refuse the forged rule. nanoda_lib 0.4.31
accepted both; 0.4.32 type-checks every exported rule and refuses them.
-/
namespace Cheat

/-- `False` from a forged rule of `J.rec`. -/
theorem forgedRec : Wallet.Claim.AllowedReceiversOnly := badApp.elim

/-- `False` from a forged rule of `N.rec_1`, the auxiliary recursor of a nested inductive. -/
theorem forgedRecNested : Wallet.Claim.AllowedReceiversOnly := badNested.elim

end Cheat
