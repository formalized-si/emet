# kernel: a Lean 4 proof checker inside a NEAR contract

The contract runs `nanoda_lib`, an independent Rust implementation of the Lean 4 kernel, compiled
to wasm. It checks one proof per call against a **sealed environment**, which the method names call
the **base**. The base is a fixed lean4export export. The owner loads it in chunks and seals it by its
sha256 and its declaration count. The contract type-checks it on-chain before it accepts any proof. A
submitter sends only the **delta**: the declarations after the base.

This build (`artifacts/kernel.wasm`) runs on NEAR testnet as `kernel.v2.emet.testnet`. That account holds
the sealed environment of the refund case and has no access key. `python3 tools/check_live.py` compares
its code hash with the hash of that binary. It is not on mainnet.

`./verify.sh --rehearse` deploys the same binary on a local node. Read the state with the free view
`status()`. [`PATCHES.md`](PATCHES.md) lists the changes to nanoda_lib.

## What a verdict means

`ok: true` means two things. Every declaration in the delta type-checks against the sealed base. The
delta contains a theorem whose type is the claimed statement itself. In any other case the result
carries a reason:

| reason | cause |
|---|---|
| `sorryAx` | the proof uses `sorry` |
| `axiom_in_delta:<kind> <name>` | the delta declares an axiom, an opaque or a quotient |
| `redefines_base_name:<name>` | the delta redeclares a base name, for example a fake `axiom propext : False` |
| `builtin_name_in_delta:<name>` | the delta declares a name the checker computes by itself (`Nat.gcd`, `String` and the rest of `BUILTIN_NAMES`); it would otherwise prove `False` on an environment that does not declare that name |
| `not_a_theorem:<detail>` | the named constant is not a theorem |
| `statement_mismatch:<detail>` | no theorem in the delta has the claimed type itself |
| `malformed:<detail>` | the delta does not parse |
| `base_not_sealed` | the base has no seal yet |

The first three come from a scan of the delta alone, before parsing. A kernel type error is a panic,
because wasm cannot catch it under `panic=abort`. The board records it as `kernel_failed`.

## Methods

| method | args | result |
|---|---|---|
| `check_result_raw()` | raw `<theorem_name>\n<delta>` | `CheckResult` (the method that a board calls) |
| `check_result(theorem_name, delta)` | JSON | `CheckResult` |
| `check(theorem_name, delta)` | JSON | `CheckResult`; panics `rejected:<reason>` on a rejection |
| `check_borsh(statement_name, export)` | Borsh | v1 verdict `{"Accepted":{..}}` / `{"Rejected":{"reason"}}` |
| `dry_run(theorem_name, delta)` | JSON, view | `CheckResult` at no gas cost |
| `statement_of(theorem_name, delta)` | JSON, view | the pretty-printed declaration |
| `status()`, `kernel_name()` | view | base hash, sealed flag, stored bytes |
| `init`, `load_base_chunk`, `seal_base`, `check_base_range` | owner / anyone | the staged base lifecycle |

The ABI is in [`abi/kernel_abi.json`](abi/kernel_abi.json).

## Files

| path | what |
|---|---|
| `src/lib.rs` | the contract, with its tests (`cargo test --release`: the sealed wallet environment of `shelf/wallet-v5`, and the invalid proofs of `cheats/deltas`) |
| `vendor/nanoda_lib/` | nanoda_lib 0.4.32 (Apache-2.0, upstream commit 0da9f98) with `vendor/nanoda_lib.PATCH.diff` applied. That file is the complete diff, see `PATCHES.md` |
| `abi/kernel_abi.json` | the contract's ABI |

Each case exports and packs its own environment. `cases/intents-refund/export.sh` does it for the refund
case, and `tools/measure_nearspec.sh` for NEAR Proof Arena's relation. `tools/pack_base.py` makes the chunks.
The deployment scripts (`deploy/`) upload, seal and type-check the environment. They delete the account's
only key in the transaction that deploys the contract.

## Build

```sh
tools/near_build.sh contracts/kernel    # from the repository root; the same bytes on macOS arm64 and Linux x86_64
```

`./verify.sh --lean` rebuilds it and compares it with `artifacts/kernel.wasm` byte for byte.
[docs/REPRODUCIBLE-BUILDS.md](../../docs/REPRODUCIBLE-BUILDS.md) explains what makes the build independent of
the host.
