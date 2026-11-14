# Reproducible builds

The seven Rust-built binaries in `artifacts/` rebuild to the same bytes on macOS arm64 and on Linux x86_64:

| Binary | sha256, on both hosts |
| --- | --- |
| `kernel.wasm` | `7ee260a5cc328adca6e216393f2dfdd887bdc82ad3ea23856b278a4c77057af6` |
| `board.wasm` | `bd4c84594c4ce8732bfe5f3f65e5181d0092b8af6b8f2080b2b0631bf6005d09` |
| `factory.wasm` | `6dcec734db23cddb2341d281886686339e216d8b3de4208e1010460459dd4ce7` |
| `refund/gate.wasm` | `259301010dd6ef744c66785cd77cceecdaadfc764446ad179036ccc9d348c06d` |
| `refund/old.wasm` | `ef7346022ea75975d584362ce0aba0b8f2b5eae010088c958142b7edf14afdac` |
| `refund/fixed.wasm` | `f24d072edcb76a81ef68471096b1e7756b948e5543f739421c71f20bfb6e0ce0` |
| `refund/receiver.wasm` | `89a2a72174da01ae8ee0c9341ebdb92d084b47225a09c0bb0b216e55e1d630f4` |

`./verify.sh --lean` rebuilds kernel, board, factory and the gate, and compares them with these files.
`./verify.sh --refund` does the same for the three builds of NEAR Intents code. `tools/near_build.sh` and
`cases/intents-refund/build.py` are the two places that build. The gate's deployer pairs a patched source file
with a binary hash. The chain does not check that pairing. With a reproducible build, anyone can check it.

## Why the default build is not reproducible

The table shows the default cargo-near build of one source tree on three hosts. We measured it on 12 November 2026, before we replaced the binaries in `artifacts/` with reproducible ones:

| Binary | macOS arm64 | Linux, toolchain image | Linux, `ubuntu:24.04` |
| --- | --- | --- | --- |
| `kernel.wasm` | `cc11c25e5dd3e2d2…` | `e33b647d85fd0d8d…` | `e33b647d85fd0d8d…` |
| `board.wasm` | `15b4d78c3cf94f34…` | `f74e78acfda3bf1b…` | `f74e78acfda3bf1b…` |
| `factory.wasm` | `cd2363a9120c5eec…` | `cf34a3d5d606f0c6…` | `cf34a3d5d606f0c6…` |
| `refund/old.wasm` | `e5c5acc0aa7e37f2…` | `9035b365003e4dfc…` | `ddad16331cbe4272…` |
| `refund/fixed.wasm` | `2ffbce8f0c0e4d6e…` | `2a4906c0bce765e7…` | `0be6c975743a4308…` |
| `refund/receiver.wasm` | `2dbfcd2bb3e56284…` | `5bba075bcd07dbeb…` | `138a96898db02d11…` |
| `refund/gate.wasm` | `1ccbe0a5253b18de…` | `1374847e5691da33…` | `5ec3531e31b9c574…` |
| `wallet.wasm` | `21e30c4fb0667650…` | `5c15b517294ed7cf…` | `5c15b517294ed7cf…` |
| `wallet-v2.wasm` | `51e19e26ce9b7a91…` | `b9fbe02537cf961a…` | `b9fbe02537cf961a…` |

For kernel, board and factory, the image column shows a build with the registry outside the repository.
`verify.sh` runs the image with the registry inside the repository. That default build gives a third
set: `f8e80b62…`, `3f2b7df9…`, `cb7cb174…`.

A diff of the builds showed two causes.

1. **Absolute paths.** Panic messages name the source files of registry crates. The build of the four
   refund binaries did not remap the registry, so they contained the home directory of the build user.
   `strings artifacts/refund/old.wasm | grep -c /Users/` gives 61 for old, and the same count gives 61
   for fixed, 31 for receiver and 24 for gate. Such binaries differ on every machine, and on another Mac
   too.

   Kernel, board and factory remap `$HOME/.cargo/registry/src`. That works while the registry is
   there and outside the repository. That rule does not read `CARGO_HOME`. If the registry is inside the
   repository, the later rule `$ROOT=/build` wins, because rustc applies the last rule that matches.

2. **The build host in the symbol hashes.** With equal paths, the binaries still differed between macOS
   and Linux. They had the same size, the same section sizes and the same functions in another order.
   For factory, 4,427 of 189,684 bytes differ before wasm-opt, none of them in the data section.

   Cargo passes every crate a `-C metadata` hash. Then rustc mixes it into symbol hashes, and symbol
   hashes decide the order of functions. For a wasm32 crate, cargo leaves the host out of the crate's own
   part of that hash. It still mixes in the hashes of all dependencies. Proc macros and build scripts are
   host crates, and their hash includes the `host:` line of `rustc -vV`. The code is `compute_metadata`
   and `hash_rustc_version` in cargo's `compilation_files.rs`, tag `rust-1.98.0`.

   For the board contract, 22 of the 37 wasm32 crates got the same `-C metadata` on both hosts
   (`cfg-if`, `hex`, `bs58`, `memchr`, ...). Each of the other 15 has a proc macro or a build script
   among its dependencies (`near-sdk`, `borsh`, `serde`, `serde_json`, `wee_alloc`, ...).

Two Linux machines agree with each other for kernel, board, factory and the wallets. This shows that the
compiler itself is deterministic. Only the host triple and the paths separate the results.

Nothing that `cargo near build non-reproducible-wasm` adds depended on the host:

- It embeds the ABI that it generates from a host build. `target/near/*_abi.zst` has the same sha256 on
  both hosts, also in the default build.
- It runs its `wasm-opt -O` pass.
- It writes the NEP-330 values: version and link. It adds build details only in its Docker mode.

We therefore did not need a plain `cargo build` plus the same post-processing, and that build drops the
embedded ABI. We did not use cargo-near's own `reproducible-wasm` mode. It builds inside a builder image,
which on a Mac means emulation. We read its source: it wants the source committed and pushed first.

## What the reproducible build does

The reproducible build does two things and nothing else. It is the default. `EMET_REPRO=0` gives the
build described above.

- It sets `tools/rustc_stable_metadata.sh` as `RUSTC_WRAPPER`. The wrapper replaces cargo's
  `-C metadata` value for wasm32 crates only. The new value is the package name and version, the crate
  name and type, and the enabled cfgs. Host crates and every other argument pass through unchanged.
- It passes `--remap-path-prefix` for the repository, `$CARGO_HOME/git/checkouts` and
  `$CARGO_HOME/registry/src`, in that order.

Two scripts read the variable: `tools/near_build.sh` for kernel, board, factory and gate, and
`cases/intents-refund/build.py` for old, fixed and receiver. Through them, `tools/build_wasm.sh`,
`verify.sh --refund`, `verify.sh --lean` and `propose.py` use it too. A change of the variable changes
`RUSTFLAGS`, so cargo rebuilds. The two modes cannot mix in one target directory.

## The two wallet binaries

We did not change these two binaries and did not investigate them further. They are Lean, compiled to C
and then to wasm by Lean's own clang. The Linux build is the same on two Linux machines and differs from
the committed Mac build. The two builds have the same size (75,312 bytes) and the same section sizes, and
46,708 bytes differ. The embedded toolchain string names the platform: `arm64-apple-darwin24.6.0` against
`x86_64-unknown-linux-gnu`, the same length. So that string is not the whole difference.

`contracts/wallet/lean-near/lean-near` collects the C files with `os.walk` and does not sort them. The
link order can thus follow the file system. We did not test that. `./verify.sh --lean` on Linux reports
the two wallets as `note` and does not fail.

## Limits

- We measured these seven binaries and one caller-supplied patch, with this compiler and the builds
  listed above. We did not try other hosts.
- The wrapper gives two crates the same metadata only if they have the same package name, version,
  crate name, crate type and cfgs. Two different sources of one name and version in one build then
  collide. Then rustc reports an error and does not pick one of the two. That case does not occur in
  these trees.
- The Rust compiler, cargo-near and its wasm-opt remain trusted, as before. The wrapper is about 15
  lines of shell in the build path. `propose.py` already fingerprints `tools/`.
- On macOS the wrapper sets `DYLD_FALLBACK_LIBRARY_PATH` to the toolchain's `lib` directory. `/bin/sh`
  drops that variable, and rustc's linker needs it.
