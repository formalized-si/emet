#!/usr/bin/env bash
# Rebuild the contract binaries from source and compare them with artifacts/.
#   tools/build_wasm.sh            build into run-output/repro and compare (exit 1 on any difference)
#   tools/build_wasm.sh --install  build and copy over artifacts/ (maintainers; on macOS arm64, because of the wallets)
#   EMET_REPRO=0 tools/build_wasm.sh   the earlier Rust build, whose output depends on the host, into run-output/wasm
# Kernel, board, factory and the patch gate: Rust 1.98.0 (rust-toolchain.toml), cargo-near 0.22.0, wasm32, built by
# tools/near_build.sh so that the bytes do not depend on the host, on where the repository is or on where the
# cargo registry is.
# Wallets (v1, and v2 = the same shim with -DWALLET_RULES_V2): lean-near with Lean 4.35.0; its get_code_meta embeds the Lean toolchain string, which names
# the build platform, so the wallet reproduces byte for byte on the same platform (macOS arm64 here).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
REPRO="${EMET_REPRO:-1}"
OUT=run-output/wasm; [ "$REPRO" != 1 ] || OUT=run-output/repro; mkdir -p "$OUT"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
command -v cargo-near >/dev/null || { echo "needs cargo-near 0.22.0: cargo install cargo-near --version 0.22.0 --locked"; exit 2; }
build_rust() {   # $1 = crate dir, $2 = wasm name in target/near, $3 = its name in $OUT
  tools/near_build.sh "$1" \
     --env "RUSTFLAGS=-C link-arg=-s --remap-path-prefix=$HOME/.cargo/registry/src=/cargo-registry --remap-path-prefix=$HOME/.cargo/git/checkouts=/cargo-git --remap-path-prefix=$ROOT=/build" \
     >"$OUT/build-$3.log" 2>&1 || { tail -30 "$OUT/build-$3.log"; echo "build failed in $1 (full log: $OUT/build-$3.log)"; exit 1; }
  cp "$1/target/near/$2" "$OUT/$3"
}
build_rust contracts/kernel kernel.wasm kernel.wasm
build_rust contracts/board proof_courier_board.wasm board.wasm
build_rust contracts/factory proof_courier_factory.wasm factory.wasm
[ "$REPRO" != 1 ] || build_rust contracts/patch-gate emet_patch_gate.wasm gate.wasm
python3 contracts/wallet/lean-near/lean-near build lean --entry contracts/wallet/near_entry.c --out "$OUT/wallet.wasm" >/dev/null
python3 contracts/wallet/lean-near/lean-near build lean --entry contracts/wallet/near_entry.c --define WALLET_RULES_V2 --out "$OUT/wallet-v2.wasm" >/dev/null
# The wallets were built on macOS arm64; elsewhere their bytes differ (the Lean toolchain string in the
# wallet names the platform), so a difference there is reported, not failed. The Rust binaries do not depend
# on the host, so a difference in them fails on every host (with EMET_REPRO=0: on macOS arm64 only).
reference=no; [ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] && reference=yes
rc=0
if [ "$REPRO" = 1 ]; then
  if [ "$(sha "$OUT/gate.wasm")" = "$(sha artifacts/refund/gate.wasm)" ]; then echo "ok   refund/gate.wasm rebuilt from source, byte for byte: $(sha "$OUT/gate.wasm" | cut -c1-16)…"
  else echo "DIFF refund/gate.wasm: rebuilt $(sha "$OUT/gate.wasm" | cut -c1-16)…, artifact $(sha artifacts/refund/gate.wasm | cut -c1-16)… (verify.sh --refund installs it, not this script)"; [ "${1:-}" = "--install" ] || rc=1; fi
fi
for f in kernel.wasm board.wasm factory.wasm wallet.wasm wallet-v2.wasm; do
  strict=$reference; case "$REPRO:$f" in 1:kernel.wasm|1:board.wasm|1:factory.wasm) strict=yes ;; esac
  if [ "${1:-}" = "--install" ]; then
    cp "$OUT/$f" "artifacts/$f"
    case "$f" in wallet*.wasm) cp "$OUT/$f.meta.json" artifacts/;; esac
    echo "installed $f from source: $(sha "$OUT/$f" | cut -c1-16)…"
    continue
  fi
  if [ "$(sha "$OUT/$f")" = "$(sha "artifacts/$f")" ]; then echo "ok   $f rebuilt from source, byte for byte: $(sha "$OUT/$f" | cut -c1-16)…"
  elif [ $strict = yes ]; then echo "DIFF $f: rebuilt $(sha "$OUT/$f" | cut -c1-16)…, artifact $(sha "artifacts/$f" | cut -c1-16)…"; rc=1
  else
    why="the wallet embeds the Lean toolchain's platform string"; case "$f" in wallet*) ;; *) why="with EMET_REPRO=0 the Rust build depends on the build host, see docs/REPRODUCIBLE-BUILDS.md" ;; esac
    echo "note $f: built here as $(sha "$OUT/$f" | cut -c1-16)…; the artifact ($(sha "artifacts/$f" | cut -c1-16)…) reproduces byte for byte on macOS arm64 only ($why)"
  fi
done
(cd "$OUT" && for f in *.wasm; do echo "$(sha "$f")  $f"; done > SHA256SUMS)
if [ "${1:-}" = "--install" ]; then (cd artifacts && for f in kernel.wasm board.wasm factory.wasm wallet.wasm wallet-v2.wasm; do echo "$(sha "$f")  $f"; done > SHA256SUMS); fi
exit $rc
