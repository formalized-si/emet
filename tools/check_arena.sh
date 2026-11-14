#!/usr/bin/env bash
# Run every Lean Kernel Arena fixture (leanprover/lean-kernel-arena @ 6c2d821) through nanoda built
# from this kernel's own source (tools/native), and compare with evidence/lean-kernel-arena/results.json.
# A fixture expected to be rejected must never be accepted. Needs git, cargo, elan, internet once.
#   tools/check_arena.sh            compare with the record (exit 1 on a false accept or any difference)
#   tools/check_arena.sh --record   write the record (maintainers)
# The arena keeps an export in its repository only for some tests (file:); the others it builds from a
# Lean file (leanfile: + export-decls:). Of those, this runs the three forged-recursor tests of
# tests/bugs/rec-proof-irrel.lean, exported here with this repository's Lean and lean4export from
# cheats/ForgedRec.lean, which must be that file, unchanged.
set -euo pipefail
cd "$(dirname "$0")/.."
COMMIT=6c2d82164f1a2b1ac94aee62290fe78a3c3853fb
DIR=.tools/lean-kernel-arena
if [ ! -d "$DIR" ]; then git clone -q https://github.com/leanprover/lean-kernel-arena.git "$DIR"; fi
(cd "$DIR" && { git cat-file -e "$COMMIT^{commit}" 2>/dev/null || git fetch -q origin; } && git checkout -q "$COMMIT")
(cd tools/native && cargo build --release --quiet)
NAT=$PWD/tools/native/target/release/proof-courier-native
LEANFILE=tests/bugs/rec-proof-irrel.lean
cmp -s cheats/ForgedRec.lean "$DIR/$LEANFILE" || { echo "cheats/ForgedRec.lean is not the arena's $LEANFILE @ ${COMMIT:0:7}"; exit 1; }
export PATH="$HOME/.elan/bin:$PATH"
L4E=$(tools/build_lean4export.sh)
BUILT=$PWD/run-output/arena; rm -rf "$BUILT"; mkdir -p "$BUILT"
(cd lean && lean --root=../cheats -o "$BUILT/ForgedRec.olean" ../cheats/ForgedRec.lean)
export LEAN_PATH="$(cd lean && lean --print-libdir):$BUILT"
ROOT=$PWD
cd "$DIR"
python3 -S - "$NAT" "$ROOT/evidence/lean-kernel-arena/results.json" "$COMMIT" "$LEANFILE" "$L4E" "$BUILT" "$ROOT" "${1:-}" <<'PY'
import hashlib, json, pathlib, re, subprocess, sys
nat, record, commit, leanfile, l4e, built, root, mode = sys.argv[1:9]
cases = []; bad = 0
for y in sorted(pathlib.Path("tests").rglob("*.yaml")):
    t = y.read_text()
    m = re.search(r"^file:\s*(\S+)", t, re.M); o = re.search(r"^outcome:\s*(\S+)", t, re.M)
    lf = re.search(r"^leanfile:\s*(\S+)", t, re.M); ed = re.search(r"^export-decls:\s*(\[.*\])", t, re.M)
    if not o:
        continue
    if m and m.group(1).endswith(".ndjson") and pathlib.Path(m.group(1)).exists():
        name, f = m.group(1), pathlib.Path(m.group(1))
    elif lf and ed and lf.group(1) == leanfile:
        name, f = str(y), pathlib.Path(built) / (y.stem + ".ndjson")
        with open(f, "wb") as out:
            subprocess.run([l4e, "ForgedRec", "--"] + json.loads(ed.group(1)), stdout=out, check=True, cwd=root)
    else:
        continue
    r = subprocess.run([nat, str(f)], capture_output=True, text=True, timeout=600)
    ok = r.returncode == 0 and '"ok":true' in r.stdout
    # a parser error surfaces in tools/native's own unwrap; anything else is the kernel refusing a declaration
    observed = "accepted" if ok else "declined" if "src/main.rs" in r.stderr else "rejected"
    want = o.group(1)
    cases.append({"fixture": name, "expected": want, "observed": observed, "false_accept": want == "reject" and ok,
                  "false_reject": want == "accept" and not ok, "sha256": hashlib.sha256(f.read_bytes()).hexdigest(),
                  "stderr_tail": re.sub(r"\(\d+\) ", "", r.stderr.replace(root + "/", ""))[-400:]})
    if want == "reject" and ok:
        print("FALSE ACCEPT", name); bad += 1
if mode == "--record":
    json.dump({"arena_commit": commit, "checker": "tools/native (current contracts/kernel/vendor/nanoda_lib)", "cases": cases},
              open(record, "w"), indent=1)
    open(record, "a").write("\n")
else:
    want = {c["fixture"]: (c["observed"], c["sha256"]) for c in json.load(open(record))["cases"]}
    got = {c["fixture"]: (c["observed"], c["sha256"]) for c in cases}
    for name in sorted(set(want) | set(got)):
        if want.get(name) != got.get(name):
            print("differs from the recorded run:", name, want.get(name), got.get(name)); bad += 1
n = len(cases); rej = sum(c["expected"] == "reject" for c in cases)
print(f"{n} fixtures; 0 of the {rej} expected-reject fixtures accepted" if not bad else f"{bad} problems")
sys.exit(1 if bad else 0)
PY
