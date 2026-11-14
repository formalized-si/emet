#!/usr/bin/env python3
"""Export `Solution.proof` as the delta the chain would check, and say how heavy it is.

usage: python3 agent/measure.py <workspace> <shelf_dir> [--write out_dir]
       (in an agent workspace: ./measure.sh)

The delta is what lean4export prints after the sealed shelf when run on
`<shelf roots...> Solution.proof`. Everything the proof uses that is not on the shelf is in
the delta and is type-checked on-chain on every claim, so its size is the claim's cost.
Prints the size, the declaration count and the heaviest declarations (with the shelf roots
that are free to use listed in SHELF.md of the workspace).
"""

import hashlib, json, os, pathlib, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
# Inside an agent workspace the exporter sits next to this file; in the repository it is built
# into .tools/ by tools/build_lean4export.sh.
L4E = (
    HERE / "lean4export"
    if (HERE / "lean4export").exists()
    else HERE.parent / ".tools/lean4export/.lake/build/bin/lean4export"
)
TARGET_BYTES = 400_000
LIMIT_BYTES = 1_000_000
DECL = (b'{"def"', b'{"thm"', b'{"inductive"', b'{"opaque"', b'{"axiom"', b'{"quot"')


def env_for(ws):
    env = dict(os.environ)
    env["PATH"] = str(pathlib.Path.home() / ".elan/bin") + os.pathsep + env.get("PATH", "")
    libdir = subprocess.run(["lean", "--print-libdir"], cwd=ws, env=env, capture_output=True, text=True).stdout.strip()
    env["LEAN_PATH"] = libdir + os.pathsep + str(pathlib.Path(ws) / ".lake/build/lib/lean")
    return env


def export(ws, shelf):
    ws, shelf = pathlib.Path(ws).resolve(), pathlib.Path(shelf).resolve()
    env = env_for(ws)
    b = subprocess.run(["lake", "build", "Solution"], cwd=ws, env=env, capture_output=True, text=True)
    if b.returncode != 0:
        return {"exported": False, "error": "Solution does not build:\n" + (b.stdout + b.stderr)[-3000:]}
    roots = (shelf / "base_roots.txt").read_text().split()
    modules = ["Solution"] + (
        ["LogBudget"] if (ws / "LogBudget.lean").exists() else []
    )  # the refund case: roots in a second module
    r = subprocess.run(
        [str(L4E), *modules, "--", *roots, "Solution.proof"], cwd=ws, env=env, capture_output=True, timeout=900
    )
    if r.returncode != 0:
        return {"exported": False, "error": r.stderr.decode()[-2000:]}
    lines = int((shelf / "base.lines").read_text())
    data = r.stdout.split(b"\n")
    head = b"\n".join(data[:lines]) + b"\n"
    delta = b"\n".join(data[lines:])
    want = (shelf / "base.sha256").read_text().strip()
    names = {0: ""}
    for raw in data:
        if raw.startswith(b'{"in"'):
            v = json.loads(raw)
            pre, s = (v["str"]["pre"], v["str"]["str"]) if "str" in v else (v["num"]["pre"], str(v["num"]["i"]))
            p = names.get(pre, "#")
            names[v["in"]] = f"{p}.{s}" if p else s
    decls, acc = [], 0
    for raw in data[lines:]:
        if not raw:
            continue
        if raw.startswith(DECL):
            k = raw[2 : raw.index(b'"', 2)].decode()
            v = json.loads(raw)[k]
            n = names.get(v["types"][0]["name"] if k == "inductive" else v.get("name"), "?")
            decls.append({"name": n, "kind": k, "bytes": acc + len(raw) + 1})
            acc = 0
        else:
            acc += len(raw) + 1
    # The chain refuses a delta that declares any axiom, opaque or quotient (it scans before parsing).
    forbidden = [f"{d['kind']} {d['name']}" for d in decls if d["kind"] in ("axiom", "opaque", "quot")]
    return {
        "exported": True,
        "shelf_head_matches": hashlib.sha256(head).hexdigest() == want,
        "shelf_sha256": want,
        "forbidden_in_delta": forbidden,
        "delta": delta,
        "delta_bytes": len(delta),
        "delta_sha256": hashlib.sha256(delta).hexdigest(),
        "decls": len(decls),
        "heaviest": sorted(decls, key=lambda d: -d["bytes"])[:15],
    }


def main():
    ws, shelf = sys.argv[1], sys.argv[2]
    r = export(ws, shelf)
    if not r["exported"]:
        print(r["error"])
        sys.exit(1)
    if "--write" in sys.argv:
        out = pathlib.Path(sys.argv[sys.argv.index("--write") + 1])
        out.mkdir(parents=True, exist_ok=True)
        (out / "delta.ndjson").write_bytes(r["delta"])
    if r["decls"] == 0:  # an agent measured helper lemmas only and was told "0 bytes, OK"
        print(
            "NOTHING TO CHECK: the export adds no declaration to the shelf. Solution.lean has no theorem `Solution.proof` yet."
        )
        sys.exit(1)
    verdict = (
        "OK"
        if r["delta_bytes"] <= TARGET_BYTES
        else (
            "TOO BIG for the target" if r["delta_bytes"] <= LIMIT_BYTES else "TOO BIG: will not fit one on-chain check"
        )
    )
    if r["forbidden_in_delta"]:
        verdict = (
            "REFUSED: the delta declares "
            + ", ".join(r["forbidden_in_delta"])
            + " (the chain refuses axioms, opaques and quotients in a proof file; use only what the shelf already has)"
        )
    print(
        f"delta: {r['delta_bytes']:,} bytes, {r['decls']} declarations not on the shelf  [{verdict}; target <= {TARGET_BYTES:,}]"
    )
    if not r["shelf_head_matches"]:
        print("WARNING: export head does not match the sealed shelf")
    print("heaviest declarations in the delta (bytes incl. the expressions they introduce):")
    for d in r["heaviest"]:
        print(f"  {d['bytes']:>9,}  {d['kind']:<9} {d['name']}")
    print("Library lemmas whose own proofs use omega/BitVec/Int machinery are expensive; lemmas in SHELF.md are free.")


if __name__ == "__main__":
    main()
