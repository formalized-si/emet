#!/usr/bin/env bash
# NEAR Proof Arena's transfer specification under this kernel.
#
# Builds NearSpec.TransferV1 from ilblackdragon/near-proof-arena (commit below) with Lean 4.35.0. Exports the closure
# of its relation, NearSpec.TransferV1.NearRelation, and of two propositions that restate, word for word, two
# theorems the specification proves about that relation (cases/near-proof-arena/EmetArena.lean). Exports the Arena's
# own proofs of them as deltas. Seals the environment in the kernel contract on a local NEAR node and sends each
# proof in one call, and one proof under the wrong claim, which must be refused. Writes evidence/nearspec/.
#
# Needs Lean (elan), cargo (the chunk packer), Node with this repository's packages, git and the network.
# About 2 minutes once the toolchains are there. The specification is used as it is: nothing in it is changed, and nothing about nearcore is proved.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
COMMIT=7358a938
export PATH="$HOME/.elan/bin:$PATH"
L4E=$(tools/build_lean4export.sh)
(cd tools/native && cargo build --release --quiet)
W=.tools/nearspec; rm -rf "$W"; mkdir -p "$W"
git clone -q https://github.com/ilblackdragon/near-proof-arena.git "$W/arena"
(cd "$W/arena" && git checkout -q "$COMMIT")
cp -R "$W/arena/spec/lean" "$W/spec"; cp -R "$W/arena/formal-core" "$W/formal-core"
sed -i.bak 's#"../../formal-core"#"../formal-core"#' "$W/spec/lakefile.toml" "$W/spec/lake-manifest.json"
echo "leanprover/lean4:v4.35.0" | tee "$W/spec/lean-toolchain" > "$W/formal-core/lean-toolchain"
(cd "$W/spec" && lake build NearSpec.TransferV1 >/dev/null)
LIB="$ROOT/$W/spec/.lake/build/lib/lean"
export LEAN_PATH="$(lean --print-libdir):$LIB:$ROOT/$W/formal-core/.lake/build/lib/lean"
for f in EmetArena EmetArenaProofs; do lean "cases/near-proof-arena/$f.lean" -o "$LIB/$f.olean"; done
printf 'import EmetArenaProofs\n#print axioms Emet.Arena.Proofs.outputs_unique\n#print axioms Emet.Arena.Proofs.relation_in_domain\n' > "$W/Axioms.lean"
lean "$W/Axioms.lean" | tee "$W/axioms.txt"

RELATION=NearSpec.TransferV1.NearRelation
"$L4E" EmetArenaProofs -- "$RELATION" > "$W/relation.ndjson"
"$L4E" EmetArenaProofs -- "$RELATION" Emet.Arena.OutputsUnique Emet.Arena.RelationInDomain > "$W/base.ndjson"
BL=$(wc -l < "$W/base.ndjson" | tr -d ' ')
E=evidence/nearspec; mkdir -p "$E"
for t in outputs_unique relation_in_domain; do
  "$L4E" EmetArenaProofs -- "$RELATION" Emet.Arena.OutputsUnique Emet.Arena.RelationInDomain "Emet.Arena.Proofs.$t" > "$W/full.ndjson"
  cmp <(head -n "$BL" "$W/full.ndjson") "$W/base.ndjson"      # the proof's export starts with the sealed environment
  tail -n +"$((BL + 1))" "$W/full.ndjson" > "$E/$t.delta.ndjson"
  ! grep -qE '^\{"(axiom|opaque|quot)"' "$E/$t.delta.ndjson"  # a delta may not declare any of these
done
python3 tools/pack_base.py "$W/base.ndjson" "$W/packed" >/dev/null
python3 -S - "$W" "$E" "$COMMIT" <<'PY'
import hashlib, json, sys
w, e, commit = sys.argv[1:]
KINDS = (b'{"axiom"', b'{"def"', b'{"thm"', b'{"opaque"', b'{"quot"')
def count(data):   # as the kernel counts: every type, constructor and recursor of an inductive block is one declaration
    n = 0
    for line in data.split(b"\n"):
        if line.startswith(b'{"inductive"'):
            v = json.loads(line)["inductive"]; n += sum(len(v.get(k, [])) for k in ("types", "ctors", "recs"))
        elif line.startswith(KINDS): n += 1
    return n
relation, base = open(w + "/relation.ndjson", "rb").read(), open(w + "/base.ndjson", "rb").read()
sha = lambda b: hashlib.sha256(b).hexdigest()
size = {"arena": "https://github.com/ilblackdragon/near-proof-arena", "arena_commit": commit, "lean": "4.35.0 (the Arena pins 4.34.1)",
        "relation": {"constant": "NearSpec.TransferV1.NearRelation", "export_bytes": len(relation), "declarations_as_the_kernel_counts_them": count(relation), "sha256": sha(relation)},
        "sealed_environment": {"roots": ["NearSpec.TransferV1.NearRelation", "Emet.Arena.OutputsUnique", "Emet.Arena.RelationInDomain"],
                               "export_bytes": len(base), "declarations_as_the_kernel_counts_them": count(base), "sha256": sha(base)},
        "axioms_lean_reports": open(w + "/axioms.txt").read().strip().split("\n"),
        "proofs": {t: {"file": f"evidence/nearspec/{t}.delta.ndjson", "bytes": len(d), "sha256": sha(d), "declarations": count(d)}
                   for t in ("outputs_unique", "relation_in_domain") for d in [open(f"{e}/{t}.delta.ndjson", "rb").read()]}}
json.dump(size, open(e + "/size.json", "w"), indent=1); open(e + "/size.json", "a").write("\n")
cases = [{"label": "NearRelation.outputs_unique", "claim": "Emet.Arena.OutputsUnique", "delta": f"{e}/outputs_unique.delta.ndjson"},
         {"label": "NearRelation.domain", "claim": "Emet.Arena.RelationInDomain", "delta": f"{e}/relation_in_domain.delta.ndjson"},
         {"label": "wrong on purpose: the proof of outputs_unique offered for the other claim", "claim": "Emet.Arena.RelationInDomain", "delta": f"{e}/outputs_unique.delta.ndjson"}]
json.dump(cases, open(w + "/cases.json", "w"), indent=1)
print(json.dumps(size["sealed_environment"]))
PY
[ -n "${NEAR_SANDBOX_BIN_PATH:-}" ] || export NEAR_SANDBOX_BIN_PATH="$ROOT/.sandbox/2.14.0/near-sandbox" NEAR_SANDBOX_BINARY_PATH="$ROOT/.sandbox/2.14.0"
node tools/measure-shelf.cjs artifacts/kernel.wasm "$W/packed" "$W/cases.json" "$E/theorems-sandbox.json"
