import Policy.Wire
import Policy.WireV2
/-!
# Wallet.Entry — the request exactly as the policy parsed it

The NEAR shim must transfer to the account and amount that `near_policy_decide`
approved. Rather than re-parse the JSON in C (a parser differential), the shim
asks Lean for the result of the same `parseRequest` that `decideList` uses.
-/
namespace Wallet.Entry
open Wallet Wallet.Wire

set_option compiler.extract_closed false

/-- `amount (u64 LE) ‖ to bytes` for a parseable request, `[]` otherwise. -/
def parsedList (input : List UInt8) : List UInt8 :=
  match parseRequest input with
  | some (to, amount) => putU64 amount to
  | none => []

@[export near_wallet_parsed_request]
def parsedRequestExport (input : ByteArray) : ByteArray :=
  toBytes (parsedList (ofBytes input))

end Wallet.Entry
