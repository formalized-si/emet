#!/usr/bin/env python3
"""Offline checks behind README claims. Python 3 standard library only, a few seconds.

1. The five contract binaries are the ones every test used (artifacts/SHA256SUMS).
2. The shelf: base.ndjson hashes to the pinned sha256; its upload chunks decode (LZ4, decoded
   here by hand) to exactly base.ndjson; the declaration count is what seal_base expects.
3. Provenance: the shelf was exported from lean/Policy/Core.lean and Spec.lean as they are now,
   and the wallet wasm was built from the lean/ tree as it is now (lean_src_sha256).
4. Every proof and cheat delta is the file the recorded run used (proofs/MANIFEST.json), and the
   agents' Lean sources contain no sorry / axiom / native_decide.
5. The recorded end-to-end run (evidence/demo/scenario.json) passed all its claims, with the same
   binaries, the same shelf and the same agent proofs; in it the transaction that paid the refutation
   froze the wallet, after the wallet's last allowed payment. The recorded failure paths
   (evidence/demo/faults.json) passed, and their root-bounty checks used the forged proofs in
   cheats/deltas/ and, for the what-if, the superseded kernel binary kept in history/.
"""

import hashlib, json, pathlib, re, sys

R = pathlib.Path(__file__).resolve().parents[1]
ok_all = True


def sha(p):
    return hashlib.sha256((R / p).read_bytes()).hexdigest()


def check(name, cond, detail=""):
    global ok_all
    ok_all &= bool(cond)
    print(("ok   " if cond else "FAIL ") + name + (f"  ({detail})" if detail else ""))


def lz4_block_decompress(src: bytes) -> bytes:
    """LZ4 block format, as lz4_flex::compress_prepend_size writes it (u32 LE size first)."""
    size = int.from_bytes(src[:4], "little")
    s, out, i = src[4:], bytearray(), 0
    while i < len(s):
        token = s[i]
        i += 1
        lit = token >> 4
        if lit == 15:
            while True:
                b = s[i]
                i += 1
                lit += b
                if b != 255:
                    break
        out += s[i : i + lit]
        i += lit
        if i >= len(s):
            break
        off = s[i] | (s[i + 1] << 8)
        i += 2
        ml = token & 15
        if ml == 15:
            while True:
                b = s[i]
                i += 1
                ml += b
                if b != 255:
                    break
        ml += 4
        start = len(out) - off
        for k in range(ml):
            out.append(out[start + k])
    assert len(out) == size, (len(out), size)
    return bytes(out)


def kernel_decl_count(data: bytes) -> int:
    n = 0
    for line in data.split(b"\n"):
        if line.startswith(b'{"inductive"'):
            v = json.loads(line)["inductive"]
            n += sum(len(v.get(k, [])) for k in ("types", "ctors", "recs"))
        elif line.startswith((b'{"axiom"', b'{"def"', b'{"thm"', b'{"opaque"', b'{"quot"')):
            n += 1
    return n


def lean_src_sha256(proj: pathlib.Path) -> str:
    files = []
    for p in proj.rglob("*"):
        rel = p.relative_to(proj)
        if any(part in (".lake", ".git") for part in rel.parts) or not p.is_file():
            continue
        if p.suffix == ".lean" or p.name in ("lakefile.toml", "lakefile.lean", "lean-toolchain", "lake-manifest.json"):
            files.append(str(rel))
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(f"{rel}\0{sha(proj.relative_to(R) / rel)}\n".encode())
    return h.hexdigest()


def main():
    print("-- 1. contract binaries")
    for line in (R / "artifacts/SHA256SUMS").read_text().split("\n"):
        if line.strip():
            want, name = line.split()
            check(f"artifacts/{name} sha256 {want[:16]}…", sha(f"artifacts/{name}") == want)

    print("-- 2. the shelf")
    cfg = json.loads((R / "demo/bounties.json").read_text())
    S = cfg["shelf"]
    m = json.loads((R / S / "manifest.json").read_text())
    base = (R / S / "base.ndjson").read_bytes()
    check(
        f"{S}/base.ndjson hashes to the pinned shelf hash",
        hashlib.sha256(base).hexdigest() == m["base_sha256"] == (R / S / "base.sha256").read_text().strip(),
        m["base_sha256"][:16] + "…",
    )
    decoded = b""
    for c in m["chunks"]:
        raw = (R / S / c).read_bytes()
        head, payload = raw.split(b"\n", 1)
        assert head.split()[1] == b"lz4"
        body = lz4_block_decompress(payload)
        decoded += body
    check(
        f"{len(m['chunks'])} upload chunks decode to exactly base.ndjson",
        decoded == base,
        f"{m['stored_bytes']:,} bytes stored for {len(base):,}",
    )
    check(
        "declaration count matches seal_base's expected_decl_count",
        kernel_decl_count(base) == m["base_decls"],
        str(m["base_decls"]),
    )
    roots = (R / S / "base_roots.txt").read_text().split()
    bounty_names = {
        n for b in cfg["bounties"] + ([cfg["fix"]] if cfg.get("fix") else []) for n in (b["claim"], b["counter_claim"])
    }
    check("every bounty's claim and counter-claim is on the shelf", bounty_names <= set(roots), f"{len(roots)} roots")
    proved_in_repo = (R / "lean/Policy/Proofs.lean").read_text() + (R / "lean/Policy/SmallProofs.lean").read_text()
    check(
        "no bounty claim is stated or proved by the wallet's author in lean/Policy/Proofs.lean or SmallProofs.lean",
        not any(n.split(".")[-1] in proved_in_repo for n in bounty_names if ".Claim." in n),
    )

    print("-- 3. provenance: one Lean source for the wallet and for the shelf")
    for f, want in m["exported_from"]["files_sha256"].items():  # Core, Spec, Bounties, toolchain
        check(f"shelf exported from {f} as it is now", sha(f) == want)
    for w in ("wallet.wasm", "wallet-v2.wasm"):
        meta = json.loads((R / f"artifacts/{w}.meta.json").read_text())
        check(f"{w} is the build recorded in its meta", meta["sha256"] == sha(f"artifacts/{w}"))
        check(
            f"{w} was built from lean/ as it is now (lean_src_sha256)",
            meta["lean_src_sha256"] == lean_src_sha256(R / "lean"),
            meta["lean_src_sha256"][:16] + "…",
        )

    print(
        "-- 4. proofs and cheats (byte identity only; the verdicts are re-checked live by ./verify.sh --wallet and --lean)"
    )
    pm = json.loads((R / "proofs/MANIFEST.json").read_text())
    for d in pm["deltas"]:
        check(
            f"{d['delta']}: same bytes the recorded run revealed (its on-chain verdict: {d['expected']})",
            sha(d["delta"]) == d["sha256"],
        )
        if d.get("solution"):
            src = (R / d["solution"]).read_text()
            body = re.sub(r"--.*", "", re.sub(r"/-.*?-/", "", src, flags=re.S))
            delta_lines = (R / d["delta"]).read_bytes().split(b"\n")
            check(
                f"  {d['delta']}: declares no axiom, opaque or quotient (the chain's pre-parse scan would refuse it)",
                not any(l.startswith((b'{"axiom"', b'{"opaque"', b'{"quot"')) for l in delta_lines),
            )
            claim = re.escape(d["claim"])
            check(
                f"  {d['solution']}: proves {d['claim']}, no sorry/axiom/native_decide",
                re.search(rf"theorem\s+(Solution\.)?proof\s*:\s*{claim}\b", body) is not None
                and not re.search(r"\b(sorry|axiom|native_decide|implemented_by|extern)\b", body),
            )

    print("-- 5. the recorded end-to-end run")
    sc = json.loads((R / "evidence/demo/scenario.json").read_text())
    passed = [c["id"] for c in sc["claims"] if c.get("pass") is True]
    check(
        f"evidence/demo/scenario.json: {len(passed)}/{len(sc['claims'])} claims passed (each claim's own result, not the summary)",
        len(sc["claims"]) >= 19
        and len(passed) == len(sc["claims"])
        and sc["summary"] == {"pass": len(passed), "fail": 0},
    )
    sums = {l.split()[1]: l.split()[0] for l in (R / "artifacts/SHA256SUMS").read_text().split("\n") if l.strip()}
    check(
        "it ran the same five binaries and the same shelf",
        all(
            sc["inputs"].get(f"{n.replace('-', '_')}_wasm_sha256") == sums.get(f"{n}.wasm")
            for n in ("kernel", "board", "factory", "wallet", "wallet-v2")
        )
        and sc["inputs"]["shelf_sha256"] == m["base_sha256"],
    )
    fr = json.loads((R / "evidence/demo/faults.json").read_text())
    fpassed = [c for c in fr["checks"] if c.get("pass") is True]
    check(
        f"evidence/demo/faults.json: {len(fpassed)}/{len(fr['checks'])} failure-path checks passed (each check's own result), on the same binaries",
        len(fr["checks"]) >= 12
        and len(fpassed) == len(fr["checks"])
        and fr["summary"] == {"pass": len(fpassed), "fail": 0}
        and all(
            fr["inputs"].get(f"{n}_wasm_sha256") == sums.get(f"{n}.wasm")
            for n in ("kernel", "board", "factory", "wallet")
        ),
    )
    f7 = next((c["detail"]["forged"] for c in fr["checks"] if c["id"] == "F7"), [])
    check(
        "its F7 sent the kernel the two forged-recursor proofs in cheats/deltas/ as they are now, and both failed in the kernel",
        len(f7) == 2
        and all(
            sha(f"cheats/deltas/{f['name']}.delta.ndjson") == f["delta_sha256"]
            and f["dry_run"] == f["check"] == "kernel_failed"
            for f in f7
        ),
    )
    forged_ok = lambda fs: len(fs) == 2 and all(
        sha(f"cheats/deltas/{f['name']}.delta.ndjson") == f["delta_sha256"] for f in fs
    )
    f11 = next((c["detail"] for c in fr["checks"] if c["id"] == "F11"), {})
    check(
        "its F11 sent the same two forged proofs of False to the root bounty on the current kernel: both failed in the kernel, the bounty stayed open, the kernel is not recorded broken",
        forged_ok(f11.get("forged", []))
        and all(f["outcome"] == "kernel_failed" and f["paid"] == "0" for f in f11["forged"])
        and f11["bounty"]["phase"] == "Open"
        and f11["bounty"]["winner"] is None
        and f11["kernel_broken_by"] is None,
    )
    f12 = next((c["detail"] for c in fr["checks"] if c["id"] == "F12"), {})
    old_kernel = f12.get("kernel_wasm", "")
    check(
        "its F12 is a what-if on the superseded kernel binary kept in history/ (not the kernel in artifacts/): there the root bounty was paid once and the kernel recorded broken",
        f12.get("what_if") is True
        and "0.4.31" in f12.get("kernel", "")
        and old_kernel.startswith("history/")
        and sha(old_kernel) == f12["kernel_wasm_sha256"] == fr["inputs"]["superseded_kernel_wasm_sha256"]
        and f12["kernel_wasm_sha256"] != sums["kernel.wasm"] == f12["current_kernel_wasm_sha256"]
        and forged_ok(f12.get("forged", []))
        and f12["root_bounty"]["phase"] == "Paid"
        and f12["root_bounty"]["certificate"]["proved"] == "False"
        and f12["kernel_broken_by"] is not None
        and f12["second_proof"] == "kernel_broken"
        and set(f12["gates_after"].values()) == {"kernel_broken"},
    )
    fz = sc.get("freeze", {})
    txs = sc["transactions"]
    at = next((i for i, t in enumerate(txs) if t.get("tx_hash") == fz.get("tx")), None)
    names = lambda t, std: [e["event"] for e in t.get("events", []) if e.get("standard") == std]
    verdicts = lambda t: [
        e["data"][0].get("verdict") for e in t.get("events", []) if e.get("event") == "wallet_attempt"
    ]
    pays = [
        (i, verdicts(t))
        for i, t in enumerate(txs)
        if t.get("method") == "pay" and t.get("receiver") == fz.get("wallet")
    ]
    check(
        "in the recorded run the transaction that paid the refutation froze the wallet: every allowed payment of that wallet is before it, every payment after it is refused as frozen",
        at is not None
        and txs[at]["method"] == "reveal"
        and {"proof_accepted", "code_refuted", "paid", "wallet_frozen"} <= set(names(txs[at], "proof-courier"))
        and names(txs[at], "proof-courier-wallet") == ["wallet_frozen"]
        and any(i < at and v == ["allow"] for i, v in pays)
        and any(i > at for i, v in pays)
        and all(v == ["frozen"] if i > at else v != ["frozen"] for i, v in pays),
        f"{fz.get('gas', {}).get('total_tgas', 0):.0f} TGas for that transaction",
    )
    certs = [b["certificate"] for b in sc["board_final"] if b.get("certificate")]
    if sc.get("fix", {}).get("bounty", {}).get("certificate"):
        certs.append(sc["fix"]["bounty"]["certificate"])  # the v2 board's certificate
    agent_shas = {d["sha256"] for d in pm["deltas"] if d.get("solution")}
    check(
        f"its {len(certs)} on-chain certificates are for the agents' proofs, on this shelf, with allowed axioms only",
        len(certs) >= 5
        and all(
            c["delta_sha256"] in agent_shas
            and c["base_hash"] == m["base_sha256"]
            and set(c["axioms"]) <= {"propext", "Classical.choice", "Quot.sound"}
            for c in certs
        ),
    )
    ns = R / "evidence/nearspec"
    if (ns / "theorems-sandbox.json").exists():
        # NEAR Proof Arena's transfer specification: the record of tools/measure_nearspec.sh against the files kept here.
        size, run = json.loads((ns / "size.json").read_text()), json.loads((ns / "theorems-sandbox.json").read_text())
        cases, proofs, env = {c["label"]: c for c in run["cases"]}, size["proofs"], size["sealed_environment"]
        good = [
            ("NearRelation.outputs_unique", "Emet.Arena.OutputsUnique", "outputs_unique"),
            ("NearRelation.domain", "Emet.Arena.RelationInDomain", "relation_in_domain"),
        ]
        check(
            "evidence/nearspec: the kernel in artifacts/ sealed the environment exported from NEAR Proof Arena's specification and type-checked all of it",
            run["kernel_wasm_sha256"] == sums["kernel.wasm"]
            and run["status"]["sealed"] is True
            and run["status"]["checked_upto"]
            == run["status"]["base_decls"]
            == env["declarations_as_the_kernel_counts_them"]
            and run["status"]["base_hash"] == env["sha256"] == run["manifest"]["base_sha256"]
            and all(c["ok"] for c in run["calls"]),
            f"{run['status']['base_decls']} declarations, {sum(1 for c in run['calls'] if not c['label'].startswith('check '))} calls",
        )
        check(
            "it accepted the Arena's own proofs of two theorems about its relation, each in one call, as the proof files kept here",
            all(
                cases[l]["verdict_ok"] is True
                and cases[l]["claim"] == claim
                and cases[l]["delta_sha256"] == proofs[t]["sha256"] == sha(f"evidence/nearspec/{t}.delta.ndjson")
                and cases[l]["tgas"] < 1000
                for l, claim, t in good
            ),
            ", ".join(f"{cases[l]['tgas']:.0f} TGas" for l, _, _ in good),
        )
        wrong = [c for c in run["cases"] if c["label"].startswith("wrong on purpose")]
        check(
            "and it refused one of those proofs under the other claim",
            len(wrong) == 1
            and wrong[0]["verdict_ok"] is False
            and str(wrong[0]["reason"]).startswith("statement_mismatch"),
        )
        on_testnet = R / "deploy/testnet-arena.json"
        if on_testnet.exists():
            a = json.loads(on_testnet.read_text())
            check(
                "deploy/testnet-arena.json: the same on testnet, as recorded: this kernel, this environment, no access key, and transactions that carried the proof files kept here",
                a["ok"] is True
                and all(c["ok"] for c in a["checks"])
                and a["kernel_wasm_sha256"] == sums["kernel.wasm"]
                and a["access_keys"] == 0
                and a["environment"]["sha256"] == env["sha256"] == a["status"]["base_hash"]
                and a["status"]["checked_upto"] == env["declarations_as_the_kernel_counts_them"]
                and all(
                    r["proof_sha256"] == sha(r["proof"]) and r["accepted"] == r["must_be_accepted"]
                    for r in a["results"]
                ),
                f"{len(a['transactions'])} transactions; python3 tools/check_live.py --tx asks the network",
            )
    print()
    if not ok_all:
        print("OFFLINE CHECKS FAILED")
        sys.exit(1)
    print("Offline checks passed.")


if __name__ == "__main__":
    main()
