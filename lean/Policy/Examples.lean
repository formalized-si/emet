import Policy.Wire
import Policy.CoreV2
/-!
# Policy.Examples — `#eval` demos and `#guard` regression checks

Not part of the contract: this module may use `String`, `Repr`, etc.
Every `#guard` is checked by `lake build`, so a behaviour change breaks the build.
-/
namespace Wallet.Examples
open Wallet Wallet.Wire

deriving instance Repr for Verdict
deriving instance Repr for State
deriving instance DecidableEq for State
deriving instance DecidableEq for Policy

/-- Account id from a string literal (examples only). -/
def acct (s : String) : Account := s.toUTF8.toList

/-- Bytes → text, for printing. -/
def txt (l : List UInt8) : String := (String.fromUTF8? (ByteArray.mk l.toArray)).getD "<non-utf8>"

def alice := acct "alice.testnet"
def bob := acct "bob.testnet"
def mallory := acct "mallory.testnet"

def DAY : UInt64 := 86_400_000_000_000  -- 1 day in ns

/-- budget 1000, ≤ 300 per payment, ≤ 500 per day, pay only alice and bob. -/
def demo : Policy :=
  { budgetTotal := 1000, perTxCap := 300, perDayCap := 500, dayLength := DAY,
    allowed := [alice, bob] }

def s0 : State := ⟨0, 0, 0, 0⟩

/-! ## Single decisions -/

-- allow
#eval step demo s0 1 alice 200
#guard (step demo s0 1 alice 200).1 = .allow
#guard (step demo s0 1 alice 200).2 = ⟨200, 200, 0, 1⟩

-- per-tx deny (state untouched)
#eval step demo s0 1 alice 301
#guard step demo s0 1 alice 301 = (.denyPerTx, s0)

-- receiver deny
#eval step demo s0 1 mallory 1
#guard step demo s0 1 mallory 1 = (.denyReceiver, s0)

-- empty allowlist denies everything
#guard (step { demo with allowed := [] } s0 1 alice 1).1 = .denyReceiver

/-! ## Daily cap, then a day roll -/

def dayRun : List Req :=
  [(1, alice, 200), (2, bob, 300), (3, alice, 1),          -- 500 today, then deny
   (DAY + 1, alice, 300)]                                  -- next window: allowed

#eval run demo s0 dayRun
#guard (run demo s0 dayRun).2 = [.allow, .allow, .denyDaily, .allow]
#guard (run demo s0 dayRun).1 = ⟨800, 300, DAY + 1, 3⟩

/-! ## Residual made explicit: windows are anchored, not sliding

The day window starts at the first allowed spend after the previous one expired.
So `perDayCap` bounds each window, not every sliding 24h interval: spending the
cap at the end of one window and again at the start of the next is allowed. -/
#guard (run demo s0 [(0, alice, 1), (DAY - 1, alice, 299), (DAY - 1, bob, 200),
    (DAY, alice, 300), (DAY, bob, 200)]).2 = [.allow, .allow, .allow, .allow, .allow]
-- 999 spent between t = DAY-1 and t = DAY (1 ns), against perDayCap = 500.

/-! ## v2 (`Policy.CoreV2`): the same requests, with the old window's spending carried

At `t = DAY` the window rolls, but it started less than two days ago, so the 500 already spent
still counts: both payments that made v1 pay 999 within 1 ns are refused. After two quiet days
the old spending is dropped and the wallet pays again. -/
#guard (Wallet.V2.run demo s0 [(0, alice, 1), (DAY - 1, alice, 299), (DAY - 1, bob, 200),
    (DAY, alice, 300), (DAY, bob, 200)]).2 = [.allow, .allow, .allow, .denyDaily, .denyDaily]
#guard (Wallet.V2.run demo s0 [(0, alice, 1), (DAY - 1, alice, 299), (DAY - 1, bob, 200),
    (2 * DAY, alice, 300)]).2 = [.allow, .allow, .allow, .allow]
-- The cost: after a full day's spending, the payment that v1 allows right after the window
-- rolls waits until two days after the old window started.
#guard (Wallet.V2.run demo s0 dayRun).2 = [.allow, .allow, .denyDaily, .denyDaily]

-- A full cap followed by zero-value requests at each boundary can keep later payments blocked.
-- This refutes the old documentation's "up to two windows" availability claim.
#guard (Wallet.V2.run demo s0 [(0, alice, 300), (0, bob, 200),
    (DAY, alice, 0), (2 * DAY, alice, 0), (3 * DAY, alice, 1)]).2 =
  [.allow, .allow, .allow, .allow, .denyDaily]
#guard (Wallet.V2.run demo s0 [(0, alice, 300), (0, bob, 200),
    (3 * DAY, alice, 1)]).2 = [.allow, .allow, .allow]

/-! ## Lifetime budget across days -/

def budgetRun : List Req :=
  [(1, alice, 300), (2, alice, 200),                       -- day 1: 500
   (DAY + 1, bob, 300), (DAY + 2, bob, 200),               -- day 2: total 1000
   (2 * DAY + 3, alice, 1)]                                -- day 3: budget exhausted

#eval run demo s0 budgetRun
#guard (run demo s0 budgetRun).2 = [.allow, .allow, .allow, .allow, .denyBudget]
#guard (run demo s0 budgetRun).1.spentTotal = 1000

/-! ## Overflow attempt: amount = 2^64 - 1 -/

-- With normal caps the per-tx cap stops it first.
#eval step demo s0 1 alice U64MAX
#guard (step demo s0 1 alice U64MAX).1 = .denyPerTx

-- With every cap at 2^64-1, a naive `spent + amount ≤ budget` check would wrap
-- (1 + (2^64-1) = 0 in u64) and allow; `step` detects the overflow instead.
def wide : Policy :=
  { budgetTotal := U64MAX, perTxCap := U64MAX, perDayCap := U64MAX, dayLength := DAY,
    allowed := [alice] }
#eval ((1 : UInt64) + U64MAX)                 -- 0: what wrapping arithmetic would see
#guard ((1 : UInt64) + U64MAX) ≤ wide.budgetTotal
#eval step wide ⟨1, 1, 0, 0⟩ 1 alice U64MAX
#guard step wide ⟨1, 1, 0, 0⟩ 1 alice U64MAX = (.denyOverflow, ⟨1, 1, 0, 0⟩)

/-! ## Tightening -/

def tight : Policy := { demo with budgetTotal := 900, allowed := [alice] }
#guard tighten demo tight = true
#guard tighten tight demo = false
#guard tighten demo { demo with dayLength := DAY / 2 } = false

/-! ## Wire: request JSON -/

def req (s : String) := parseRequest s.toUTF8.toList

#eval req "{\"to\":\"alice.testnet\",\"amount\":\"1000\"}"
#guard req "{\"to\":\"alice.testnet\",\"amount\":\"1000\"}" = some (alice, 1000)
#guard req " { \"amount\" : \"7\" , \"to\" : \"bob.testnet\" } " = some (bob, 7)
#guard req "{\"to\":\"alice.testnet\",\"amount\":\"18446744073709551615\"}" = some (alice, U64MAX)
#guard req "{\"to\":\"alice.testnet\",\"amount\":\"18446744073709551616\"}" = none  -- > u64
#guard req "{\"to\":\"alice.testnet\",\"amount\":\"99999999999999999999\"}" = none
#guard req "{\"to\":\"alice.testnet\",\"amount\":\"-1\"}" = none
#guard req "{\"to\":\"alice.testnet\",\"amount\":\"\"}" = none
#guard req "{\"to\":\"alice.testnet\",\"amount\":\"12a\"}" = none
#guard req "{\"to\":\"Alice.testnet\",\"amount\":\"1\"}" = none                      -- uppercase
#guard req "{\"to\":\"a\",\"amount\":\"1\"}" = none                                  -- too short
#guard req "{\"to\":\"al\\\"ice\",\"amount\":\"1\"}" = none                          -- escape
#guard req "{\"to\":\"alice.testnet\",\"amount\":\"1\"} x" = none                   -- trailing
#guard req "{\"to\":\"alice.testnet\",\"to\":\"bob.testnet\"}" = none               -- dup key

/-! ## Wire: codecs -/

#guard decodeState (encodeState ⟨200, 200, 5, 1⟩) = some ⟨200, 200, 5, 1⟩
#guard decodeState (encodeState ⟨U64MAX, 0, U64MAX, 12345678901234567⟩) =
  some ⟨U64MAX, 0, U64MAX, 12345678901234567⟩
#guard decodeState [1, 2, 3] = none
#guard decodePolicy (encodePolicy demo) = some demo
#guard decodePolicy (encodePolicy wide) = some wide
#guard decodePolicy (encodePolicy { demo with allowed := [] }) = some { demo with allowed := [] }
#guard decodePolicy (encodePolicy { demo with allowed := [acct "Bad"] }) = none
#guard ofBytes (toBytes (encodePolicy demo)) = encodePolicy demo

def policyJson : String :=
  "{\"budget\":\"1000\",\"per_tx\":\"300\",\"per_day\":\"500\",\"day_ns\":\"86400000000000\"," ++
  "\"allowed\":[\"alice.testnet\",\"bob.testnet\"]}"
#guard parsePolicyJson policyJson.toUTF8.toList = some demo
#guard parsePolicyJson
  "{\"budget\":\"1\",\"per_tx\":\"1\",\"per_day\":\"1\",\"day_ns\":\"1\",\"allowed\":[]}".toUTF8.toList =
  some ⟨1, 1, 1, 1, []⟩

/-! ## Wire: the full contract call -/

def call (now : UInt64) (s : State) (json : String) : String :=
  let out := decideList (encodePolicy demo) (encodeState s) json.toUTF8.toList now
  match out with
  | t :: rest =>
    if t == 69 then txt out
    else
      match decodeState (rest.take 32) with
      | some s' => s!"{txt [t]} {repr s'} {txt (rest.drop 32)}"
      | none => "<bad output>"
  | [] => "<empty>"

#eval call 1 s0 "{\"to\":\"alice.testnet\",\"amount\":\"200\"}"
#eval call 1 s0 "{\"to\":\"mallory.testnet\",\"amount\":\"200\"}"
#eval call 1 s0 "{\"to\":\"alice.testnet\",\"amount\":\"oops\"}"
#guard (decideList (encodePolicy demo) (encodeState s0)
  "{\"to\":\"alice.testnet\",\"amount\":\"200\"}".toUTF8.toList 1).take 1 = [65]      -- 'A'
#guard txt ((decideList (encodePolicy demo) (encodeState s0)
  "{\"to\":\"alice.testnet\",\"amount\":\"200\"}".toUTF8.toList 1).drop 33) = "OK"
#guard txt (decideList (encodePolicy demo) (encodeState s0)
  "{\"to\":\"alice.testnet\",\"amount\":\"x\"}".toUTF8.toList 1) = "EERR_INPUT"
#guard txt (decideList [] (encodeState s0) [] 1) = "EERR_POLICY"
#guard txt (decideList (encodePolicy demo) [] [] 1) = "EERR_STATE"
#guard (List.map (fun v => txt (Verdict.putCode v []))
  [.allow, .denyBudget, .denyPerTx, .denyDaily, .denyReceiver, .denyOverflow]) =
  ["OK", "DENY_BUDGET", "DENY_PER_TX", "DENY_DAILY", "DENY_RECEIVER", "DENY_OVERFLOW"]

end Wallet.Examples
