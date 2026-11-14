#!/usr/bin/env python3
"""Run a caller-supplied refund patch through an isolated local proof/upgrade job.

The supported input is the complete pinned tokens.rs with only the refund
expression changed. No Emet implementation file is edited. This is a workspace
isolation boundary, not an OS sandbox for caller-supplied Lean code.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from prepare import HERE, bind_candidate, sha

ROOT = HERE.parents[1]


def ensure_native_tools():
    if not (ROOT / "tools/native/target/release/proof-courier-native").is_file():
        subprocess.run(["cargo", "+1.98.0", "build", "--release", "--locked"], cwd=ROOT / "tools/native", check=True)


def implementation_fingerprint():
    paths = []
    for directory in ["agent", "cases/intents-refund", "tools", "contracts/kernel", "contracts/patch-gate"]:
        for p in (ROOT / directory).rglob("*"):
            if p.is_file() and not any(x in p.parts for x in ["__pycache__", "target", ".lake", ".git"]):
                paths.append(p)
    paths += [ROOT / "artifacts" / name for name in ["kernel.wasm", "board.wasm", "refund/gate.wasm"]]
    return sha("".join(str(p.relative_to(ROOT)) + "\0" + sha(p.read_bytes()) + "\n" for p in sorted(paths)).encode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--proof", type=Path, help="optional Lean file defining Solution.proof")
    parser.add_argument("--side", choices=["proof", "refutation"], default="proof", help="side proved by --proof")
    parser.add_argument(
        "--prepare-only", action="store_true", help="prepare the isolated job without building or running it"
    )
    args = parser.parse_args()
    out = args.out.resolve()
    if out == ROOT or (out.is_relative_to(ROOT) and not out.is_relative_to(ROOT / "run-output")):
        raise SystemExit("Use run-output/ or a new directory outside the repository")
    if out.exists() and any(out.iterdir()):
        raise SystemExit("Output directory must be new or empty")
    out.mkdir(parents=True, exist_ok=True)
    report = {
        "state": "checking_input",
        "network": "local sandbox",
        "started": datetime.now(timezone.utc).isoformat(),
        "candidate_file": str(args.candidate.resolve()),
        "implementation_before": implementation_fingerprint(),
    }

    def save():
        (out / "result.json").write_text(json.dumps(report, indent=2) + "\n")

    save()
    try:
        original = (HERE / "upstream/tokens.rs").read_bytes()
        candidate = args.candidate.read_bytes()
        if candidate == original:
            raise ValueError("Candidate is unchanged")
        expression, ast = bind_candidate(original, candidate)
        report.update(source_sha256=sha(candidate), expression=expression, ast=ast)
        save()
        if not args.prepare_only and (
            not (ROOT / "node_modules/near-workspaces").is_dir()
            or not (ROOT / ".sandbox/2.14.0/near-sandbox").is_file()
        ):
            raise ValueError("Run ./verify.sh --refund once to install the local Node/sandbox dependencies")
        ensure_native_tools()
        job = out / "workspace"
        job.mkdir()
        ignore = shutil.ignore_patterns("target", ".lake", "__pycache__", "node_modules", ".git")
        for src in ["agent", "tools", "cases/intents-refund", "contracts/kernel", "contracts/patch-gate"]:
            target = job / src
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(ROOT / src, target, ignore=ignore)
        (job / "artifacts").mkdir()
        for file in ["kernel.wasm", "board.wasm"]:
            shutil.copyfile(ROOT / "artifacts" / file, job / "artifacts" / file)
        # Reuse tool binaries/dependencies without granting candidate data any control over them.
        (job / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        (job / ".tools").symlink_to(ROOT / ".tools", target_is_directory=True)
        (job / ".sandbox").symlink_to(ROOT / ".sandbox", target_is_directory=True)
        native = job / "tools/native/target/release"
        native.mkdir(parents=True)
        shutil.copyfile(ROOT / "tools/native/target/release/proof-courier-native", native / "proof-courier-native")
        (native / "proof-courier-native").chmod(0o755)
        gate = job / "contracts/patch-gate/target/near"
        gate.mkdir(parents=True)
        shutil.copyfile(ROOT / "artifacts/refund/gate.wasm", gate / "emet_patch_gate.wasm")
        case = job / "cases/intents-refund"
        proposal = {"expression": expression}
        if args.proof:
            shutil.copyfile(args.proof, case / "CandidateProof.lean")
            proposal.update(external_proof=True, proof_side=args.side)
            with (case / "lakefile.toml").open("a") as file:
                file.write('\n[[lean_lib]]\nname = "CandidateProof"\n')
        (case / "proposal.json").write_text(json.dumps(proposal, indent=2) + "\n")
        shutil.copyfile(args.candidate, out / "candidate.rs")
        report["workspace"] = str(job)
        report["state"] = "prepared"
        save()
        if args.prepare_only:
            return
        env = dict(os.environ)
        env["EMET_PATCH_CANDIDATE"] = "user_patch"

        def step(label, command):
            if implementation_fingerprint() != report["implementation_before"]:
                raise ValueError("Original implementation inputs changed while this job was running; start a fresh job")
            report["state"] = label
            save()
            print(label, flush=True)
            with (out / (label + ".log")).open("w") as log:
                result = subprocess.run(command, cwd=job, env=env, stdout=log, stderr=subprocess.STDOUT)
            if result.returncode:
                raise RuntimeError(f"{label} failed ({result.returncode}); inspect {label}.log")

        step("proof", ["bash", "cases/intents-refund/export.sh"])
        catalog = json.loads((case / "candidates.json").read_text())
        bound = next(c for c in catalog["candidates"] if c["label"] == "user_patch")
        if bound["source_sha256"] != report["source_sha256"]:
            raise ValueError("Prepared source differs from caller input")
        report["claim"] = bound["claim"]
        report["counterexample"] = bound["counterexample"]
        save()
        step(
            "build",
            ["python3", "cases/intents-refund/build.py", "--candidate", "original", "--candidate", "user_patch"],
        )
        step("local_upgrade", ["node", "cases/intents-refund/upgrade.cjs"])
        result = json.loads((job / "run-output/refund/upgrade.json").read_text())
        if not result.get("ok"):
            raise ValueError("Local protocol run did not complete")
        report.update(
            state="complete",
            candidate_status=result["candidate_status"],
            installed=result["installed"],
            checks=result["checks"],
            record=str(job / "run-output/refund/upgrade.json"),
        )
    except Exception as error:
        # A failed finality/readback check can follow a successful installation.
        # A process error is not evidence that the target retained its old code.
        attempted = report["state"] == "local_upgrade"
        report.update(
            state="failed" if attempted else "refused", error=str(error), installed=None if attempted else False
        )
        save()
        print(str(error), file=sys.stderr)
        return 1
    finally:
        report["implementation_after"] = implementation_fingerprint()
        report["implementation_unchanged"] = report["implementation_after"] == report["implementation_before"]
        if not report["implementation_unchanged"]:
            report["error"] = "Original implementation inputs changed during the job"
            if report["state"] == "complete":
                report["state"] = "completed_with_source_changes"
        report["finished"] = datetime.now(timezone.utc).isoformat()
        save()
    print(
        json.dumps(
            {
                k: report.get(k)
                for k in ["state", "candidate_status", "installed", "implementation_unchanged", "record"]
            },
            indent=2,
        )
    )
    return 0 if report["implementation_unchanged"] else 1


if __name__ == "__main__":
    sys.exit(main())
