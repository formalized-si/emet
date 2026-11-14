import Policy.Core
/-!
# Policy.Wire — byte codecs and the exported contract entry points

Everything here is in the same executable subset as `Policy.Core`: first-order
structural recursion over `List UInt8`, `UInt64` arithmetic, no `String`, no
closures, no Init calls, no string literals. The only `ByteArray` operations are
at the boundary (`ofBytes`, `toBytes`).

## Formats

* **State** (NEAR storage): exactly 32 bytes =
  `spentTotal ‖ spentToday ‖ dayStart ‖ nonce`, each u64 little-endian.
* **Policy** (NEAR storage): `budgetTotal ‖ perTxCap ‖ perDayCap ‖ dayLength`
  (u64 LE) then up to 64 entries `len:u8 ‖ len bytes`, one per allowlisted account
  (2 ≤ len ≤ 64, bytes in `[a-z0-9._-]`).
* **Request** (call args): flat JSON `{"to":"alice.testnet","amount":"1000"}`, keys in
  either order, ASCII whitespace allowed, string values only, no escapes; the
  amount is a decimal u64 (overflow rejected).
* **Policy JSON** (`set_policy` args), fixed key order:
  `{"budget":"..","per_tx":"..","per_day":"..","day_ns":"..","allowed":["a.testnet",..]}`.
* **Decision output**: `tag ‖ newState(32 bytes) ‖ ASCII code` where `tag` is one ASCII
  letter (`A` allow, `B` budget, `T` per-tx, `D` daily, `R` receiver, `O` overflow),
  or `E ‖ ASCII error code` when policy/state/input fail to decode.
-/
namespace Wallet.Wire
open Wallet

-- Closed terms would be lazily initialised through `lean_obj_once_cold`, which the
-- minimal wasm runtime does not provide; build the few constants inline instead.
set_option compiler.extract_closed false

/-! ## u64 little-endian -/

/-- Prepend the 8 little-endian bytes of `x` to `rest`. -/
def putU64 (x : UInt64) (rest : List UInt8) : List UInt8 :=
  x.toUInt8 :: (x >>> 8).toUInt8 :: (x >>> 16).toUInt8 :: (x >>> 24).toUInt8 ::
  (x >>> 32).toUInt8 :: (x >>> 40).toUInt8 :: (x >>> 48).toUInt8 :: (x >>> 56).toUInt8 :: rest

/-- Little-endian combine (Horner form). -/
def combine8 (b0 b1 b2 b3 b4 b5 b6 b7 : UInt8) : UInt64 :=
  b0.toUInt64 + 256 * (b1.toUInt64 + 256 * (b2.toUInt64 + 256 * (b3.toUInt64 + 256 *
  (b4.toUInt64 + 256 * (b5.toUInt64 + 256 * (b6.toUInt64 + 256 * b7.toUInt64))))))

def getU64 : List UInt8 → Option (UInt64 × List UInt8)
  | b0 :: b1 :: b2 :: b3 :: b4 :: b5 :: b6 :: b7 :: rest =>
    some (combine8 b0 b1 b2 b3 b4 b5 b6 b7, rest)
  | _ => none

/-! ## State codec (32 bytes) -/

def putState (s : State) (rest : List UInt8) : List UInt8 :=
  putU64 s.spentTotal (putU64 s.spentToday (putU64 s.dayStart (putU64 s.nonce rest)))

def encodeState (s : State) : List UInt8 := putState s []

def decodeState (bs : List UInt8) : Option State :=
  match getU64 bs with
  | none => none
  | some (a, r1) =>
    match getU64 r1 with
    | none => none
    | some (b, r2) =>
      match getU64 r2 with
      | none => none
      | some (c, r3) =>
        match getU64 r3 with
        | some (d, []) => some ⟨a, b, c, d⟩
        | _ => none

/-! ## Account ids -/

/-- NEAR account-id byte: `a-z`, `0-9`, `.`, `_`, `-`. -/
def accByteOk (b : UInt8) : Bool :=
  (97 ≤ b && b ≤ 122) || (48 ≤ b && b ≤ 57) || decide (b = 46) || decide (b = 95) || decide (b = 45)

def allAccBytes : List UInt8 → Bool
  | [] => true
  | b :: bs => accByteOk b && allAccBytes bs

/-- At most `n` elements. -/
def atMost : Nat → List UInt8 → Bool
  | _, [] => true
  | 0, _ :: _ => false
  | n + 1, _ :: bs => atMost n bs

/-- 2..64 bytes from the NEAR account charset. -/
def validAccount (a : Account) : Bool :=
  match a with
  | _ :: _ :: _ => atMost 64 a && allAccBytes a
  | _ => false

/-- Number of bytes, as a byte (callers guarantee ≤ 64). -/
def lenU8 : List UInt8 → UInt8
  | [] => 0
  | _ :: bs => lenU8 bs + 1

/-! ## Policy codec -/

/-- Take exactly `n` bytes; `n` is a byte value (≤ 255), a small `Nat`. -/
def takeN : Nat → List UInt8 → Option (List UInt8 × List UInt8)
  | 0, r => some ([], r)
  | _ + 1, [] => none
  | n + 1, b :: r =>
    match takeN n r with
    | some (xs, r') => some (b :: xs, r')
    | none => none

/-- Maximum allowlist size (bounds gas). -/
def maxAccounts : Nat := 64

def getAccounts : Nat → List UInt8 → Option (List Account)
  | _, [] => some []
  | 0, _ :: _ => none
  | fuel + 1, len :: r =>
    match takeN len.toNat r with
    | none => none
    | some (acc, r') =>
      if validAccount acc then
        match getAccounts fuel r' with
        | some accs => some (acc :: accs)
        | none => none
      else none

def putBytes : List UInt8 → List UInt8 → List UInt8
  | [], rest => rest
  | b :: bs, rest => b :: putBytes bs rest

def putAccounts : List Account → List UInt8
  | [] => []
  | a :: as => lenU8 a :: putBytes a (putAccounts as)

def encodePolicy (p : Policy) : List UInt8 :=
  putU64 p.budgetTotal (putU64 p.perTxCap (putU64 p.perDayCap (putU64 p.dayLength
    (putAccounts p.allowed))))

def decodePolicy (bs : List UInt8) : Option Policy :=
  match getU64 bs with
  | none => none
  | some (b, r1) =>
    match getU64 r1 with
    | none => none
    | some (t, r2) =>
      match getU64 r2 with
      | none => none
      | some (d, r3) =>
        match getU64 r3 with
        | none => none
        | some (l, r4) =>
          match getAccounts maxAccounts r4 with
          | some accs => some ⟨b, t, d, l, accs⟩
          | none => none

/-! ## Minimal flat-JSON subset -/

def isWs (b : UInt8) : Bool := decide (b = 32) || decide (b = 9) || decide (b = 10) || decide (b = 13)

def skipWs : List UInt8 → List UInt8
  | [] => []
  | b :: bs => if isWs b then skipWs bs else b :: bs

/-- Expect byte `c` after optional whitespace. -/
def expectByte (c : UInt8) (bs : List UInt8) : Option (List UInt8) :=
  match skipWs bs with
  | b :: r => if decide (b = c) then some r else none
  | [] => none

/-- String body after the opening quote, up to the closing quote. Escapes and
control bytes are rejected: account ids and decimal amounts never need them. -/
def strBody : List UInt8 → Option (List UInt8 × List UInt8)
  | [] => none
  | b :: r =>
    if decide (b = 34) then some ([], r)
    else if decide (b = 92) || b < 32 then none
    else
      match strBody r with
      | some (s, r') => some (b :: s, r')
      | none => none

def jsonString (bs : List UInt8) : Option (List UInt8 × List UInt8) :=
  match expectByte 34 bs with
  | some r => strBody r
  | none => none

/-- `"key" : "value"` → `(key, value, rest)`. -/
def member (bs : List UInt8) : Option (List UInt8 × List UInt8 × List UInt8) :=
  match jsonString bs with
  | none => none
  | some (k, r1) =>
    match expectByte 58 r1 with
    | none => none
    | some r2 =>
      match jsonString r2 with
      | some (v, r3) => some (k, v, r3)
      | none => none

/-- The largest `acc` with `10 * acc + 9 < 2^64` is `1844674407370955160`; at
`acc = 1844674407370955161` only digits `≤ 5` fit. -/
def digitsAux : UInt64 → List UInt8 → Option UInt64
  | acc, [] => some acc
  | acc, b :: bs =>
    if b < 48 || 57 < b then none
    else
      if 1844674407370955161 < acc || (decide (acc = 1844674407370955161) && 53 < b) then none
      else digitsAux (acc * 10 + (b - 48).toUInt64) bs

/-- Non-empty decimal digit string → u64, `none` on overflow or a non-digit. -/
def parseAmount : List UInt8 → Option UInt64
  | [] => none
  | b :: bs => digitsAux 0 (b :: bs)

def keyTo : List UInt8 := [116, 111]
def keyAmount : List UInt8 := [97, 109, 111, 117, 110, 116]

def mkReq (toB amtB : List UInt8) : Option (Account × UInt64) :=
  if validAccount toB then
    match parseAmount amtB with
    | some a => some (toB, a)
    | none => none
  else none

/-- `{"to":"<account>","amount":"<u64>"}` (either key order) → `(to, amount)`. -/
def parseRequest (bs : List UInt8) : Option (Account × UInt64) :=
  match expectByte 123 bs with
  | none => none
  | some r0 =>
    match member r0 with
    | none => none
    | some (k1, v1, r1) =>
      match expectByte 44 r1 with
      | none => none
      | some r2 =>
        match member r2 with
        | none => none
        | some (k2, v2, r3) =>
          match expectByte 125 r3 with
          | none => none
          | some r4 =>
            match skipWs r4 with
            | _ :: _ => none
            | [] =>
              if accEq k1 keyTo && accEq k2 keyAmount then mkReq v1 v2
              else if accEq k1 keyAmount && accEq k2 keyTo then mkReq v2 v1
              else none

/-! ### Policy JSON (for `set_policy`) -/

def keyBudget : List UInt8 := [98, 117, 100, 103, 101, 116]
def keyPerTx : List UInt8 := [112, 101, 114, 95, 116, 120]
def keyPerDay : List UInt8 := [112, 101, 114, 95, 100, 97, 121]
def keyDayNs : List UInt8 := [100, 97, 121, 95, 110, 115]
def keyAllowed : List UInt8 := [97, 108, 108, 111, 119, 101, 100]

/-- `"key":"<u64>"` with a fixed key. -/
def numField (key : List UInt8) (bs : List UInt8) : Option (UInt64 × List UInt8) :=
  match member bs with
  | none => none
  | some (k, v, r) =>
    if accEq k key then
      match parseAmount v with
      | some x => some (x, r)
      | none => none
    else none

/-- `, "key":"<u64>"`. -/
def numFieldC (key : List UInt8) (bs : List UInt8) : Option (UInt64 × List UInt8) :=
  match expectByte 44 bs with
  | some r => numField key r
  | none => none

/-- Items of a string array after `[`: `"a", "b" ]`. -/
def strItems : Nat → List UInt8 → Option (List Account × List UInt8)
  | 0, _ => none
  | fuel + 1, bs =>
    match jsonString bs with
    | none => none
    | some (s, r) =>
      if validAccount s then
        match skipWs r with
        | [] => none
        | b :: r' =>
          if decide (b = 44) then
            match strItems fuel r' with
            | some (ss, r'') => some (s :: ss, r'')
            | none => none
          else if decide (b = 93) then some ([s], r')
          else none
      else none

/-- `[ "a", ... ]` (possibly empty) of valid account ids, at most `maxAccounts`. -/
def strArray (bs : List UInt8) : Option (List Account × List UInt8) :=
  match expectByte 91 bs with
  | none => none
  | some r =>
    match skipWs r with
    | [] => none
    | b :: r' => if decide (b = 93) then some ([], r') else strItems maxAccounts (b :: r')

def parsePolicyJson (bs : List UInt8) : Option Policy :=
  match expectByte 123 bs with
  | none => none
  | some r0 =>
    match numField keyBudget r0 with
    | none => none
    | some (b, r1) =>
      match numFieldC keyPerTx r1 with
      | none => none
      | some (t, r2) =>
        match numFieldC keyPerDay r2 with
        | none => none
        | some (d, r3) =>
          match numFieldC keyDayNs r3 with
          | none => none
          | some (l, r4) =>
            match expectByte 44 r4 with
            | none => none
            | some r5 =>
              match jsonString r5 with
              | none => none
              | some (k, r6) =>
                if accEq k keyAllowed then
                  match expectByte 58 r6 with
                  | none => none
                  | some r7 =>
                    match strArray r7 with
                    | none => none
                    | some (accs, r8) =>
                      match expectByte 125 r8 with
                      | none => none
                      | some r9 =>
                        match skipWs r9 with
                        | [] => some ⟨b, t, d, l, accs⟩
                        | _ :: _ => none
                else none

/-! ## Verdict codes -/

/-- One ASCII letter per verdict. -/
def Verdict.tag : Verdict → UInt8
  | .allow => 65         -- 'A'
  | .denyBudget => 66    -- 'B'
  | .denyPerTx => 84     -- 'T'
  | .denyDaily => 68     -- 'D'
  | .denyReceiver => 82  -- 'R'
  | .denyOverflow => 79  -- 'O'

/-- Short ASCII code, prepended to `rest`. -/
def Verdict.putCode (v : Verdict) (rest : List UInt8) : List UInt8 :=
  match v with
  | .allow => 79 :: 75 :: rest                                                   -- OK
  | .denyBudget => 68 :: 69 :: 78 :: 89 :: 95 :: 66 :: 85 :: 68 :: 71 :: 69 :: 84 :: rest -- DENY_BUDGET
  | .denyPerTx => 68 :: 69 :: 78 :: 89 :: 95 :: 80 :: 69 :: 82 :: 95 :: 84 :: 88 :: rest  -- DENY_PER_TX
  | .denyDaily => 68 :: 69 :: 78 :: 89 :: 95 :: 68 :: 65 :: 73 :: 76 :: 89 :: rest        -- DENY_DAILY
  | .denyReceiver =>
    68 :: 69 :: 78 :: 89 :: 95 :: 82 :: 69 :: 67 :: 69 :: 73 :: 86 :: 69 :: 82 :: rest     -- DENY_RECEIVER
  | .denyOverflow =>
    68 :: 69 :: 78 :: 89 :: 95 :: 79 :: 86 :: 69 :: 82 :: 70 :: 76 :: 79 :: 87 :: rest     -- DENY_OVERFLOW

def errPolicy : List UInt8 := [69, 69, 82, 82, 95, 80, 79, 76, 73, 67, 89]  -- 'E' ERR_POLICY
def errState : List UInt8 := [69, 69, 82, 82, 95, 83, 84, 65, 84, 69]       -- 'E' ERR_STATE
def errInput : List UInt8 := [69, 69, 82, 82, 95, 73, 78, 80, 85, 84]       -- 'E' ERR_INPUT

/-! ## The contract call, on byte lists -/

/-- Decode policy, state and request; run `step`; encode
`tag ‖ newState ‖ code`. -/
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
        match step p s now to amount with
        | (v, s') => Verdict.tag v :: putState s' (Verdict.putCode v [])

/-! ## ByteArray boundary and exports -/

/-- `ByteArray` → byte list (reads with in-bounds `get!`, small `Nat` index). -/
def ofBytesAux (a : ByteArray) : Nat → List UInt8 → List UInt8
  | 0, acc => acc
  | n + 1, acc => ofBytesAux a n (a.get! n :: acc)

def ofBytes (a : ByteArray) : List UInt8 := ofBytesAux a a.size []

def pushAll : List UInt8 → ByteArray → ByteArray
  | [], acc => acc
  | b :: bs, acc => pushAll bs (acc.push b)

def toBytes (l : List UInt8) : ByteArray := pushAll l (ByteArray.emptyWithCapacity 64)

/-- Contract `pay`: policy bytes, state bytes, JSON args, `block_timestamp` → output. -/
@[export near_policy_decide]
def decideExport (policy state input : ByteArray) (now : UInt64) : ByteArray :=
  toBytes (decideList (ofBytes policy) (ofBytes state) (ofBytes input) now)

/-- `1` iff the policy bytes decode. -/
@[export near_policy_validate]
def validateExport (policy : ByteArray) : UInt8 :=
  match decodePolicy (ofBytes policy) with
  | some _ => 1
  | none => 0

/-- `1` iff `new` is a tightening of `old`, `0` if not, `2` if either fails to decode. -/
@[export near_policy_tighten]
def tightenExport (old new : ByteArray) : UInt8 :=
  match decodePolicy (ofBytes old) with
  | none => 2
  | some p =>
    match decodePolicy (ofBytes new) with
    | none => 2
    | some p' => if tighten p p' then 1 else 0

/-- Policy JSON → policy storage bytes (empty on parse error). -/
@[export near_policy_from_json]
def policyFromJsonExport (input : ByteArray) : ByteArray :=
  match parsePolicyJson (ofBytes input) with
  | some p => toBytes (encodePolicy p)
  | none => ByteArray.emptyWithCapacity 0

/-- Fresh state: nothing spent, window starts at `now`. -/
@[export near_policy_init_state]
def initStateExport (now : UInt64) : ByteArray := toBytes (encodeState ⟨0, 0, now, 0⟩)

end Wallet.Wire
