"""Offline check of a hostile-suite record (demo/hostile.cjs): no bad input was admitted, and the record
is about the files in this repository. Python standard library only; nothing is executed.

usage: python3 -S tools/check_hostile.py [results.json]      (default evidence/hostile/results.json)
"""

import hashlib, json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sha = lambda p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest()
load = lambda p: json.loads((ROOT / p).read_text())
bad = 0


def check(what, ok, detail=""):
    global bad
    bad += not ok
    print(("PASS  " if ok else "FAIL  ") + what + (f"  [{detail}]" if detail and not ok else ""))


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "evidence/hostile/results.json"
    rep, man = load(path), load("cheats/arena/MANIFEST.json")
    rows, t = rep["results"], rep["target"]
    whole = not t.get("only") and t.get("paths") == ["delta", "base"]
    reject = [r for r in rows if r["expected"] == "reject"]
    accept = [r for r in rows if r["expected"] == "accept"]
    sent = [r for r in reject if not r.get("not_sent")]
    by = lambda rs, k: sum(r.get("stopped_by") == k for r in rs)
    print(
        f"-- hostile suite, {path}: {t['network']}, kernel {t.get('kernel_name')}, arena {rep['arena']['commit'][:7]}"
    )

    admitted = [f"{r['path']}:{r['id']}" for r in reject if r.get("admitted") is not False]
    check(
        f"none of the {len({r['id'] for r in reject})} bad inputs was admitted, in {len(sent)} checks on-chain "
        f"({by(sent, 'kernel')} stopped by the kernel, {by(sent, 'guard')} by a guard, {by(sent, 'gas limit')} by the gas limit)",
        not admitted and not rep.get("error") and rep["summary"]["admitted"] == 0,
        ", ".join(admitted) or str(rep.get("error")),
    )
    check(
        "every check ran to a verdict, and each bad input was stopped by something the record names",
        all(not r.get("error") and r.get("pass") for r in rows)
        and all(r.get("stopped_by") in ("kernel", "guard", "gas limit") and r.get("detail") for r in sent),
        ", ".join(r["id"] for r in rows if r.get("error") or not r.get("pass"))[:300],
    )
    check(
        f"the controls were accepted, so the suite does not pass by refusing everything ({len(accept)} checks, on both paths)",
        accept
        and all(r.get("admitted") is True for r in accept)
        and (not whole or {r["path"] for r in accept} == {"base", "delta"}),
    )
    check(
        "every transaction is named: a hash and the gas burnt for each check that was sent",
        all(r.get("tx") and r.get("gas_tgas") is not None for r in rows if not r.get("not_sent")),
    )
    check(
        "the kernel in the record is artifacts/kernel.wasm, on the shelf in shelf/wallet-v5, and the arena commit is the vendored one",
        t["kernel_wasm_sha256"] == sha("artifacts/kernel.wasm")
        and t["shelf_sha256"] == load("shelf/wallet-v5/manifest.json")["base_sha256"]
        and rep["arena"]["commit"] == man["arena_commit"]
        and rep["arena"]["tarball_sha256"] == man["tarball"]["sha256"],
    )

    # The vendored arena files are the manifest's, and the base path sent exactly those bytes.
    files = {f"arena/{d}/{n}": f"cheats/arena/{d}/{n}.ndjson" for d in ("bad", "built", "good") for n in man[d]}
    on_disk = {p.relative_to(ROOT).as_posix() for p in (ROOT / "cheats/arena").rglob("*.ndjson")}
    check(
        f"cheats/arena holds the manifest's {len(files)} exports and nothing else, each with its recorded sha256",
        on_disk == set(files.values())
        and all(sha(f) == man[i.split("/")[1]][i.split("/", 2)[2]]["sha256"] for i, f in files.items()),
    )
    base = {r["id"]: r for r in rows if r["path"] == "base"}
    delta = {r["id"]: r for r in rows if r["path"] == "delta"}
    got = [i for i in files if i in base]
    check(
        f"the base path sent these exports byte for byte ({len(got)} of {len(files)})",
        all(base[i]["sent_sha256"] == sha(files[i]) for i in got) and (not whole or len(got) == len(files)),
    )
    own = sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / "cheats/deltas").glob("*.delta.ndjson"))
    ids = {f: "repo/" + f.removesuffix(".delta.ndjson") for f in own}
    got = [f for f in own if ids[f] in delta]
    check(
        f"the delta path sent this repository's own fake proofs as they are in cheats/deltas ({len(got)} of {len(own)})",
        all(delta[ids[f]]["sent_sha256"] == sha(f) and delta[ids[f]]["expected"] == "reject" for f in got)
        and (not whole or len(got) == len(own)),
    )
    if whole:
        check(
            "every arena export has a row on the delta path too: sent as a proof file, or the reason it cannot be one",
            all(i in delta for i in files),
        )
        over = [r for r in rows if r.get("free") and r["free"]["gas_tgas"] > rep["summary"]["free_path"]["cap_tgas"]]
        check(
            f"the free path was measured for every proof file sent ({len(delta) - sum(bool(r.get('not_sent')) for r in delta.values())}); "
            f"{len(over)} need more than {rep['summary']['free_path']['cap_tgas']} TGas and are listed in the summary",
            all(r.get("free") for r in delta.values() if not r.get("not_sent"))
            and sorted(r["id"] for r in over) == sorted(x["id"] for x in rep["summary"]["free_path"]["over_cap"]),
        )

    # The "try it" fixtures are what the recorded run sent, with the verdicts it got.
    tdir = ROOT / "cheats/try"
    if whole and (tdir / "index.json").exists():
        idx = json.loads((tdir / "index.json").read_text())
        ok, n = idx["shelf_sha256"] == t["shelf_sha256"] and idx["kernel_wasm_sha256"] == t["kernel_wasm_sha256"], 0
        for f in idx["fixtures"]:
            args = (tdir / f["args_file"]).read_bytes()
            a = json.loads(args)
            r = next((r for r in delta.values() if r["sent_sha256"] == f["delta_sha256"]), None)
            ok = (
                ok
                and hashlib.sha256(args).hexdigest() == f["args_sha256"]
                and hashlib.sha256(a["delta"].encode()).hexdigest() == f["delta_sha256"]
                and r is not None
                and a["theorem_name"] == r["statement_name"]
                and r["admitted"] == f["expected"]["admitted"] == f["valid"]
                and r["free"]["view"] == f["expected"]["view"]
                and r["free"]["gas_tgas"] == f["free_gas_tgas"]
                and f["fits_a_300_tgas_view"] == (f["free_gas_tgas"] <= 300)
            )
            n += 1
        check(
            f"cheats/try: the {n} ready-to-send dry_run arguments are the proof files of the recorded run, with its verdicts and gas "
            f"({sum(not f['valid'] for f in idx['fixtures'])} invalid, {sum(f['valid'] for f in idx['fixtures'])} valid)",
            ok and n > 0,
        )
    print(f"{'hostile record: all checks pass' if not bad else f'{bad} hostile checks FAILED'}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
