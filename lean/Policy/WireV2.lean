import Policy.Wire
import Policy.CoreV2
/-!
# Policy.WireV2 — the contract entry point for the v2 rules

Same byte formats as `Policy.Wire` (state, policy, request, decision output); the only difference is
that the decision runs `Wallet.V2.step`. The NEAR shim built with `-DWALLET_RULES_V2`
(`contracts/wallet/near_entry_v2.c`) calls `near_policy_decide_v2` instead of `near_policy_decide`;
every other export (policy JSON, validation, tightening, initial state) is shared with v1.
-/
namespace Wallet.WireV2
open Wallet Wallet.Wire

set_option compiler.extract_closed false

/-- Decode policy, state and request; run `V2.step`; encode `tag ‖ newState ‖ code`. -/
def decideList (policyB stateB inputB : List UInt8) (now : UInt64) : List UInt8 :=
  match decodePolicy policyB with
  | none => errPolicy
  | some p =>
    match decodeState stateB with
    | none => errState
    | some s =>
      match parseRequest inputB with
      | none => errInput
      | some (to, amount) =>
        match Wallet.V2.step p s now to amount with
        | (v, s') => Verdict.tag v :: putState s' (Verdict.putCode v [])

/-- Contract `pay` with the v2 rules. -/
@[export near_policy_decide_v2]
def decideExport (policy state input : ByteArray) (now : UInt64) : ByteArray :=
  toBytes (decideList (ofBytes policy) (ofBytes state) (ofBytes input) now)

end Wallet.WireV2
