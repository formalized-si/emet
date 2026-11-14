#!/usr/bin/env python3
"""Package a completed local run; retain full traces separately from the UI summary."""

import gzip
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "run-output/refund"
EVIDENCE = ROOT / "evidence/refund"
ARTIFACTS = ROOT / "artifacts/refund"
sha = lambda b: hashlib.sha256(b).hexdigest()


def compact(value):
    if isinstance(value, list):
        return [compact(x) for x in value]
    if not isinstance(value, dict):
        return value
    result = {k: compact(v) for k, v in value.items()}
    # The full transaction args include the staged wasm repeatedly. The original
    # trace remains downloadable; summaries keep hashes, outcomes and receipt logs.
    tx = result.get("transaction")
    if isinstance(tx, dict) and "actions" in tx:
        result["transaction"] = {k: v for k, v in tx.items() if k != "actions"}
    return result


def main():
    records = {name: json.loads((OUT / f"{name}.json").read_text()) for name in ["replay", "upgrade"]}
    for name, data in records.items():
        if (
            data.get("ok") is not True
            or data.get("error")
            or not data.get("checks")
            or not all(c.get("ok") is True for c in data["checks"])
        ):
            raise ValueError(f"{name} did not complete successfully")
    build = json.loads((OUT / "build.json").read_text())
    for item in build["candidates"]:
        if sha((ROOT / item["file"]).read_bytes()) != item["wasm_sha256"]:
            raise ValueError("Build artifact differs")
    if records["upgrade"]["after_wasm_sha256"] != next(
        x["wasm_sha256"] for x in build["candidates"] if x["label"] == "repair"
    ):
        raise ValueError("Installed wasm differs from build")
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    for name, data in records.items():
        raw = (OUT / f"{name}.json").read_bytes()
        (EVIDENCE / f"{name}-full.json.gz").write_bytes(gzip.compress(raw, mtime=0))
        summary = compact(data)
        summary["full_trace"] = {"file": f"{name}-full.json.gz", "uncompressed_sha256": sha(raw), "bytes": len(raw)}
        (EVIDENCE / f"{name}.json").write_text(json.dumps(summary, indent=2) + "\n")
    for file in ["old.wasm", "fixed.wasm", "receiver.wasm", "build.json"]:
        shutil.copyfile(OUT / file, ARTIFACTS / file)
    gate = ROOT / "contracts/patch-gate/target/near/emet_patch_gate.wasm"
    if sha(gate.read_bytes()) != records["upgrade"]["patch_gate_sha256"]:
        raise ValueError("Gate build differs from the run")
    shutil.copyfile(gate, ARTIFACTS / "gate.wasm")
    paths = sorted(
        [
            *(p for p in EVIDENCE.iterdir() if p.is_file() and p.name != "files.json"),
            *(p for p in ARTIFACTS.iterdir() if p.is_file()),
            *(p for p in (ROOT / "cases/intents-refund").glob("*.lean")),
            ROOT / "cases/intents-refund/candidates.json",
            ROOT / "cases/intents-refund/upstream/tokens.rs",
            *(ROOT / "cases/intents-refund/proofs").glob("*.ndjson"),
            *(p for p in (ROOT / "cases/intents-refund/shelf").iterdir() if p.is_file()),
        ]
    )
    manifest = {
        "scope": "Recorded local evidence; file integrity is not a new chain execution.",
        "files": [
            {"path": str(p.relative_to(ROOT)), "sha256": sha(p.read_bytes()), "bytes": p.stat().st_size} for p in paths
        ],
    }
    (EVIDENCE / "files.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Packaged completed refund replay and proof-gated upgrade:", len(paths), "files")


if __name__ == "__main__":
    main()
