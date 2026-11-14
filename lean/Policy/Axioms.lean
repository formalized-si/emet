import Policy.Proofs
import Policy.WireProofs
import Policy.SmallProofs
/-!
# Policy.Axioms — axiom audit of the main theorems

Expected: at most `propext`, `Classical.choice`, `Quot.sound`. No `sorryAx`, and no
`Lean.ofReduceBool` (no `native_decide`/`bv_decide` anywhere in the development).
-/
open Wallet Wallet.Wire

#print axioms step_cases
#print axioms expired_iff
#print axioms step_allow_rolled
#print axioms step_allow_bounds
#print axioms step_deny_preserves
#print axioms step_allow_iff
#print axioms no_overflow
#print axioms receiver_gate
#print axioms empty_allowlist_denies
#print axioms perTx_gate
#print axioms run_spentTotal
#print axioms no_bypass_sequence
#print axioms run_daily_inv
#print axioms run_spentToday_window
#print axioms no_bypass_daily
#print axioms tighten_refl
#print axioms tighten_sound
#print axioms tighten_run_sound
#print axioms getU64_putU64
#print axioms decodeState_encodeState
#print axioms decodePolicy_encodePolicy
#print axioms decideList_spec
#print axioms decideList_state
#print axioms digitsAux_sound
#print axioms parseAmount_sound

-- Spec claims, discharged by `Policy.Proofs` (omega-based) ...
#print axioms Wallet.Spec.stepAllowBounds
#print axioms Wallet.Spec.stepDenyPreserves
#print axioms Wallet.Spec.noOverflow
#print axioms Wallet.Spec.receiverGate
#print axioms Wallet.Spec.noBypassSequence
#print axioms Wallet.Spec.budgetInvariant
#print axioms Wallet.Spec.noBypassDaily
#print axioms Wallet.Spec.dailyInvariant
#print axioms Wallet.Spec.tightenSound
-- ... and independently by `Policy.SmallProofs` (no omega, small closures)
#print axioms Wallet.Small.stepAllowBounds
#print axioms Wallet.Small.stepDenyPreserves
#print axioms Wallet.Small.noOverflow
#print axioms Wallet.Small.receiverGate
#print axioms Wallet.Small.noBypassSequence
#print axioms Wallet.Small.budgetInvariant
#print axioms Wallet.Small.dailyInvariant
#print axioms Wallet.Small.noBypassDaily
#print axioms Wallet.Small.tightenSound
