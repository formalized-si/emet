#!/usr/bin/env python3
"""Prover agent, off-chain half: write a Lean proof for a bounty and export the delta.

usage: python3 agent/solve.py <claim> <out_dir> [--shelf shelf/wallet-v5] [--model opus]
                               [--max-turns 120] [--budget-usd 30] [--reuse]
       python3 agent/solve.py <claim> <out_dir> --backend nearai --model deepseek-ai/DeepSeek-V4.1-Flash-1017
                               (an open-weight model in NEAR AI Cloud's attested TEE; see agent/nearai.py)

<claim> is a Lean name on the shelf, e.g. `Wallet.Claim.AllowedReceiversOnly`, or the refutation
side `Wallet.Claim.Refute.SlidingDayCap` (a counterexample). A bare name means `Wallet.Spec.<name>`.

1. Builds a clean Lean workspace in a temporary directory OUTSIDE this repository. It contains
   only the definitions the claim is about (lean/Policy/Core.lean, CoreV2.lean, Spec.lean, Bounties.lean),
   a stub `Solution.lean`, SHELF.md (library lemmas already on the shelf) and `./measure.sh`
   (with its own copy of lean4export). No path in it points back to this repository.
2. Runs an LLM coding agent in it: Claude Code, headless, or (`--backend nearai`) a tool-calling
   loop over NEAR AI Cloud whose every response is signed by a key from a TEE attestation report.
   It may read files in the workspace, edit Solution.lean, and run `lake env lean` and
   `./measure.sh`; nothing else. Every message is saved to transcript.jsonl.
3. Independently re-checks the result: the file compiles, `Solution.proof` has exactly the claim
   as its type, and it depends on no axiom beyond propext / Classical.choice / Quot.sound.
4. Exports the delta against the shelf and checks that the export's head is byte-identical to
   the sealed shelf, and that the delta fits the on-chain size limit.

Writes <out_dir>/{Solution.lean, delta.ndjson, transcript.jsonl, report.json}. The on-chain half
(free dry run, commit, reveal) is agent/courier.cjs.
"""

import argparse, hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile, time

REPO = pathlib.Path(__file__).resolve().parents[1]
ALLOWED_AXIOMS = {"propext", "Classical.choice", "Quot.sound"}
POLICY_FILES = ("Core.lean", "CoreV2.lean", "Spec.lean", "Bounties.lean")

PROMPT = """You are a prover agent competing for an open bounty on NEAR.

Bounty: prove the Lean proposition `{claim}`.
{side}
{definitions} Read the definitions first. Do not edit them.

Write your proof in Solution.lean as

    theorem Solution.proof : {claim} := ...

Rules (the on-chain Lean kernel enforces them; a violation means you are not paid):
- Lean 4.35.0 core library only. No Mathlib, no imports other than {imports}.
- No `sorry`, no `axiom`, no `opaque`, no `native_decide`, no `implemented_by`, no `@[extern]`.
  The proof may depend only on the axioms propext, Classical.choice and Quot.sound.
- Size budget: the chain re-checks your proof inside one transaction, and everything your
  proof uses that is not already on the shelf is shipped and re-checked with it. The exported
  delta must be at most 400,000 bytes. {size_hint}
- Run `./measure.sh` to export your proof exactly as the chain will see it: it prints the delta
  size and the heaviest declarations in it. SHELF.md lists the library lemmas already on the
  shelf; using them costs nothing.
- You may add helper lemmas in Solution.lean (inside `namespace Solution`).

Check your work with:  lake env lean Solution.lean   and then   ./measure.sh
Iterate until it compiles with no errors, no `sorry` warning, and measure.sh says OK.
Then reply with one line: DONE, or GAVE UP with the reason.
"""

SIDE = {
    False: "",
    True: "This is the refutation side of a two-sided bounty: you are paid for a counterexample, i.e. a proof\n"
    "that the original claim is false. Concrete small values (UInt64 literals, short lists) usually work.",
}

SIZE_HINT = (
    "Avoid `omega`, `simp_arith`, `decide` on big goals and heavy `simp`, and avoid library "
    "lemmas whose own proofs use them (many BitVec/Int lemmas do): they drag in thousands of "
    "declarations. Prefer structural induction, `cases`, `rfl`, term-mode proofs and the "
    "UInt64/Nat lemmas listed in SHELF.md."
)

STUB = """import Policy.Bounties
open Wallet

namespace Solution

theorem proof : {claim} := by
  sorry

end Solution
"""

LAKEFILE = """name = "bounty"
defaultTargets = ["Policy", "Solution"]

[[lean_lib]]
name = "Policy"
roots = ["Policy.Core", "Policy.CoreV2", "Policy.Spec", "Policy.Bounties"]

[[lean_lib]]
name = "Solution"
"""

CHECK = """import Solution
#print axioms Solution.proof
#check (Solution.proof : {claim})
"""


def full_name(claim: str) -> str:
    if claim.startswith(("Wallet.", "Refund.")):
        return claim
    return f"Wallet.Spec.{claim}" if "." not in claim else f"Wallet.{claim}"


def prompt_for(claim: str) -> str:
    refund = claim.startswith("Refund.")
    definitions = (
        "It is defined in RefundCase.lean: a restricted expression extracted from a pinned NEAR Intents refund patch. The claim is about that expression, not the entire contract."
        if refund
        else "It is defined under Policy/: Core.lean is the wallet decision function, CoreV2.lean its repair, and Spec.lean/Bounties.lean state their properties."
    )
    side = SIDE[".Refute." in claim or claim.endswith(".Refute")]
    return PROMPT.format(
        claim=claim,
        side=side,
        size_hint=SIZE_HINT,
        definitions=definitions,
        imports="RefundCase" if refund else "the Policy modules",
    )


def sh(cmd, cwd, env=None, timeout=900):
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def lean_env():
    env = dict(os.environ)
    env["PATH"] = str(pathlib.Path.home() / ".elan/bin") + os.pathsep + env.get("PATH", "")
    return env


def lean4export() -> pathlib.Path:
    r = subprocess.run([str(REPO / "tools/build_lean4export.sh")], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("could not build lean4export:\n" + r.stderr)
    return pathlib.Path(r.stdout.strip().splitlines()[-1])


def make_workspace(ws: pathlib.Path, claim: str, shelf: pathlib.Path):
    refund = claim.startswith("Refund.")
    if refund:
        for f in ("RefundCase.lean", "LogBudget.lean"):  # the sealed environment has roots in both
            shutil.copy(REPO / "cases/intents-refund" / f, ws / f)
    else:
        (ws / "Policy").mkdir(parents=True)
        for f in POLICY_FILES:
            shutil.copy(REPO / "lean/Policy" / f, ws / "Policy" / f)
    (ws / "lean-toolchain").write_text((REPO / "lean/lean-toolchain").read_text())
    lakefile = (
        'name = "bounty"\ndefaultTargets = ["RefundCase", "LogBudget", "Solution"]\n\n[[lean_lib]]\nname = "RefundCase"\n\n[[lean_lib]]\nname = "LogBudget"\n\n[[lean_lib]]\nname = "Solution"\n'
        if refund
        else LAKEFILE
    )
    (ws / "lakefile.toml").write_text(lakefile)
    stub = STUB.replace("import Policy.Bounties\nopen Wallet", "import RefundCase") if refund else STUB
    (ws / "Solution.lean").write_text(stub.format(claim=claim))
    tools = ws / ".courier"
    (tools / "shelf").mkdir(parents=True)
    for f in ("base_roots.txt", "base.lines", "base.sha256"):
        shutil.copy(shelf / f, tools / "shelf" / f)
    shutil.copy(REPO / "agent/measure.py", tools / "measure.py")
    shutil.copy(lean4export(), tools / "lean4export")
    shelf_lemmas = [n for n in (shelf / "base_roots.txt").read_text().split() if not n.startswith("Wallet.")]
    (ws / "SHELF.md").write_text(
        "# Library lemmas already on the shelf (free to use)\n\n" + "\n".join(f"- `{n}`" for n in shelf_lemmas) + "\n"
    )
    (ws / "measure.sh").write_text("#!/bin/sh\nexec python3 -I .courier/measure.py . .courier/shelf\n")
    (ws / "measure.sh").chmod(0o755)
    rc, out, err = sh(["lake", "build", "LogBudget" if refund else "Policy"], ws, lean_env())
    if rc != 0:
        sys.exit(f"workspace build failed:\n{out}\n{err}")


def run_agent(ws, claim, out, args):
    prompt = prompt_for(claim)
    cmd = [
        "claude",
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        args.model,
        "--max-turns",
        str(args.max_turns),
        "--max-budget-usd",
        str(args.budget_usd),
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read(./**)",
        "Edit(./Solution.lean)",
        "Write(./Solution.lean)",
        "Bash(lake env lean Solution.lean)",
        "Bash(lake env lean:*)",
        "Bash(./measure.sh)",
        "--disallowedTools",
        "WebFetch",
        "WebSearch",
        "Task",
        "Agent",
        "--strict-mcp-config",
        "--setting-sources",
        "",
    ]
    t0 = time.time()
    with open(out / "transcript.jsonl", "w") as tr:
        p = subprocess.run(
            cmd, cwd=ws, env=lean_env(), stdout=tr, stderr=subprocess.PIPE, text=True, timeout=args.timeout
        )
    final = cost = turns = None
    denied = 0
    for line in (out / "transcript.jsonl").read_text().splitlines():
        try:
            m = json.loads(line)
        except json.JSONDecodeError:
            continue
        if m.get("type") == "result":
            final, cost, turns = m.get("result"), m.get("total_cost_usd"), m.get("num_turns")
        if m.get("subtype") == "permission_denied":
            denied += 1
    return {
        "backend": "claude-code",
        "exit": p.returncode,
        "seconds": round(time.time() - t0, 1),
        "final": final,
        "cost_usd": cost,
        "turns": turns,
        "permission_denials": denied,
        "stderr_tail": p.stderr[-2000:],
        "model": args.model,
    }


def no_local_paths(text: str, ws) -> str:
    """Reports are kept as evidence: the workspace and home directory paths in Lean's output are replaced."""
    for local, shown in ((str(ws.resolve()), "."), (str(ws), "."), (str(pathlib.Path.home()), "~")):
        text = text.replace(local, shown)
    return text


def independent_check(ws, claim):
    (ws / "Check.lean").write_text(CHECK.format(claim=claim))
    env = lean_env()
    rc, out, err = sh(["lake", "build", "Solution"], ws, env)
    if rc != 0:
        return {"compiles": False, "log": no_local_paths(out + err, ws)[-3000:]}
    rc, out, err = sh(["lake", "env", "lean", "Check.lean"], ws, env)
    text = no_local_paths(out + err, ws)
    axioms = set()
    if "does not depend on any axioms" not in text:
        for line in text.splitlines():
            if "depends on axioms:" in line:
                inner = line.split("[", 1)[1].rsplit("]", 1)[0]
                axioms |= {a.strip() for a in inner.split(",") if a.strip()}
    src = (ws / "Solution.lean").read_text()
    return {
        "compiles": rc == 0,
        "type_is_claim": rc == 0 and "error" not in text.lower(),
        "axioms": sorted(axioms),
        "axioms_allowed": axioms <= ALLOWED_AXIOMS,
        "mentions_sorry": "sorry" in src,
        "log": text[-2000:],
    }


def export_delta(ws, out):
    sys.path.insert(0, str(ws / ".courier"))
    import measure

    r = measure.export(ws, ws / ".courier/shelf")
    if not r.get("exported"):
        return {"exported": False, "error": r.get("error")}
    (out / "delta.ndjson").write_bytes(r.pop("delta"))
    r["within_target"] = r["delta_bytes"] <= measure.TARGET_BYTES
    r["within_limit"] = r["delta_bytes"] <= measure.LIMIT_BYTES
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("claim")
    ap.add_argument("out")
    ap.add_argument("--shelf", default="shelf/wallet-v5")
    ap.add_argument("--backend", choices=["claude-code", "nearai"], default="claude-code")
    ap.add_argument("--model", default=None, help="opus / sonnet (claude-code) or a NEAR AI Cloud model id (nearai)")
    ap.add_argument("--max-turns", type=int, default=None)
    ap.add_argument("--budget-usd", type=float, default=None)
    ap.add_argument("--timeout", type=int, default=5400)
    ap.add_argument("--reuse", action="store_true", help="skip the LLM; re-check the Solution.lean in out_dir")
    ap.add_argument("--keep-workspace", action="store_true")
    args = ap.parse_args()
    nearai_backend = args.backend == "nearai"
    args.model = args.model or ("deepseek-ai/DeepSeek-V4.1-Flash-1017" if nearai_backend else "opus")
    args.max_turns = args.max_turns or (60 if nearai_backend else 120)
    args.budget_usd = args.budget_usd if args.budget_usd is not None else (3.0 if nearai_backend else 30.0)
    claim = full_name(args.claim)
    out = pathlib.Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    ws = pathlib.Path(tempfile.mkdtemp(prefix="courier-ws-"))
    try:
        make_workspace(ws, claim, (REPO / args.shelf).resolve())
        report = {
            "claim": claim,
            "shelf": args.shelf,
            "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "workspace": "a fresh temporary directory outside the repository (deleted afterwards)",
        }
        if args.reuse:
            shutil.copy(out / "Solution.lean", ws / "Solution.lean")
            report["agent"] = {"reused": True}
        else:
            if nearai_backend:
                sys.path.insert(0, str(REPO / "agent"))
                import nearai

                prompt = prompt_for(claim)
                report["agent"] = nearai.run(
                    ws, out, prompt, args.model, lean_env(), args.max_turns, args.budget_usd, args.timeout
                )
            else:
                report["agent"] = run_agent(ws, claim, out, args)
            shutil.copy(ws / "Solution.lean", out / "Solution.lean")
        report["check"] = independent_check(ws, claim)
        ok = (
            report["check"].get("compiles")
            and report["check"].get("axioms_allowed")
            and not report["check"].get("mentions_sorry")
        )
        if ok:
            report["export"] = export_delta(ws, out)
            ok = (
                report["export"].get("exported")
                and report["export"].get("shelf_head_matches")
                and report["export"].get("within_limit")
                and not report["export"].get("forbidden_in_delta")
            )
        report["ready_to_claim"] = bool(ok)
        if args.reuse and (out / "report.json").exists():
            (out / "recheck.json").write_text(
                json.dumps(
                    {
                        "check": report["check"],
                        "export": report.get("export"),
                        "ready_to_claim": report["ready_to_claim"],
                    },
                    indent=2,
                )
                + "\n"
            )
        else:
            (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(
            json.dumps(
                {
                    "claim": claim,
                    "ready_to_claim": report["ready_to_claim"],
                    "export": {k: v for k, v in (report.get("export") or {}).items() if k != "heaviest"},
                    "agent": {k: report["agent"].get(k) for k in ("seconds", "cost_usd", "turns", "final")},
                },
                indent=1,
            )
        )
        sys.exit(0 if ok else 1)
    finally:
        if args.keep_workspace:
            print("workspace kept at", ws, file=sys.stderr)
        else:
            shutil.rmtree(ws, ignore_errors=True)


if __name__ == "__main__":
    main()
