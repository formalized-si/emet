#!/usr/bin/env python3
"""Retain the observed output of a completed local proposal, including its raw receipts."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cases/intents-refund"))
from record import compact


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    job = args.job.resolve()
    out = args.out.resolve()
    report = json.loads((job / "result.json").read_text())
    workspace = job / "workspace"
    case = workspace / "cases/intents-refund"
    raw = (workspace / "run-output/refund/upgrade.json").read_bytes()
    run = json.loads(raw)
    candidate = next(
        c for c in json.loads((case / "candidates.json").read_text())["candidates"] if c["label"] == "user_patch"
    )
    build = next(c for c in run["build"]["candidates"] if c["label"] == "user_patch")
    proof = (case / "proofs/user_patch.ndjson").read_bytes()
    sha = lambda b: hashlib.sha256(b).hexdigest()
    assert report["state"] == "complete" and report["implementation_unchanged"]
    assert report["implementation_before"] == report["implementation_after"]
    assert run["ok"] and all(c["ok"] for c in run["checks"])
    assert candidate["source_sha256"] == sha((job / "candidate.rs").read_bytes()) == build["source_sha256"]
    assert sha((workspace / build["file"]).read_bytes()) == build["wasm_sha256"]
    cert = run["candidate_bounty"]["certificate"]
    assert cert["proved"] == candidate["proved"] and cert["base_hash"] == run["base_sha256"]
    assert cert["delta_sha256"] == sha(proof) and run["candidate_bounty"]["phase"] == "Paid"
    assert report["installed"] == run["installed"]
    if run["installed"]:
        assert cert["side"] == "proof" and run["candidate_status"] == "proved"
        assert run["after_wasm_sha256"] == build["wasm_sha256"] and run["gate"]["phase"] == "Applied"
        assert all(not k for k in run["access_keys"].values())
    else:
        assert cert["side"] == "refutation" and run["candidate_status"] == "refuted"
    out.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(job / "candidate.rs", out / "candidate.rs")
    (out / "proof.ndjson").write_bytes(proof)
    (out / "base.ndjson.gz").write_bytes(gzip.compress((case / "shelf/base.ndjson").read_bytes(), mtime=0))
    (out / "upgrade-full.json.gz").write_bytes(gzip.compress(raw, mtime=0))
    (out / "upgrade.json").write_text(json.dumps(compact(run), indent=2) + "\n")
    report["candidate_file"] = "candidate.rs"
    report["record"] = "upgrade.json"
    report.pop("workspace", None)
    report["full_record_sha256"] = sha(raw)
    (out / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(out.name, run["candidate_status"], "installed=" + str(run["installed"]), len(run["checks"]), "checks")


if __name__ == "__main__":
    main()
