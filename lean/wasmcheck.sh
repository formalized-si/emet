#!/usr/bin/env bash
# Compile the Lean policy (lake's C output) to wasm32 with the minimal NEAR Lean
# runtime, link a self-test entry, and run it under node. Exits non-zero on any
# missing runtime symbol or unexpected verdict.
set -euo pipefail
cd "$(dirname "$0")"
export PATH=$HOME/.elan/bin:$PATH
T=$(lean --print-prefix)
W=out/wasmcheck
RT=${LEAN_NEAR_RT:-../contracts/wallet/lean-near/rt/lean_near_rt.c}
mkdir -p $W/inc/lean $W/bin
cp $T/include/lean/lean.h $T/include/lean/version.h $W/inc/lean/
sed 's/^#define LEAN_MIMALLOC$/\/* no mimalloc *\//' $T/include/lean/config.h > $W/inc/lean/config.h
ln -sf $T/bin/ld.lld $W/bin/wasm-ld
cp "$RT" $W/lean_near_rt.c
lake build Policy.Wire
CC="$T/bin/clang --target=wasm32-unknown-unknown -mcpu=mvp -O2 -DNDEBUG -ffreestanding -nostdlib -isystem $T/include/clang -I$W/inc -B$W/bin"
$CC -c .lake/build/ir/Policy/Core.c -o $W/Core.o -Wno-unused-parameter
$CC -c .lake/build/ir/Policy/Wire.c -o $W/Wire.o -Wno-unused-parameter
$CC -c c/policy_rt_extra.c -o $W/policy_rt_extra.o
$CC -c c/selftest_entry.c -o $W/selftest_entry.o
$CC -fno-builtin -c $W/lean_near_rt.c -o $W/lean_near_rt.o
$CC $W/Core.o $W/Wire.o $W/selftest_entry.o $W/policy_rt_extra.o $W/lean_near_rt.o \
  -o $W/policy_selftest.wasm -Wl,--no-entry -Wl,--gc-sections -Wl,--strip-all \
  -Wl,-z,stack-size=262144 -Wl,--stack-first
ls -l $W/policy_selftest.wasm
node -e 'const m=new WebAssembly.Module(require("fs").readFileSync(process.argv[1]));console.log("imports:",JSON.stringify(WebAssembly.Module.imports(m)))' $W/policy_selftest.wasm
node c/selftest.mjs $W/policy_selftest.wasm | tee $W/selftest.out
# expected verdict sequence for scenarios 3..10
got=$(sed -n 's/^#\([0-9]*\) tag=\(.\).*/\2/p; s/^#\([0-9]*\) EERR_INPUT/E/p' $W/selftest.out | tr -d '\n')
[ "$got" = "ATRADTEA" ] && echo "SELFTEST OK ($got)" || { echo "SELFTEST FAIL: $got"; exit 1; }
