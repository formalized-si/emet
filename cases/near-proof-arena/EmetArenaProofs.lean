import EmetArena

namespace Emet.Arena.Proofs
open NearSpec.TransferV1

/-- The Arena's own proof, used as it is. -/
theorem outputs_unique : Emet.Arena.OutputsUnique :=
  fun h₁ h₂ hctx => NearRelation.outputs_unique h₁ h₂ hctx

theorem relation_in_domain : Emet.Arena.RelationInDomain :=
  fun h => NearRelation.domain h

end Emet.Arena.Proofs
