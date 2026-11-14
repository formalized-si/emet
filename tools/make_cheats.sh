#!/usr/bin/env bash
# Export the Lean-level cheats in cheats/Cheats.lean as deltas against a shelf.
# usage: tools/make_cheats.sh [shelf_dir] [out_dir]
set -euo pipefail
cd "$(dirname "$0")/.."
SHELF=${1:-shelf/wallet-v5}; OUT=${2:-run-output/cheats}
export PATH=$HOME/.elan/bin:$PATH
# lean runs below from the repository root, which has no lean-toolchain file: without this elan would use
# its default toolchain, whatever that is on this machine.
export ELAN_TOOLCHAIN="$(cat lean/lean-toolchain)"
L4E=$PWD/.tools/lean4export/.lake/build/bin/lean4export
mkdir -p "$OUT"; TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
(cd lean && lake build Policy.Bounties >/dev/null)
export LEAN_PATH="$(lean --print-libdir):$PWD/lean/.lake/build/lib/lean:$TMP"
lean --root=cheats -o "$TMP/Cheats.olean" cheats/Cheats.lean 2>&1 | grep -v "declaration uses 'sorry'" || true
ROOTS=(); while IFS= read -r r; do [ -n "$r" ] && ROOTS+=("$r"); done < <(tr -s ' \t' '\n\n' < "$SHELF/base_roots.txt")
BL=$(cat "$SHELF/base.lines"); WANT=$(cat "$SHELF/base.sha256")
# The forged recursor (Lean Kernel Arena, bugs/rec-rule-proof-irrel) is its own module, so that the
# lines of Cheats.lean, which `sorry` records in viaSorry, do not move.
lean --root=cheats -o "$TMP/ForgedRec.olean" cheats/ForgedRec.lean
lean --root=cheats -o "$TMP/Forged.olean" cheats/Forged.lean
for t in viaSorry viaAxiom weaker noRequests forgedRec forgedRecNested; do
  case $t in forged*) mod=Forged ;; *) mod=Cheats ;; esac
  "$L4E" "$mod" -- "${ROOTS[@]}" "Cheat.$t" > "$TMP/full.ndjson"
  [ "$(head -n "$BL" "$TMP/full.ndjson" | shasum -a 256 | cut -c1-64)" = "$WANT" ] || { echo "shelf mismatch for $t" >&2; exit 2; }
  tail -n +"$((BL + 1))" "$TMP/full.ndjson" > "$OUT/$t.delta.ndjson"
  echo "$t $(wc -c < "$OUT/$t.delta.ndjson") bytes"
done
