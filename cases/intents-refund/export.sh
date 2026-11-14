#!/usr/bin/env bash
# Export the source-bound refund candidates and proof files for the NEAR kernel.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CASE="$ROOT/cases/intents-refund"
export PATH="$HOME/.elan/bin:$PATH"
cd "$ROOT"
python3 "$CASE/prepare.py"
L4E=$(tools/build_lean4export.sh)
cd "$CASE"
lake build
export LEAN_PATH="$(lean --print-libdir):$CASE/.lake/build/lib/lean"
mkdir -p shelf proofs
ROOTS=()
while IFS= read -r r; do ROOTS+=("$r"); done < base_roots.txt
"$L4E" LogBudget -- "${ROOTS[@]}" > shelf/base.ndjson
BL=$(wc -l < shelf/base.ndjson | tr -d ' ')
cp base_roots.txt shelf/base_roots.txt
printf '%s\n' "$BL" > shelf/base.lines
python3 -c 'import hashlib,pathlib;print(hashlib.sha256(pathlib.Path("shelf/base.ndjson").read_bytes()).hexdigest())' > shelf/base.sha256
python3 "$ROOT/tools/pack_base.py" shelf/base.ndjson shelf
python3 - "$CASE" <<'PY' > "$CASE/.proof-roots.tmp"
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);c=json.loads((p/'candidates.json').read_text())
for x in c['candidates']:print(x['label'],x['proof'])
PY
while read -r label theorem; do
  "$L4E" RefundProofs LogBudget -- "${ROOTS[@]}" "$theorem" > "$CASE/.full.tmp"
  cmp <(head -n "$BL" "$CASE/.full.tmp") shelf/base.ndjson
  tail -n +"$((BL+1))" "$CASE/.full.tmp" > "proofs/$label.ndjson"
  python3 - "proofs/$label.ndjson" <<'PY'
import json,sys
for line in open(sys.argv[1]):
    declaration=json.loads(line)
    if any(k in declaration for k in ('axiom','opaque','quot')):
        raise SystemExit('Proof delta introduces an axiom/opaque/quot declaration; the on-chain policy refuses it')
PY
  "$ROOT/tools/native/target/release/proof-courier-native" "$CASE/.full.tmp" >/dev/null
  printf '%s: %s proof bytes\n' "$label" "$(wc -c < "proofs/$label.ndjson" | tr -d ' ')"
done < "$CASE/.proof-roots.tmp"
rm "$CASE/.full.tmp" "$CASE/.proof-roots.tmp"
