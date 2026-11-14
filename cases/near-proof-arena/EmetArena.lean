import NearSpec.TransferV1

/-!
Two theorems that NEAR Proof Arena's specification proves about its own transfer relation
(spec/lean/NearSpec/TransferV1.lean), restated as named propositions so that a proof of each can be
claimed against a sealed environment. The statements are the Arena's, word for word.
-/
namespace Emet.Arena
open NearSpec.TransferV1

/-- `NearRelation.outputs_unique`: the relation is a function of the witness. -/
def OutputsUnique : Prop :=
  ∀ {c₁ c₂ : Claim} {w : Witness}, NearRelation c₁ w → NearRelation c₂ w → c₁.ctx = c₂.ctx →
    Outputs.ofClaim c₁ = Outputs.ofClaim c₂

/-- `NearRelation.domain`: whatever the relation holds for is inside the specified domain. -/
def RelationInDomain : Prop :=
  ∀ {c : Claim} {w : Witness}, NearRelation c w → Domain c w

end Emet.Arena
