#!/usr/bin/env bash
# Rebuild everything that came from Lean and compare it byte for byte with what is committed:
#   1. lake build lean/: every definition and proof in the project is re-elaborated by Lean;
#   2. the shelf, re-exported from Policy.Spec with the pinned roots;
#   3. each agent proof (evidence/agent/*/Solution.lean), re-checked in a clean workspace and
#      re-exported as a delta;
#   4. the Lean-level and the forged cheats;
#   5. nanoda (the kernel the contract runs, built natively here) on shelf + each delta.
#   6. the kernel contract's unit test: its own run_check on the sealed shelf, with two forged recursor rules.
# Needs elan (Lean 4.35.0 is fetched by lean-toolchain), git, cargo. First run ~3-5 min.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.elan/bin:$PATH"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
command -v lake >/dev/null || { echo "needs elan (https://github.com/leanprover/elan)"; exit 2; }
L4E=$(tools/build_lean4export.sh)
OUT=run-output/rebuild; rm -rf "$OUT"; mkdir -p "$OUT"

echo "-- 1. lake build lean/ (re-elaborates every definition and proof)"
(cd lean && lake build 2>&1 | tail -1)

echo "-- 1b. four buggy wallets, each caught by its bounty claim (mutants/Mutants.lean)"
MUT=$(mktemp -d)
(cd lean && LEAN_PATH="$(lean --print-libdir):$PWD/.lake/build/lib/lean" lean --root=../mutants -o "$MUT/Mutants.olean" ../mutants/Mutants.lean)
printf 'import Mutants\n#print axioms Mutant.NoAllowlist.caught\n#print axioms Mutant.DoubleCap.caught\n#print axioms Mutant.WrapAdd.caught\n#print axioms Mutant.NonceSkip.caught\n' > "$MUT/Check.lean"
AX=$(cd lean && LEAN_PATH="$(lean --print-libdir):$PWD/.lake/build/lib/lean:$MUT" lean "$MUT/Check.lean")
echo "$AX" | grep -q sorryAx && { echo "FAIL a mutant refutation uses sorry"; exit 1; }
[ "$(echo "$AX" | grep -c "axioms")" = 4 ] || { echo "FAIL mutant check: $AX"; exit 1; }
echo "ok   NoAllowlist, DoubleCap, WrapAdd, NonceSkip: each refuted by a concrete counterexample, no sorry"

echo "-- 2. the shelf"
SHELF=$(python3 -S -c "import json;print(json.load(open('demo/bounties.json'))['shelf'])")
ROOTS=(); while IFS= read -r r; do [ -n "$r" ] && ROOTS+=("$r"); done < <(tr -s ' \t' '\n\n' < "$SHELF/base_roots.txt")
(cd lean && LEAN_PATH="$(lean --print-libdir):$PWD/.lake/build/lib/lean" "$L4E" Policy.Bounties -- "${ROOTS[@]}") > "$OUT/base.ndjson"
[ "$(sha "$OUT/base.ndjson")" = "$(cat "$SHELF/base.sha256")" ] || { echo "FAIL shelf re-export differs"; exit 1; }
echo "ok   shelf re-exported byte for byte: $(cat "$SHELF/base.sha256")"

echo "-- 3. agent proofs, re-checked in a clean workspace and re-exported"
python3 -S - <<'EOF' > "$OUT/agents.txt"
import json
for d in json.load(open("proofs/MANIFEST.json"))["deltas"]:
    if d.get("solution"):
        print(d["claim"], d["solution"], d["sha256"])
EOF
while read -r claim sol want; do
  dir="$OUT/$(basename "$(dirname "$sol")")"
  mkdir -p "$dir" && cp "$sol" "$dir/Solution.lean"
  python3 -I agent/solve.py "$claim" "$dir" --reuse >/dev/null || { echo "FAIL $claim does not re-check"; exit 1; }
  got=$(sha "$dir/delta.ndjson")
  [ "$got" = "$want" ] || { echo "FAIL $claim delta $got, committed $want"; exit 1; }
  echo "ok   $claim: compiles, only allowed axioms, delta byte-identical (${want:0:16}…)"
done < "$OUT/agents.txt"

echo "-- 4. cheats"
tools/make_cheats.sh "$SHELF" "$OUT/cheats" >"$OUT/cheats.log" 2>&1 || { cat "$OUT/cheats.log"; echo "FAIL tools/make_cheats.sh"; exit 1; }
python3 -I tools/forge_cheats.py "$SHELF/base.ndjson" evidence/agent/AllowedReceiversOnly-opus/delta.ndjson Solution.proof "$OUT/cheats" >/dev/null
for f in cheats/deltas/*.delta.ndjson; do
  [ "$(sha "$f")" = "$(sha "$OUT/cheats/$(basename "$f")")" ] || { echo "FAIL $f differs when regenerated"; exit 1; }
done
echo "ok   all $(ls cheats/deltas | wc -l | tr -d ' ') cheat deltas regenerate byte for byte"

echo "-- 5. nanoda, the contract's kernel, natively on shelf + delta"
(cd tools/native && cargo build --release --quiet)
NAT=tools/native/target/release/proof-courier-native
python3 -S - <<'EOF' > "$OUT/native.txt"
import json
for d in json.load(open("proofs/MANIFEST.json"))["deltas"]:
    e = d["expected"]
    want = "typechecks" if e == "accepted" or "statement_mismatch" in e else "rejected"
    print(d["delta"], want)
EOF
while read -r delta want; do
  cat "$SHELF/base.ndjson" "$delta" > "$OUT/full.ndjson"
  if "$NAT" "$OUT/full.ndjson" >/dev/null 2>&1; then got=typechecks; else got=rejected; fi
  [ "$got" = "$want" ] || { echo "FAIL $delta: expected the kernel to say $want, it says $got"; exit 1; }
  if [ "$want" = rejected ]; then echo "ok   $delta: rejected by the kernel itself"
  elif [ "${delta#cheats/}" != "$delta" ]; then echo "ok   $delta: type-checks, but proves another statement: the claim check refuses it on-chain"
  else echo "ok   $delta: type-checks"; fi
done < "$OUT/native.txt"

echo "-- 6. the kernel contract's own run_check on the sealed shelf (contracts/kernel unit test)"
T=$(cd contracts/kernel && cargo test --release --locked 2>&1) && grep -q "forged_recursor_rule_is_refused ... ok" <<<"$T" && grep -q "builtin_name_in_delta_is_refused ... ok" <<<"$T" || { echo "FAIL contracts/kernel: cargo test --release"; exit 1; }
echo "ok   an honest proof is accepted; illTyped and the two forged recursor rules (cheats/deltas/forgedRec*) fail in the kernel"
echo "ok   the two proof files that declare a name the type checker computes by itself (cheats/deltas/builtin*) are refused by the contract's rule"

echo "-- 7. board unit tests, including invalidation between a request and its callback"
if ! (cd contracts/board && cargo test --release --locked) > "$OUT/board-unit.log" 2>&1; then
  cat "$OUT/board-unit.log"
  exit 1
fi
grep 'test result:' "$OUT/board-unit.log"
echo; echo "Lean rebuild checks passed."
