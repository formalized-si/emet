# Residuals: what is not proved, and deliberate deviations

All theorems listed in `Axioms.lean` are `sorry`-free and use only `propext`,
`Classical.choice` and `Quot.sound`. Many of the small-closure proofs use `propext`
alone. Each item below is either a statement that we left unproved or a
deliberate design limit. No claim of "proved" hides any item here.

## Spec deviations

1. **Accounts are `List UInt8`, not `List String`.** The wasm Lean runtime,
   `lean_near_rt.c`, has no String primitives (`lean_string_eq_cold`,
   `lean_string_from_utf8`, ...). It also has no closures and no linked Init code.
   NEAR account ids are ASCII, so byte lists are exact. The parser rejects anything
   outside `[a-z0-9._-]{2,64}`.
2. **`tighten` requires an equal `dayLength`.** A window starts at the first
   spend after expiry, so policies with different window lengths drift apart.
   The check therefore reports a change of the window as "not a tightening", even
   if the new window is stricter. This choice is conservative.
3. **Deny writes nothing.** The day roll and the nonce bump happen only on allow
   (`step_deny_preserves`). The next call computes the roll again from `dayStart`,
   so the state loses no information.

## Not proved (tested instead)

4. **ByteArray boundary.** We did not prove `ofBytes`/`toBytes` (ByteArray to and
   from `List UInt8`). `#guard` and the wasm self-test test it.
5. **JSON request grammar.** `parseAmount_sound` proves that the parsed amount is the
   true decimal value with no wrap. We did not prove that `parseRequest` accepts the
   documented grammar and nothing else. 14 `#guard` cases test it (overflow, sign,
   empty, non-digit, uppercase, short id, escape, extra bytes at the end, duplicate
   key, key order, whitespace).
6. **Policy JSON parser.** `parsePolicyJson` has tests and no proof. It accepts one
   key order only.
7. **Compiled-code agreement.** The theorems are about the Lean definitions. We trust
   Lean's compiler (LCNF to C), the `lean.h` inline functions and clang/wasm-ld, and
   we did not verify them. The same holds for `lean_near_rt.c`, `c/policy_rt_extra.c`
   (`lean_byte_array_push`) and the NEAR C shim. `wasmcheck.sh` runs the compiled wasm
   under node on 8 scenarios and matches the Lean `#eval` results. That is evidence,
   not proof.

## True limits of the policy (proved properties are exactly these)

8. **The daily cap is a tumbling window, not a sliding 24h.** We proved four properties:
   - The window rolls if and only if `now ≥ dayStart + dayLength` in ℕ (`expired_iff`).
   - The payment that triggers the roll counts in the new window (`step_allow_rolled`).
   - `spentToday ≤ perDayCap` always holds (`run_daily_inv`).
   - Inside one window, the allowed total is at most `perDayCap` (`no_bypass_daily`).

   This statement is not true: "any 24h interval spends ≤ perDayCap". `Examples.lean`
   shows 999 units spent within 1 ns against a cap of 500, across a boundary. Every
   tumbling window allows this, calendar-aligned ones included. The total spent can
   reach `2 × perDayCap` in any interval of length `dayLength`. A true sliding bound
   needs a design change: for example, store the total of the previous window and
   require `prev + cur + amount ≤ perDayCap`. The lifetime budget holds regardless.
9. **Sequence form of tightening.** `tighten_run_sound` is about a replay of the
   requests that `p'` accepted, under `p`. The replay accepts them all and reaches
   the same state. A stronger claim is false: that `p` accepts every request that
   `p'` accepts in the same run. A looser `p` can spend budget on a request that `p'`
   rejects, and then deny a later request that `p'` accepts.
10. **We trust the time.** `now` is NEAR `block_timestamp`. A clock that runs backwards
    never rolls the window. `dayLength = 0` rolls on every call, which reduces the
    daily cap to the per-tx cap.
11. **Nonce exhaustion.** After `2^64 - 1` allowed payments every request returns
    `denyOverflow` (fails closed). This is unreachable in practice.
12. **Stack depth.** `strBody` recursion depth equals the JSON string length. The C
    shim must cap the input size, for example at 1 KiB. An oversize input can at worst
    trap the wasm, which aborts the transaction with no state write.
13. **Gas.** We did not measure gas here. The recorded runs have the gas of each call
    (`evidence/demo/scenario.json`).

## Proof-closure size (lean4export)

The transaction cap is 1.5 MiB, which is 1,572,864 bytes.

14. **The statement floor is 0.67 MB.** That is the size of `Spec.NoBypassSequence`,
    and `step` is 0.63 MB. Most of it is the UInt64 literal and arithmetic machinery
    (`OfNat` to `Nat.mod`, about 0.45 MB). We removed two traps:
    - UInt8 `==` (BEq) costs 2.3 MB, so Core and Wire use `decide (a = b)`, which
      compiles to the same C.
    - A wildcard match arm compiles to a sparse `casesOn` on `Nat.hasNotBit`, about
      0.6 MB. `accEq`, `allowedSum` and `acceptedReqs` now use exhaustive patterns.
15. **`Policy.SmallProofs` proves all nine `Spec` claims at 0.77 to 1.36 MB each,**
    with no omega. The pinned base is the export of `Spec.NoBypassSequence` together
    with the 96 roots in `out/base_roots_noBypassSequence.txt`. That base is 1.03 MB
    and is a byte-exact prefix. The small proof of `noBypassSequence` then adds 265 KB
    (5,721 lines, 28 declarations).
16. **`Policy.Proofs` (omega-based) costs 6.6 to 7.0 MB per theorem.** Each carries
    175 `Lean.Omega` declarations, inherited from `step_cases`. Init's
    `UInt64.toNat_sub_of_le` alone is 4.4 MB, because its proof uses omega.
17. **Not shrunk.** We did not shrink `tighten_run_sound` and `step_allow_iff` (6.6 to
    6.9 MB). We did not shrink the Wire proofs either: the round-trips and
    `parseAmount_sound` are 5.0 to 5.6 MB, with omega in `combine8_bytes` and
    `digit_step`. `decideList_spec` is 1.58 MB, over the cap by a small margin,
    because of Wire's wildcard arms.
