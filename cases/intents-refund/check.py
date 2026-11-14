#!/usr/bin/env python3
"""Check recorded file integrity and the arithmetic/code bindings, without running NEAR."""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
load = lambda p: json.loads((ROOT / p).read_text())


def require(ok, message):
    if not ok:
        raise ValueError(message)


def main():
    m = load("evidence/refund/files.json")
    for item in m["files"]:
        p = (ROOT / item["path"]).resolve()
        require(p.is_relative_to(ROOT), "Manifest path escapes repository")
        data = p.read_bytes()
        require(
            len(data) == item["bytes"] and hashlib.sha256(data).hexdigest() == item["sha256"],
            f"Changed file: {item['path']}",
        )
    r = load("evidence/refund/replay.json")
    u = load("evidence/refund/upgrade.json")
    require(r.get("ok") is True and u.get("ok") is True, "Run was not successful")
    old = next(x for x in r["backed_runs"] if x["version"] == "old")
    fixed = next(x for x in r["backed_runs"] if x["version"] == "fixed")
    require(int(old["after"]["credit"]) - int(old["after"]["backing"]) == 80, "Old-code gap is not 80")
    require(int(fixed["after"]["credit"]) == int(fixed["after"]["backing"]), "Repair leaves unbacked credit")
    c = next(x for x in load("cases/intents-refund/candidates.json")["candidates"] if x["label"] == "repair")
    b = next(x for x in u["build"]["candidates"] if x["label"] == "repair")
    require(c["source_sha256"] == b["source_sha256"], "Source differs from build record")
    require(
        u["gate"]["phase"] == "Applied" and u["after_wasm_sha256"] == b["wasm_sha256"], "Installed artifact differs"
    )
    cert = u["repair_bounty"]["certificate"]
    require(
        cert["side"] == "proof" and cert["proved"] == c["claim"] and cert["base_hash"] == u["base_sha256"],
        "Wrong certificate",
    )
    require(
        cert["delta_sha256"]
        == hashlib.sha256((ROOT / "cases/intents-refund/proofs/repair.ndjson").read_bytes()).hexdigest(),
        "Proof bytes differ from certificate",
    )
    require(all(not keys for keys in u["access_keys"].values()), "A control account has keys")
    print(
        "PASS refund evidence: file hashes, real backing arithmetic, source/build/certificate bindings, installed wasm and keylessness"
    )
    live = ROOT / "deploy/testnet.json"
    if live.exists():
        # The public deployment's record, compared with this repository without asking the network.
        t = json.loads(live.read_text())
        sha = lambda p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest()
        want = {
            "kernel": "artifacts/kernel.wasm",
            "board": "artifacts/board.wasm",
            "gate": "artifacts/refund/gate.wasm",
            "intents_before": "artifacts/refund/old.wasm",
            "intents_after": "artifacts/refund/fixed.wasm",
            "receiver": "artifacts/refund/receiver.wasm",
            "ledger": "artifacts/refund/fixed.wasm",
        }
        require(
            t.get("network") == "testnet" and t.get("ok") is True and all(x["ok"] for x in t["checks"]),
            "The testnet record is not a completed run",
        )
        require(all(t["code_sha256"][k] == sha(f) for k, f in want.items()), "The testnet record names other binaries")
        require(
            t["base_sha256"] == load("cases/intents-refund/shelf/manifest.json")["base_sha256"],
            "The testnet record names another environment",
        )
        require(
            t["candidates"]["repair"]["source_sha256"] == c["source_sha256"]
            and t["candidates"]["repair"]["claim"] == c["claim"],
            "The testnet record names another repair",
        )
        paid = t["story"]["proof_paid"]["certificate"]
        require(
            paid["side"] == "proof"
            and paid["proved"] == c["claim"]
            and paid["axioms"] == []
            and paid["delta_sha256"] == sha("cases/intents-refund/proofs/repair.ndjson"),
            "The testnet certificate is for other proof bytes",
        )
        require(all(n == 0 for n in t["access_keys"].values()), "The testnet record lists an access key")
        print(
            "PASS testnet record: the deployed binaries, environment, repair and proof are the ones in this repository (python3 tools/check_live.py asks the network)"
        )
        claimed = ROOT / "evidence/nearai-testnet/claim.json"
        if claimed.exists():
            # A bounty of that deployment paid for a model's proof: the record against the files beside it.
            m = json.loads(claimed.read_text())
            cert = m["bounty_after"]["certificate"]
            listed = {b["id"]: b for b in t["open_bounties"]}[m["bounty"]]
            require(
                m["board"] == t["accounts"]["board"]
                and m["kernel"] == t["accounts"]["kernel"]
                and m["claim"] == listed["settles_with"]
                and m["expression"] == listed["expression"],
                "The model claim is for another board or bounty",
            )
            require(
                cert["proved"] == m["claim"]
                and cert["side"] == "refutation"
                and cert["axioms"] == []
                and cert["base_hash"] == t["base_sha256"],
                "The model claim certificate is for another statement",
            )
            require(
                cert["delta_sha256"] == m["proof"]["sha256"] == sha(m["proof"]["file"]),
                "The model claim certificate is for other proof bytes",
            )
            require(
                m["bounty_after"]["winner"] == m["account"] == m["reveal"]["signer"]
                and m["reveal"]["ok"]
                and m["commit"]["ok"],
                "The model claim was not paid to its account",
            )
            report = load(f"evidence/nearai-testnet/{m['attempt']}/report.json")
            require(
                report["claim"] == m["claim"]
                and report["export"]["delta_sha256"] == m["proof"]["sha256"]
                and report["agent"]["model"] == m["model"]
                and report["check"]["axioms"] == [],
                "The model claim names another run",
            )
            print(
                f"PASS model claim record: bounty {m['bounty']} of the testnet board was paid for the proof file that {m['model']} wrote (./verify.sh --nearai checks the signatures, --live the chain)"
            )

    # Three recorded runs of propose.py with patches of other shapes, and the sample of the extractor against rustc.
    import gzip

    runs = {}
    for d in sorted((ROOT / "evidence/proposals").iterdir()):
        r = json.loads((d / "result.json").read_text())
        require(
            r["state"] == "complete" and all(x["ok"] for x in r["checks"]) and r["implementation_unchanged"] is True,
            f"{d.name}: the recorded run did not complete",
        )
        require(
            r["source_sha256"] == hashlib.sha256((d / "candidate.rs").read_bytes()).hexdigest(),
            f"{d.name}: candidate.rs is not the recorded source",
        )
        require(
            r["full_record_sha256"]
            == hashlib.sha256(gzip.decompress((d / "upgrade-full.json.gz").read_bytes())).hexdigest(),
            f"{d.name}: the full record is not the recorded one",
        )
        require(
            r["installed"] is (r["candidate_status"] == "proved")
            and (r["counterexample"] is None) is (r["candidate_status"] == "proved"),
            f"{d.name}: the gate did not follow the verdict",
        )
        runs[d.name] = r["candidate_status"]
    require(
        sorted(runs.values()) == ["proved", "proved", "refuted"], "The proposal records are not the three described"
    )
    print(
        "PASS proposal records: "
        + ", ".join(f"{k} {v}" for k, v in runs.items())
        + "; a proved patch was installed, the refuted one was not"
    )
    probe = load("evidence/refund-translation/results.json")
    require(
        probe["mismatch_count"] == 0
        and probe["bounded_cases"] >= 2700
        and probe["extractor_sha256"]
        == hashlib.sha256((ROOT / "cases/intents-refund/prepare.py").read_bytes()).hexdigest(),
        "The sample against rustc is for another extractor or found a mismatch",
    )
    print(
        f"PASS extractor sample: {probe['arbitrary_expressions']} expressions and {probe['bounded_cases']} inputs agree with {probe['compiler'].split(' (')[0]}, for the extractor as it is now (a sample, not a proof)"
    )
    # The Lean model of the two events (LogBudget.lean), against the logs of the recorded transactions.
    import check_log_model

    if check_log_model.main():
        raise SystemExit(1)


if __name__ == "__main__":
    main()
