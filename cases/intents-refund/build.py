#!/usr/bin/env python3
"""Build the pinned external contract with exactly one reviewed patch site.

No deployment, remote mutation, or transaction signing occurs in this command.
The Rust toolchain/compiler remains part of the trusted build boundary.
"""

import argparse
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

from prepare import HERE, SITE, bind_candidate, sha

ROOT = HERE.parent.parent
REVISION = "35044fd1795b0de9d1ac269c6aa28a0d6a7efdfa"
REPOSITORY = "https://github.com/near/intents.git"
SOURCE = "contracts/defuse/src/contract/tokens/mod.rs"


def run(*args, cwd, **kwargs):
    return subprocess.run(args, cwd=cwd, check=True, **kwargs)


def tree_hash(directory):
    rows = []
    for p in sorted(directory.rglob("*")):
        if p.is_file():
            rows.append(str(p.relative_to(directory)) + "\0" + sha(p.read_bytes()) + "\n")
    return sha("".join(rows).encode())


def compare(name, data):
    """Say whether this build is the committed binary. Nothing depends on the answer: record.py installs the build."""
    committed = ROOT / "artifacts/refund" / name
    if committed.is_file():
        same = committed.read_bytes() == data
        print(
            ("ok   " if same else "DIFF ")
            + f"{name} built from source "
            + (f"is artifacts/refund/{name}, byte for byte" if same else f"differs from artifacts/refund/{name}"),
            flush=True,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, default=ROOT / "run-output/research/intents-case")
    parser.add_argument("--candidate", action="append", help="a label from candidates.json; repeat for multiple builds")
    args = parser.parse_args()
    checkout = args.checkout.resolve()
    output = ROOT / "run-output/refund"
    output.mkdir(parents=True, exist_ok=True)
    upstream = (HERE / "upstream/tokens.rs").read_bytes()
    records = json.loads((HERE / "candidates.json").read_text())["candidates"]
    candidates = {r["label"]: r for r in records}
    if not checkout.exists():
        checkout.mkdir(parents=True)
        run("git", "init", "-q", cwd=checkout)
        run("git", "remote", "add", "origin", REPOSITORY, cwd=checkout)
        run("git", "fetch", "--depth", "1", "origin", REVISION, cwd=checkout)
        run("git", "checkout", "--detach", "FETCH_HEAD", cwd=checkout)
    actual = run("git", "rev-parse", "HEAD", cwd=checkout, capture_output=True, text=True).stdout.strip()
    if actual != REVISION:
        raise RuntimeError("Checkout revision differs from pinned upstream")
    committed = run("git", "show", f"HEAD:{SOURCE}", cwd=checkout, capture_output=True).stdout
    if committed != upstream:
        raise RuntimeError("Vendored upstream source differs from the pinned Git object")
    changes = run(
        "git", "diff", "--name-only", "HEAD", cwd=checkout, capture_output=True, text=True
    ).stdout.splitlines()
    if any(p != SOURCE for p in changes):
        raise RuntimeError("Checkout has unrelated tracked changes; refusing to build")
    if (checkout / SOURCE).read_bytes() != upstream:
        bind_candidate(upstream, (checkout / SOURCE).read_bytes())
    # Build from Git's archive, not an agent-modifiable working tree. Compiler caches live outside it.
    archive = run("git", "archive", REVISION, cwd=checkout, capture_output=True).stdout
    temporary = tempfile.TemporaryDirectory(prefix="source-", dir=output)
    source = Path(temporary.name)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(source, filter="data")
    flags = f"--cfg=near -C link-arg=-s --remap-path-prefix={source}=/emet/upstream"
    wrapper = ""
    if os.environ.get("EMET_REPRO", "1") == "1":
        # Same bytes on macOS arm64 and Linux x86_64: registry paths remapped, build host kept out of symbol hashes.
        cargo_home = os.environ.get("CARGO_HOME") or str(Path.home() / ".cargo")
        flags += f" --remap-path-prefix={cargo_home}/git/checkouts=/cargo-git --remap-path-prefix={cargo_home}/registry/src=/cargo-registry"
        wrapper = str(ROOT / "tools/rustc_stable_metadata.sh")
    env = dict(
        os.environ,
        RUSTFLAGS=flags,
        RUSTC_WRAPPER=wrapper,
        RUSTC_WORKSPACE_WRAPPER="",
        CARGO_TARGET_DIR=str(output / "target"),
    )
    env.pop("CARGO_ENCODED_RUSTFLAGS", None)
    report = {
        "upstream": REPOSITORY,
        "revision": REVISION,
        "at": datetime.now(timezone.utc).isoformat(),
        "compiler": run("rustc", "+1.98.0", "--version", cwd=checkout, capture_output=True, text=True).stdout.strip(),
        "boundary": "Pinned upstream and one extracted expression; the Rust compiler and extractor are trusted.",
        "candidates": [],
    }
    try:
        for label in args.candidate or ["original", "repair"]:
            if label not in candidates:
                raise ValueError("Unknown candidate label")
            candidate = (HERE / "candidates" / f"{label}.rs").read_bytes()
            expression, ast = bind_candidate(upstream, candidate)
            expected = candidates[label]
            if sha(candidate) != expected["source_sha256"] or ast != expected["ast"]:
                raise RuntimeError("Candidate source or generated AST has changed")
            (source / SOURCE).write_bytes(candidate)
            expected_tree = tree_hash(source)
            same_as = None
            if expected.get("identical_to_upstream"):
                # This candidate claims to be upstream's own file. Then the whole tree must be upstream's tree
                # at that commit: fetch it and compare every file.
                same_as = expected["identical_to_upstream"]["revision"]
                run("git", "fetch", "-q", "--depth", "1", "origin", same_as, cwd=checkout)
                with tempfile.TemporaryDirectory(prefix="parent-", dir=output) as other:
                    theirs = run("git", "archive", same_as, cwd=checkout, capture_output=True).stdout
                    with tarfile.open(fileobj=io.BytesIO(theirs)) as tar:
                        tar.extractall(other, filter="data")
                    if tree_hash(Path(other)) != expected_tree:
                        raise RuntimeError("The repaired tree is not upstream's tree at " + same_as)
            log = output / f"build-{label}.log"
            with log.open("w") as stream:
                run(
                    "cargo",
                    "+1.98.0",
                    "build",
                    "--locked",
                    "--release",
                    "--target",
                    "wasm32-unknown-unknown",
                    "--features",
                    "contract",
                    "-p",
                    "defuse",
                    cwd=source,
                    env=env,
                    stdout=stream,
                    stderr=subprocess.STDOUT,
                )
            if tree_hash(source) != expected_tree:
                raise RuntimeError("Source tree changed during compilation")
            data = (output / "target/wasm32-unknown-unknown/release/defuse.wasm").read_bytes()
            name = {"original": "old", "repair": "fixed"}.get(label, label) + ".wasm"
            (output / name).write_bytes(data)
            report["candidates"].append(
                dict(
                    label=label,
                    source_sha256=sha(candidate),
                    source_tree_sha256=expected_tree,
                    wasm_sha256=sha(data),
                    claim=expected["claim"],
                    expression=expression,
                    file=str((output / name).relative_to(ROOT)),
                    **({"source_tree_is_upstream_revision": same_as} if same_as else {}),
                )
            )
            print(label, sha(candidate), sha(data), flush=True)
            compare(name, data)
        with (output / "build-receiver.log").open("w") as stream:
            run(
                "cargo",
                "+1.98.0",
                "build",
                "--locked",
                "--release",
                "--target",
                "wasm32-unknown-unknown",
                "-p",
                "multi-token-receiver-stub",
                cwd=source,
                env=env,
                stdout=stream,
                stderr=subprocess.STDOUT,
            )
        if tree_hash(source) != expected_tree:
            raise RuntimeError("Source tree changed during receiver compilation")
        data = (output / "target/wasm32-unknown-unknown/release/multi_token_receiver_stub.wasm").read_bytes()
        (output / "receiver.wasm").write_bytes(data)
        compare("receiver.wasm", data)
        report["receiver_sha256"] = sha(data)
        (output / "build.json").write_text(json.dumps(report, indent=2) + "\n")
    finally:
        temporary.cleanup()


if __name__ == "__main__":
    main()
