#!/usr/bin/env python3
"""The refund case with a model as the author: it proposes the repair and writes the proof (cases/intents-refund).

usage: python3 -I agent/nearai_patch.py all [--because "<why the attempts in the tree are replaced>"]
       python3 -I agent/nearai_patch.py solve <new attempt dir> [--model deepseek-ai/DeepSeek-V4.1-Flash-1017] [--no-axioms]
       python3 -I agent/nearai_patch.py job <attempt dir> [--trace]
       python3 -I agent/nearai_patch.py jobs
       python3 -I agent/nearai_patch.py record [--billed]

all     One command for a whole series in evidence/nearai-refund: one `solve` per row of SERIES (one per model, and
        one more that asks for a proof with no axiom), `job` for every accepted attempt (one at a time), the offline
        check of each (tools/verify_nearai.py), then `record --billed`.
        Attempts already in the tree are replaced: their directories are removed, their rows stay in attempts.json
        under `superseded` with the reason and the title of the commit that holds their evidence, so they must be committed
        first. The spend ledger is never reset. Needs NEARAI_API_KEY.
solve   An open-weight model served by NEAR AI Cloud gets the pinned upstream file, what was observed (a deposit of 1
        was refunded 100) and the rule in words. It does not get the repaired expression, and it sees no Lean until
        its own expression is bound. It has two tools, in the loop of agent/nearai.py, so every request, response and
        signature and the attestation report are kept the same way:
          propose_patch(expression)  the new right-hand side of `let refund_amount = ...;`. propose.py binds it
                                     (restricted grammar, nothing else changed) and prepare.py tests it. The answer is
                                     a refusal, or a counterexample (after Lean and the native kernel have checked the
                                     generated refutation), or the generated RefundCase.lean with the claim for it
                                     and the lemmas of its sealed environment. The Lean statement of the rule comes
                                     from that generated file, never from this script.
          write_solution(content)    Solution.lean with `Solution.proof` for that claim. It goes through the job that
                                     propose.py runs, stopped before the Rust build: Lean elaborates it, export.sh
                                     exports it and refuses a proof file that declares an axiom, nanoda checks the
                                     sealed environment plus the proof natively. The answer is ACCEPTED or the errors.
        At most 3 rounds. A refused or refuted patch and a rejected proof each end a round and go back to the model;
        the third failure, or the first accepted proof, ends the run; so do 12 requests or 30 minutes. A reply that ends
        at the token limit before a tool call is not a round. Lean's `#print axioms Solution.proof` is recorded
        for an accepted proof. The chain admits propext for a caller's patch; with --no-axioms the attempt asks for
        more, and a proof that depends on any axiom is rejected like any other failed proof.
        Writes <dir>/prompt.md, nearai/, transcript.jsonl, report.json, Solution.lean (the last one written); when
        accepted also candidate.rs, RefundCase.lean (as generated for it), proof.ndjson and base.ndjson.gz (the sealed
        environment); for a refuted round round<k>-candidate.rs, -refutation.ndjson and -base.ndjson.gz.
        Spend goes to evidence/nearai-refund/spend.jsonl, and no request is sent once that ledger reaches USD 1.90
        at list price.
job     For an accepted attempt, the complete job on a fresh local NEAR node:
          cases/intents-refund/propose.py --candidate <dir>/candidate.rs --proof <dir>/Solution.lean --side proof
        (kernel contract, board, gate, the upstream contract built with the model's expression), then
        tools/package_proposal.py adds result.json, upgrade.json and base.ndjson.gz to <dir>; with --trace also
        upgrade-full.json.gz, the transactions with their arguments (about 2.5 MB: it holds both wasm binaries).
        The Rust build cache is deleted afterwards. A job makes no model request: it submits the saved candidate and
        proof, so it can be run again later, for example after the contract binaries changed; the record then holds
        the later run and says when it ran.
jobs    `job` again for every accepted attempt in evidence/nearai-refund, one at a time, then `record`. No model is
        called and no key is needed.
record  evidence/nearai-refund/attempts.json and FACTS.md from what every attempt left, and the table on standard
        output. --billed asks NEAR AI what it charged (needs the key).

Lean elaborates the model's file on this machine. A text filter refuses what runs code during elaboration
(#eval, initialize, run_cmd, IO); it is a filter, not a sandbox.

agent/test_nearai_patch.py runs `solve` against a local stand-in for the API with scripted replies: no key, no
network, nothing recorded.
"""

import base64, gzip, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time

REPO = pathlib.Path(__file__).resolve().parents[1]
CASE = REPO / "cases/intents-refund"
EVIDENCE = REPO / "evidence/nearai-refund"
sys.path[:0] = [str(REPO / "agent"), str(CASE)]
sys.path.append(str(REPO / "tools"))
import nearai, prepare, verify_nearai  # noqa: E402

MAX_ROUNDS, MAX_REQUESTS, MAX_SECONDS = 3, 12, 1800
DEEPSEEK = "deepseek-ai/DeepSeek-V4.1-Flash-1017"
# (attempt name, model, ask for a proof with no axiom at all)
SERIES = [
    ("deepseek-v4.1-flash", DEEPSEEK, False),
    ("qwen3.8-27b", "Qwen/Qwen3.8-27B", False),
    ("glm-5.3-flash", "z-ai/glm-5.3-flash", False),
    ("deepseek-v4.1-flash-noaxioms", DEEPSEEK, True),
]
GRAMMAR = "requested_refund, *deposited, balance_left, unsigned integer literals, parentheses and .min(...)"

PROMPT = """You repair a smart contract on NEAR. Nobody has to trust you or the machine you run on: your patch is installed only after a proof checker that runs inside a NEAR contract has accepted your proof about it.

THE CODE. This is contracts/defuse/src/contract/tokens/mod.rs of NEAR Intents (github.com/near/intents) at revision {revision}, complete and unchanged:

```rust
{source}```

WHAT WAS OBSERVED. On a local NEAR node running this code, an account already held 1000 units of a token in the contract. A deposit of 1 more unit arrived for it, the receiver's mt_on_transfer asked for 100 units back, and resolve_deposit_internal refunded 100.

THE RULE. For each token of a transfer, a refund is never more than the amount requested, never more than the amount deposited in this transfer, never more than the receiver's remaining balance, and is exactly one of those three amounts.

YOUR JOB, with two tools:

1. propose_patch: give the new right-hand side of `let refund_amount = ...;` in resolve_deposit_internal. Nothing else in the file may change. The extractor accepts only this language: {grammar}. The answer is a refusal with its reason, or a counterexample (inputs for which your expression breaks the rule), or the Lean proposition that states the rule for your expression.

2. write_solution: give the whole content of a Lean 4 file that proves that proposition. Lean 4.35.0 elaborates it, it is exported, and nanoda, the kernel the NEAR contract runs, type-checks the export (natively in this loop; the contract checks the same bytes again before the patch is installed). The answer is ACCEPTED or the errors.

You have at most {rounds} rounds: a refused or refuted patch ends a round, and so does a rejected proof. Answer with tool calls.
"""

BOUND = """BOUND (round {k} of {n}). The extractor accepted your expression and found no counterexample on its test inputs.
Candidate source sha256: {digest}

RefundCase.lean was generated for it and is already built. Do not copy or change its definitions:

```lean
{case}```

Prove `{claim}`. Call write_solution with a complete file of this shape:

```lean
import RefundCase

namespace Solution

theorem proof : {claim} := by
  sorry

end Solution
```

What the checker enforces:
- Lean 4.35.0 core library only, and `import RefundCase` is the only import. No Mathlib.
- No sorry, axiom, opaque, native_decide, unsafe, implemented_by or @[extern], and no command that runs code (#eval, initialize, run_cmd).
- The proof may depend on no axiom except propext. The sealed environment on chain holds propext but neither Classical.choice nor Quot.sound, and a proof file that brings an axiom with it is refused. Proofs found by omega or grind bring such axioms with them.{strict}
- Already in the sealed environment: {lemmas}.{tainted} Other core lemmas are allowed; what the proof uses beyond the sealed environment is shipped with it and checked again on chain."""
STRICT = " This attempt asks for more than the chain does: your proof must depend on no axiom at all, not even propext."

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "propose_patch",
            "description": "Propose the new right-hand side of `let refund_amount = ...;`. Returns a refusal, a counterexample, or the Lean proposition to prove.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "Only the expression, without `let` and without the semicolon, made of "
                        + GRAMMAR
                        + ".",
                    }
                },
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_solution",
            "description": "Submit the whole content of Solution.lean: the proof of the proposition propose_patch returned. Returns ACCEPTED or the errors.",
            "parameters": {"type": "object", "properties": {"content": {"type": "string"}}, "required": ["content"]},
        },
    },
]
TEXTS = (
    "",
    "Your last reply was cut off at the output limit before any tool call. Answer with a tool call now: propose_patch with your expression, or write_solution with your proof.",
    "Answer with a tool call: propose_patch with your expression, or write_solution with your proof. If you cannot, reply GAVE UP with the reason.",
)

# Lean runs what these name while it elaborates a file, or they break the rules the prompt states.
FORBIDDEN = re.compile(
    r"\b(sorry|axiom|opaque|native_decide|implemented_by|extern|unsafe|initialize|builtin_initialize|init|run_cmd|run_elab|run_meta|run_tac"
    r"|elab|elab_rules|IO|System)\b|#(?!check\b|print\b)\w+"
)

sha = lambda b: hashlib.sha256(b).hexdigest()
load = lambda p: json.loads(pathlib.Path(p).read_text())


def forbidden(content: str):
    m = FORBIDDEN.search(content)
    if m:
        return f"Solution.lean may not contain `{m.group(0)}`"
    if {w for line in re.findall(r"^\s*import\b(.*)$", content, re.M) for w in line.split()} - {"RefundCase"}:
        return "the only import allowed is RefundCase"


def scrub(text: str, ws: pathlib.Path) -> str:
    """No local path goes to the model or into the record; the proof file is called Solution.lean there."""
    for local, shown in ((str(ws.resolve()), "."), (str(ws), "."), (str(pathlib.Path.home()), "~")):
        text = text.replace(local, shown)
    return text.replace("CandidateProof", "Solution").strip()


def solve(out: pathlib.Path, model: str, strict=False) -> bool:
    if out.exists():
        sys.exit(f"{out} exists: every attempt gets a new directory")
    os.environ.setdefault("NEARAI_LEDGER", str(EVIDENCE / "spend.jsonl"))
    os.environ.setdefault("NEARAI_CAP_USD", "1.9")
    out.mkdir(parents=True)
    upstream = (CASE / "upstream/tokens.rs").read_bytes()
    revision = load(CASE / "candidates.json")["upstream_revision"]
    prompt = PROMPT.format(revision=revision, source=upstream.decode(), grammar=GRAMMAR, rounds=MAX_ROUNDS)
    (out / "prompt.md").write_text(prompt)
    env = dict(os.environ, PATH=f"{pathlib.Path.home() / '.elan/bin'}{os.pathsep}{os.environ.get('PATH', '')}")
    work = pathlib.Path(tempfile.mkdtemp(prefix="emet-patch-"))
    rounds, st = [], {"bound": None, "final": None, "jobs": 0}

    def prepared(candidate: bytes, solution):
        """propose.py's isolated job for this candidate, stopped before the Rust build -> (its case directory, "") or (None, the refusal)."""
        st["jobs"] += 1
        d = work / f"job{st['jobs']}"
        d.mkdir()
        (d / "candidate.rs").write_bytes(candidate)
        cmd = [
            sys.executable,
            str(CASE / "propose.py"),
            "--candidate",
            str(d / "candidate.rs"),
            "--out",
            str(d / "out"),
            "--prepare-only",
        ]
        if solution is not None:
            (d / "Solution.lean").write_text(solution, encoding="utf-8")
            cmd += ["--proof", str(d / "Solution.lean"), "--side", "proof"]
        r = subprocess.run(cmd, capture_output=True, text=True)
        return (
            (d / "out/workspace/cases/intents-refund", "")
            if r.returncode == 0
            else (None, (r.stderr.strip().splitlines() or ["refused"])[-1])
        )

    def export(case: pathlib.Path):
        """export.sh in that job: Lean builds the claim and the proof, a proof file may declare no axiom, nanoda checks all of it natively."""
        try:
            r = subprocess.run(
                ["bash", "cases/intents-refund/export.sh"],
                cwd=case.parents[1],
                env=env,
                capture_output=True,
                text=True,
                timeout=600,
            )
            return r.returncode == 0, scrub(r.stdout + r.stderr, case.parents[1])
        except subprocess.TimeoutExpired:
            return False, "timed out after 600 s: the proof is too slow to elaborate"

    def lean(case: pathlib.Path, name: str, text: str) -> str:
        (case / name).write_text(text)
        r = subprocess.run(
            ["lake", "env", "lean", name], cwd=case, env=env, capture_output=True, text=True, timeout=300
        )
        return scrub(r.stdout + r.stderr, case.parents[1])

    def axioms(case: pathlib.Path):
        """Lean's own answer for the proof in that job -> (the axioms, or None if Lean did not say; the line it printed)."""
        said = lean(case, "Axioms.lean", "import CandidateProof\n#print axioms Solution.proof\n")
        m = re.search(r"'Solution\.proof' (does not depend on any axioms|depends on axioms: \[([^\]]*)\])", said)
        return ([x.strip() for x in (m.group(2) or "").split(",") if x.strip()] if m else None), (
            m.group(0) if m else said[-300:]
        )

    def close(row: dict, message: str) -> str:
        rounds.append({"round": len(rounds) + 1, **row})
        left = MAX_ROUNDS - len(rounds)
        if row.get("proof") == "accepted":
            st["final"] = f"accepted in round {len(rounds)}"
        elif not left:
            st["final"] = f"no accepted patch after {MAX_ROUNDS} rounds"
        return message if row.get("proof") == "accepted" else f"{message}\n{left} round{'s' * (left != 1)} left."

    def tool(_ws, name, args, _env):
        k = len(rounds) + 1
        if name == "propose_patch":
            expr = str(args.get("expression", "")).strip()
            st["bound"] = None
            candidate = upstream.replace(prepare.SITE.encode(), f"let refund_amount = {expr};".encode())
            case, why = prepared(candidate, None)
            if case is None:
                return close(
                    {"expression": expr, "patch": "refused", "reason": why},
                    f"REFUSED (round {k} of {MAX_ROUNDS}): {why}. The expression may use only {GRAMMAR}.",
                )
            subprocess.run([sys.executable, "prepare.py"], cwd=case, check=True, capture_output=True)
            c = next(x for x in load(case / "candidates.json")["candidates"] if x["label"] == "user_patch")
            row = {"expression": expr, "source_sha256": c["source_sha256"], "claim": c["claim"]}
            w = c["counterexample"]
            if w:
                checked, log = export(case)  # the generated refutation, through Lean and the native kernel
                refutation = (case / "proofs/user_patch.ndjson").read_bytes() if checked else b""
                if checked:
                    (out / f"round{k}-candidate.rs").write_bytes(candidate)
                    (out / f"round{k}-refutation.ndjson").write_bytes(refutation)
                    (out / f"round{k}-base.ndjson.gz").write_bytes(
                        gzip.compress((case / "shelf/base.ndjson").read_bytes(), mtime=0)
                    )
                return close(
                    {
                        **row,
                        "patch": "refuted",
                        "counterexample": w,
                        "refutation_checked": checked,
                        "refutation_sha256": sha(refutation) if checked else None,
                        "base_sha256": (case / "shelf/base.sha256").read_text().strip() if checked else None,
                        **({} if checked else {"error": log[-2000:]}),
                    },
                    f"REFUTED (round {k} of {MAX_ROUNDS}): with requested_refund = {w['requested_refund']}, deposited = {w['deposited']}, balance_left = {w['balance_left']} "
                    f"your expression gives {w['actual']}{', ' + w['breaks'] if w.get('breaks') else ''}; the rule requires {w['expected']}."
                    + (
                        " Lean and the kernel (nanoda, native) accept the generated refutation of this patch."
                        if checked
                        else ""
                    ),
                )
            st["bound"] = {**row, "candidate": candidate}
            lemmas = [
                r
                for r in (case / "base_roots.txt").read_text().split()
                if r != "propext" and not r.startswith("Refund.C_")
            ]
            subprocess.run(["lake", "build", "RefundCase"], cwd=case, env=env, capture_output=True, timeout=300)
            needs = dict(
                re.findall(
                    r"'([^']+)' depends on axioms: \[([^\]]*)\]",
                    lean(case, "Lemmas.lean", "import RefundCase\n" + "".join(f"#print axioms {l}\n" for l in lemmas)),
                )
            )
            tainted = (
                " Of these, Lean reports a dependence on "
                + "; ".join(
                    f"{ax} for {', '.join(l for l in lemmas if needs.get(l) == ax)}"
                    for ax in sorted(set(needs.values()))
                )
                + "."
                if needs
                else ""
            )
            return BOUND.format(
                k=k,
                n=MAX_ROUNDS,
                digest=c["source_sha256"],
                claim=c["claim"],
                case=(case / "RefundCase.lean").read_text(),
                lemmas=", ".join(lemmas),
                tainted=tainted,
                strict=STRICT if strict else "",
            )
        if name == "write_solution":
            content = str(args.get("content", ""))
            (out / "Solution.lean").write_text(
                content, encoding="utf-8"
            )  # always the last write_solution call, as tools/verify_nearai.py checks
            b = st["bound"]
            if not b:
                return "error: no patch is bound. Call propose_patch first."
            row = {
                "expression": b["expression"],
                "source_sha256": b["source_sha256"],
                "claim": b["claim"],
                "patch": "bound",
                "solution": content,
            }
            bad = forbidden(content)
            case, why = (None, bad) if bad else prepared(b["candidate"], content)
            ok, log = export(case) if case else (False, why)
            uses, line = axioms(case) if ok else (None, "")
            if ok and strict and uses != []:  # the chain would take it; this attempt asked for a proof with no axiom
                return close(
                    {**row, "proof": "rejected", "axioms": uses, "error": line},
                    f"REJECTED (round {k} of {MAX_ROUNDS}): Lean and the kernel accept this proof, but {line}. This attempt asks for a proof that depends on no axiom at all.",
                )
            if ok:
                proof = (case / "proofs/user_patch.ndjson").read_bytes()
                (out / "candidate.rs").write_bytes(b["candidate"])
                (out / "RefundCase.lean").write_bytes((case / "RefundCase.lean").read_bytes())
                (out / "proof.ndjson").write_bytes(proof)
                (out / "base.ndjson.gz").write_bytes(gzip.compress((case / "shelf/base.ndjson").read_bytes(), mtime=0))
                return close(
                    {
                        **row,
                        "proof": "accepted",
                        "proof_bytes": len(proof),
                        "proof_sha256": sha(proof),
                        "base_sha256": (case / "shelf/base.sha256").read_text().strip(),
                        "axioms": uses,
                        "axioms_line": line,
                    },
                    f"ACCEPTED (round {k} of {MAX_ROUNDS}).",
                )
            if case and "introduces an axiom" in log:  # say which: export.sh only says that there is one
                log += "\n" + axioms(case)[1]
            return close(
                {**row, "proof": "rejected", "error": log[-3000:]},
                f"REJECTED (round {k} of {MAX_ROUNDS}):\n{log[-3000:]}",
            )
        return f"error: unknown tool {name}"

    def guarded(*a):
        try:
            return tool(*a)
        except Exception as e:  # end the run with its signatures fetched, whatever broke here
            st["final"] = f"driver error: {type(e).__name__}: {e}"
            return "error: the checker failed; the run ends here"

    started, t0 = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), time.time()
    try:
        agent = nearai.run(
            work,
            out,
            prompt,
            model,
            env,
            max_turns=MAX_REQUESTS,
            budget_usd=0.3,
            timeout=MAX_SECONDS,
            tools=TOOLS,
            tool=guarded,
            texts=TEXTS,
            stop=lambda: st["final"],
        )
    except Exception as e:  # the loop itself broke: the attempt is still recorded, with what its answered requests cost
        recs = load(out / "nearai/records.json")["records"] if (out / "nearai/records.json").exists() else []
        agent = {
            "backend": "near-ai-cloud",
            "model": model,
            "seconds": round(time.time() - t0, 1),
            "responses": len(recs),
            "signed_responses": 0,
            "prompt_tokens": sum(r["prompt_tokens"] for r in recs),
            "completion_tokens": sum(r["completion_tokens"] for r in recs),
            "cost_usd": round(sum(r["cost_usd"] for r in recs), 4),
            "final": f"the run broke: {type(e).__name__}: {e}",
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)
    last = rounds[-1] if rounds else {}
    ok = last.get("proof") == "accepted"
    report = {
        "case": "cases/intents-refund",
        "upstream_revision": revision,
        "upstream_sha256": sha(upstream),
        "started": started,
        "max_rounds": MAX_ROUNDS,
        "no_axioms_asked": strict,
        "agent": agent,
        "rounds": rounds,
        "accepted": ok,
        **(
            {
                k: last[k]
                for k in (
                    "expression",
                    "source_sha256",
                    "claim",
                    "proof_bytes",
                    "proof_sha256",
                    "base_sha256",
                    "axioms",
                    "axioms_line",
                )
            }
            if ok
            else {}
        ),
    }
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "attempt": out.name,
                "model": model,
                "accepted": ok,
                "final": agent.get("final"),
                "cost_usd": agent.get("cost_usd"),
                "seconds": agent.get("seconds"),
                "rounds": [{k: r.get(k) for k in ("round", "expression", "patch", "proof")} for r in rounds],
            },
            indent=1,
        )
    )
    return ok


def job(d: pathlib.Path, keep_trace=False):
    rep = load(d / "report.json")
    if not rep.get("accepted"):
        sys.exit("not an accepted attempt")
    run = REPO / "run-output/nearai-refund" / d.name
    free = shutil.disk_usage(REPO).free / 1e9
    if free < 8:
        sys.exit(f"{free:.1f} GB free: the job builds the upstream contract twice and 6 GB must stay free")
    shutil.rmtree(run, ignore_errors=True)  # propose.py wants a new directory; an earlier run of this job is scratch
    cmd = [
        "cases/intents-refund/propose.py",
        "--candidate",
        str(d.relative_to(REPO) / "candidate.rs"),
        "--proof",
        str(d.relative_to(REPO) / "Solution.lean"),
        "--side",
        "proof",
        "--out",
        str(run.relative_to(REPO)),
    ]
    t0 = time.time()
    r = subprocess.run([sys.executable, *cmd], cwd=REPO)
    seconds = round(time.time() - t0, 1)
    ws = run / "workspace"
    try:
        if r.returncode:
            sys.exit(f"the job did not complete: see {run / 'result.json'} and the logs beside it")
        subprocess.run([sys.executable, str(REPO / "tools/package_proposal.py"), str(run), str(d)], check=True)
        # The job elaborates the saved Solution.lean and exports it again. When the sealed environment has changed since
        # the model's round (the generator gained a lemma, say), these are other bytes for the same Lean proof: the
        # record of the round keeps its own hashes, the attempt now names what this job exported and the chain checked.
        now, base = (d / "proof.ndjson").read_bytes(), gzip.decompress((d / "base.ndjson.gz").read_bytes())
        rep.update(proof_bytes=len(now), proof_sha256=sha(now), base_sha256=sha(base))
        if not keep_trace:
            (d / "upgrade-full.json.gz").unlink()
        (d / "upgrade.json").write_text(
            json.dumps(load(d / "upgrade.json"), separators=(",", ":")) + "\n"
        )  # the same record on one line: half the bytes
        rep["job"] = {
            "command": "python3 " + " ".join(cmd),
            "started": load(d / "result.json")["started"][:19] + "Z",
            "wall_seconds": seconds,
            "export_is_the_round's": rep["proof_sha256"] == rep["rounds"][-1]["proof_sha256"]
            and rep["base_sha256"] == rep["rounds"][-1]["base_sha256"],
            "code_sha256": {
                "kernel": sha((ws / "artifacts/kernel.wasm").read_bytes()),
                "board": sha((ws / "artifacts/board.wasm").read_bytes()),
                "gate": sha((ws / "contracts/patch-gate/target/near/emet_patch_gate.wasm").read_bytes()),
            },
        }
        (d / "report.json").write_text(json.dumps(rep, indent=2) + "\n")
    finally:
        for cache in ("run-output/refund/target", "run-output/research", ".runtime"):
            shutil.rmtree(ws / cache, ignore_errors=True)


def jobs():
    for f in sorted(EVIDENCE.glob("*/report.json"), key=lambda f: load(f)["started"]):
        if load(f)["accepted"]:
            try:
                job(f.parent)
            except SystemExit as e:
                print(f"{f.parent.name}: {e}", file=sys.stderr)
            subprocess.run(
                [sys.executable, "-S", str(REPO / "tools/verify_nearai.py"), str(f.parent)], stdout=subprocess.DEVNULL
            )
    record(False)


def everything(reason: str):
    d = EVIDENCE
    for _ in range(5):  # HTTP 403 means a local VPN is in the way: wait and ask again before anything is replaced
        if all(nearai.pricing(m) for m in {m for _, m, _ in SERIES}):
            break
        time.sleep(60)
    else:
        sys.exit("NEAR AI Cloud does not answer GET /models with a price for every model")
    old = load(d / "attempts.json") if (d / "attempts.json").exists() else {}
    if old.get("attempts"):
        git = lambda *a: subprocess.run(
            ["git", *a], cwd=REPO, capture_output=True, text=True, check=True
        ).stdout.strip()
        if not reason:
            sys.exit('say why the attempts in the tree are replaced: all --because "<reason>"')
        if git("status", "--porcelain", "--", str(d)):
            sys.exit(
                "evidence/nearai-refund has uncommitted changes: commit them first, so that the replaced attempts stay in the history"
            )
        gone = [
            {
                **row,
                "superseded": {
                    "reason": reason,
                    "evidence_in_commit": 'the commit titled "' + git("log", "-1", "--format=%s") + '"',
                },
            }
            for row in old["attempts"]
        ]
        for row in old["attempts"]:
            shutil.rmtree(d / row["attempt"])
        (d / "attempts.json").write_text(
            json.dumps({"attempts": [], "superseded": old.get("superseded", []) + gone}, indent=1) + "\n"
        )
    used = (
        {json.loads(l)["out"] for l in (d / "spend.jsonl").read_text().splitlines() if l.strip()}
        if (d / "spend.jsonl").exists()
        else set()
    )
    for slug, model, strict in SERIES:
        a = d / next(
            n for n in (slug, *(f"{slug}-{i}" for i in range(2, 99))) if n not in used and not (d / n).exists()
        )
        try:
            if solve(a, model, strict):
                job(a)
        except SystemExit as e:  # this attempt ends here; the others still run and the record shows what is missing
            print(f"{a.name}: {e}", file=sys.stderr)
            if not (
                a / "report.json"
            ).exists():  # stopped before its first request: nothing was asked, nothing is listed
                shutil.rmtree(a, ignore_errors=True)
        if (a / "nearai/records.json").exists():
            subprocess.run(
                [sys.executable, "-S", str(REPO / "tools/verify_nearai.py"), str(a)], stdout=subprocess.DEVNULL
            )
    record(True)


def record(billed_now: bool):
    d = EVIDENCE
    spend = (
        [json.loads(l) for l in (d / "spend.jsonl").read_text().splitlines() if l.strip()]
        if (d / "spend.jsonl").exists()
        else []
    )
    if billed_now:
        import nearai_record

        nearai_record.fetch_billed(d, spend)
    billed = load(d / "billed.json")["nano_usd"] if (d / "billed.json").exists() else None
    billed_usd = (
        lambda rows: round(sum(billed.get(r.get("chat_id"), 0) for r in rows) / 1e9, 4) if billed is not None else None
    )
    rows = []
    for f in sorted(d.glob("*/report.json"), key=lambda f: load(f)["started"]):
        a, rep = f.parent, load(f)
        ag, ver = rep["agent"], a / "nearai/verification.json"
        mine = [r for r in spend if r["out"] == a.name]
        final = str(ag.get("final") or "")
        if (
            not rep["accepted"]
            and len(rep["rounds"]) < MAX_ROUNDS
            and not final.startswith(("driver error", "the run broke", "HTTP", "stopped"))
        ):  # the loop ended by itself
            final = (
                f"stopped at the limit of {MAX_REQUESTS} requests, before a third round ended"
                if ag.get("turns", 0) >= MAX_REQUESTS
                else f"stopped at the time limit of {MAX_SECONDS} s"
                if ag["seconds"] >= MAX_SECONDS
                else "the model stopped: " + (final or "no tool call")
            )
        row = {
            "attempt": a.name,
            "model": ag["model"],
            "started": rep["started"],
            "accepted": rep["accepted"],
            "agent_final": final[:200],
            "rounds": [
                {
                    k: r[k]
                    for k in (
                        "round",
                        "expression",
                        "patch",
                        "counterexample",
                        "refutation_checked",
                        "proof",
                        "proof_bytes",
                    )
                    if k in r
                }
                for r in rep["rounds"]
            ],
            "requests": ag["responses"],
            "signed_responses": f"{ag['signed_responses']}/{ag['responses']}",
            "lost_responses": ag.get("lost_responses", 0),
            "cut_replies": sum(
                load(x)["choices"][0].get("finish_reason") == "length"
                for x in (a / "nearai").glob("*.response.json")
                if b'"choices"' in x.read_bytes()
            ),
            "prompt_tokens": ag["prompt_tokens"],
            "completion_tokens": ag["completion_tokens"],
            "cost_usd": round(sum(r["cost_usd"] for r in mine), 4),
            "billed_usd": billed_usd(mine),
            "model_seconds": ag["seconds"],
            "prompt_sha256": sha((a / "prompt.md").read_bytes()),
            "no_axioms_asked": rep.get("no_axioms_asked", False),
            **{
                k: rep.get(k)
                for k in (
                    "expression",
                    "source_sha256",
                    "claim",
                    "proof_bytes",
                    "proof_sha256",
                    "base_sha256",
                    "axioms",
                )
            },
            "bound_without_a_proof": unproved(a, rep),
            "attestation_verified_offline": load(ver)["ok"] if ver.exists() else None,
            "local_node": None,
        }
        if (a / "RefundCase.lean").exists():
            row["statement_shown_vs_generated_now"], row["statement_lines_that_differ"] = statement_now(a)
        if (a / "upgrade.json").exists():
            u, res = load(a / "upgrade.json"), load(a / "result.json")
            tx = {t["label"]: t["result"] for t in u["transactions"]}
            tgas = lambda keep: round(
                sum(
                    x["outcome"]["gas_burnt"]
                    for x in tx["prove user_patch"]["receipts_outcome"]
                    if keep(x["outcome"]["executor_id"])
                )
                / 1e12,
                1,
            )
            answer = lambda label: json.loads(base64.b64decode(tx[label]["status"]["SuccessValue"]))[0]
            b = u["candidate_bounty"]
            row["local_node"] = {
                "state": res["state"],
                "candidate_status": u["candidate_status"],
                "installed": u["installed"],
                "checks_passed": sum(c["ok"] for c in u["checks"]),
                "checks": len(u["checks"]),
                "kernel_tgas": tgas(lambda who: who == u["accounts"]["kernel"]),
                "reveal_receipts_tgas": tgas(lambda who: True),
                "bounty_phase": b["phase"],
                "bounty_winner": b["winner"],
                "certificate_proved": b["certificate"]["proved"],
                "certificate_axioms": b["certificate"]["axioms"],
                "certificate_delta_sha256": b["certificate"]["delta_sha256"],
                "installed_wasm_sha256": u.get("after_wasm_sha256"),
                "answer_before": answer("old contract refund"),
                "answer_after": answer("same refund after upgrade"),
                "node": "near-sandbox {}, protocol {}".format(
                    u["node"]["version"]["version"], u["node"]["protocol_version"]
                ),
                "job_started": res["started"][:19] + "Z",
                "job_wall_seconds": rep.get("job", {}).get("wall_seconds"),
                "exported_again": rep["proof_sha256"] != rep["rounds"][-1]["proof_sha256"]
                or rep["base_sha256"] != rep["rounds"][-1]["base_sha256"],
                "code_sha256": rep.get("job", {}).get("code_sha256"),
                "full_trace_kept": (a / "upgrade-full.json.gz").exists(),
            }
        rows.append(row)
    series = [r for r in spend if r["out"] in {x["attempt"] for x in rows}]
    out = {
        "attempts": rows,
        "superseded": (load(d / "attempts.json") if (d / "attempts.json").exists() else {}).get("superseded", []),
        "series_requests": len(series),
        "series_usd": round(sum(r["cost_usd"] for r in series), 4),
        "series_billed_usd": billed_usd(series),
        "spend_requests": len(spend),
        "spend_usd_total": round(sum(r.get("cost_usd", 0) for r in spend), 4),
        "billed_usd_total": billed_usd(spend),
        "spend_note": "series_*: the requests of the attempts listed under `attempts`. spend_*: every request of this work, superseded attempts included. "
        "The list price counts all tokens at the prices of GET /v1/models (what the cap counted); billed is NEAR AI's own figure from POST /v1/billing/costs.",
    }
    (d / "attempts.json").write_text(json.dumps(out, indent=1) + "\n")
    text, table = facts(d, out)
    (d / "FACTS.md").write_text(text)
    print(table)


def statement_now(a: pathlib.Path):
    """How the RefundCase.lean a model was shown compares with what prepare.py generates for that candidate today (no Lean needed)."""
    with tempfile.TemporaryDirectory(prefix="emet-statement-") as t:
        r = subprocess.run(
            [
                sys.executable,
                str(CASE / "propose.py"),
                "--candidate",
                str(a / "candidate.rs"),
                "--out",
                t + "/job",
                "--prepare-only",
            ],
            capture_output=True,
        )
        case = pathlib.Path(t) / "job/workspace/cases/intents-refund"
        if r.returncode or subprocess.run([sys.executable, "prepare.py"], cwd=case, capture_output=True).returncode:
            return "not compared: the generator refuses this candidate today", []
        saved, now = (a / "RefundCase.lean").read_text(), (case / "RefundCase.lean").read_text()
        other = [(x, y) for x, y in zip(saved.splitlines(), now.splitlines()) if x != y]
        return verify_nearai.statement(saved, now) or "different Lean", other


def unproved(a: pathlib.Path, rep: dict):
    """An expression that was bound but got no verdict on a proof before the run ended (from the saved requests), or None."""
    requests = sorted((a / "nearai").glob("*.request.json"))
    if rep["accepted"] or not requests:
        return None
    calls, bound = {}, None
    for m in load(requests[-1])["messages"]:
        for tc in m.get("tool_calls") or []:
            calls[tc["id"]] = tc["function"]
        f = calls.get(m.get("tool_call_id"), {})
        if m.get("role") == "tool" and f.get("name") == "propose_patch":
            bound = (
                str(json.loads(f["arguments"]).get("expression", "")).strip()
                if m["content"].startswith("BOUND")
                else None
            )
        elif m.get("role") == "tool" and m["content"].startswith("REJECTED"):
            bound = None  # that expression has a round of its own in the report
    return bound


def facts(d: pathlib.Path, out: dict):
    """FACTS.md: every number and quotation in it comes from the records in d -> (the text, the table of attempts)."""
    rows, gone = out["attempts"], out["superseded"]
    usd = lambda v: "-" if v is None else f"USD {v:.4f}"
    yn = lambda v: "-" if v is None else ("yes" if v else "no")
    said = lambda x: "{round}: `{expression}` ".format(**x) + (
        x["patch"] if x["patch"] != "bound" else "proof " + x["proof"]
    )
    uses = lambda r: "-" if r.get("axioms") is None else (", ".join(r["axioms"]) or "none")

    def table(rs):
        t = [
            "| Attempt | Model | Rounds | Axioms of the accepted proof | Requests | Tokens in / out | List price | Billed | Model time | Kernel contract (local node) | Installed by the gate | Signed responses | Attestation (offline) |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
        ]
        for r in rs:
            n = r["local_node"]
            chain = "accepted, {kernel_tgas:.0f} TGas, bounty {bounty_phase}".format(**n) if n else "-"
            gate = (
                yn(n["installed"]) + ", {checks_passed}/{checks} checks, job {job_wall_seconds:.0f} s".format(**n)
                if n
                else "-"
            )
            rounds = "; ".join(map(said, r["rounds"])) or (
                "none: `" + r["bound_without_a_proof"] + "` bound, no proof submitted"
                if r.get("bound_without_a_proof")
                else "none"
            )
            t.append(
                f"| `{r['attempt']}`{' (asked for no axiom)' if r.get('no_axioms_asked') else ''} | `{r['model']}` | {rounds} | {uses(r)} "
                f"| {r['requests']} | {r['prompt_tokens']:,} / {r['completion_tokens']:,} "
                f"| {usd(r['cost_usd'])} | {usd(r['billed_usd'])} | {r['model_seconds']:.0f} s | {chain} | {gate} | {r['signed_responses']} | {yn(r['attestation_verified_offline'])} |"
            )
        return "\n".join(t)

    ok = [r for r in rows if r["accepted"]]
    ran = [r for r in ok if r["local_node"]]
    span = lambda xs: f"{min(xs):.0f} to {max(xs):.0f}" if min(xs) != max(xs) else f"{xs[0]:.0f}"
    asked = [r for r in rows if r.get("no_axioms_asked")]
    short = [
        f"{len(rows)} attempt{'s' * (len(rows) != 1)} ran, in this order: {', '.join('`' + r['model'] + '`' for r in rows)}. "
        + (
            "Each got the same prompt"
            if len({r["prompt_sha256"] for r in rows}) == 1
            else "The prompts differ between attempts"
        )
        + ": the pinned NEAR Intents source file, the observation and the rule in words. Each model had to propose a replacement for the "
        "refund expression. It also had to write a Lean proof of the claim that the extractor generated for its own expression, "
        "in 3 rounds at most."
        + (
            f" {len(asked)} of them ({', '.join('`' + r['attempt'] + '`' for r in asked)}) asked for a proof with no axiom at all. The others had to stay within "
            "propext, as the chain requires for a caller's patch."
            if asked
            else ""
        )
    ]
    if rows:
        by_round = {k: sum(1 for r in ok if len(r["rounds"]) == k) for k in range(1, MAX_ROUNDS + 1)}
        short.append(
            f"{len(ok)} of {len(rows)} ended with an accepted proof"
            + (" (" + ", ".join(f"{v} in round {k}" for k, v in by_round.items() if v) + ")" if ok else "")
            + "."
            + (
                " Lean reports these axioms for the accepted proofs: "
                + ", ".join(f"`{r['attempt']}` ({uses(r)})" for r in ok)
                + "."
                if ok
                else ""
            )
        )
    if ran:
        before, after = {r["local_node"]["answer_before"] for r in ran}, {r["local_node"]["answer_after"] for r in ran}
        short.append(
            f"For {'each of them' if len(ran) == len(ok) else str(len(ran)) + ' of them'} the complete job ran on a fresh local NEAR node. The kernel contract checked the proof bytes, "
            f"and its receipt burnt {span([r['local_node']['kernel_tgas'] for r in ran])} TGas. The board paid the account that submitted them. "
            f"The keyless gate installed the contract that the job built from the model's source ({sum(r['local_node']['installed'] is True for r in ran)} of {len(ran)} installed). "
            f"The same contract account answered {' or '.join(sorted(before))} before the upgrade and {' or '.join(sorted(after))} after it."
        )
    short.append(
        f"The {out['series_requests']} model requests of these attempts cost {usd(out['series_usd'])} at list price (billed: {usd(out['series_billed_usd'])})."
    )

    def given(a):
        """What the prompt of this attempt says, quoted from the file itself, and the rule as the generated Lean file states it."""
        prompt = (d / a["attempt"] / "prompt.md").read_text()
        quote = lambda head: next((l for l in prompt.splitlines() if l.startswith(head)), "")
        lean = (
            (d / a["attempt"] / "RefundCase.lean").read_text().splitlines()
            if (d / a["attempt"] / "RefundCase.lean").exists()
            else []
        )
        lo = next((i for i, l in enumerate(lean) if l.startswith("def InRange")), None)
        hi = next((i for i, l in enumerate(lean) if l.startswith("theorem ")), None)
        rule = "\n".join("    " + l for l in lean[lo + 1 : hi]) if lo is not None and hi is not None else ""
        return (
            f"The model got one prompt (`{a['attempt']}/prompt.md`, {len(prompt.encode()):,} bytes, sha256 `{a['prompt_sha256'][:16]}…`). It holds:\n\n"
            "- The pinned upstream file, complete and unchanged. Upstream's own comment "
            "`// TEMPORARY LOCAL CHANGE: refunds are NOT capped by deposited amounts` is on the line above the expression.\n"
            f'- "{quote("WHAT WAS OBSERVED.")}"\n- "{quote("THE RULE.")}"\n'
            f"- The language that the extractor accepts ({GRAMMAR}), the two tools and the limit of {MAX_ROUNDS} rounds.\n\n"
            "The prompt does not hold the repaired expression, and it holds no Lean. The answer to an accepted `propose_patch` call then "
            "gives the model five things:\n\n"
            "- `RefundCase.lean` as `prepare.py` generated it for that expression.\n"
            "- The name of the claim.\n"
            "- The shape of `Solution.lean`.\n"
            "- The rules that the checker enforces.\n"
            "- The names of the library lemmas in the sealed environment.\n\n"
            "Each attempt keeps every request in full in `<attempt>/nearai/NNNN.request.json`."
            + (
                f"\n\nThat generated file states the rule as follows (`{a['attempt']}/RefundCase.lean`):\n\n{rule}"
                if rule
                else ""
            )
        )

    repair = next(c for c in load(CASE / "candidates.json")["candidates"] if c["label"] == "repair")
    fixed_wasm = sha((REPO / "artifacts/refund/fixed.wasm").read_bytes())

    def why(r):
        lines = [l.strip() for l in (r.get("error") or r.get("reason") or "").splitlines() if l.strip()]
        keep = [
            l
            for l in lines
            if l != "error: build failed"
            and (
                l.startswith("error")
                or "depends on axioms" in l
                or "introduces an axiom" in l
                or "may not contain" in l
                or "timed out" in l
            )
        ]
        return "; ".join(keep[:3]) or (lines[-1] if lines else "no message")

    def story(a):
        rep, n = load(d / a["attempt"] / "report.json"), a["local_node"]
        price = rep["agent"].get("usd_per_token")
        s = [
            f"### `{a['attempt']}`: `{a['model']}`\n\nThe run started at {a['started']}. It made {a['requests']} requests and took {a['model_seconds']:.1f} s "
            f"from the first request to its end. The cost was {usd(a['cost_usd'])}"
            + (
                f" at the list price of USD {price['prompt'] * 1e6:.2f} / {price['completion'] * 1e6:.2f} per million tokens in / out"
                if price
                else ""
            )
            + f". Result: {a['agent_final']}."
            + (
                " This attempt asked for a proof with no axiom at all. The chain itself admits propext for a caller's patch."
                if a.get("no_axioms_asked")
                else ""
            )
            + (
                f" {a['cut_replies']} of its replies ended at the token limit before any tool call, and the loop asked the model to go on."
                if a.get("cut_replies")
                else ""
            )
            + (f" {a['lost_responses']} of its requests got no response." if a.get("lost_responses") else "")
            + "\n"
        ]
        for r in rep["rounds"]:
            head = f"- Round {r['round']}, expression `{r['expression']}`."
            if r["patch"] == "refused":
                s.append(f"{head} The extractor refused it: {why(r)}.")
            elif r["patch"] == "refuted":
                w = r["counterexample"]
                s.append(
                    f"{head} Refuted. With requested_refund = {w['requested_refund']}, deposited = {w['deposited']}, balance_left = {w['balance_left']} it gives {w['actual']}"
                    + (f", {w['breaks']}" if w.get("breaks") else "")
                    + f". The rule requires {w['expected']}. "
                    + (
                        "Lean and a native build of nanoda accepted the generated counterexample."
                        if r.get("refutation_checked")
                        else "No check ran on the generated counterexample."
                    )
                )
            else:
                text = r.get("solution") or (
                    (d / a["attempt"] / "Solution.lean").read_text()
                    if r["proof"] == "accepted"
                    else "(not kept in report.json)"
                )
                proof = "\n".join(("      " + l).rstrip() for l in text.strip().splitlines())
                free = (
                    ""
                    if r.get("axioms") is None
                    else " The model's proof is axiom-free: Lean reports that `Solution.proof` does not depend on any axioms."
                    if not r["axioms"]
                    else f" The model's proof is not axiom-free: Lean reports that `Solution.proof` depends on {', '.join(r['axioms'])}."
                )
                verdict = (
                    f"Accepted. Lean 4.35.0 elaborated it. The exported proof file ({r['proof_bytes']:,} bytes) declares no axiom. A native build of nanoda "
                    f"type-checked the sealed environment plus the proof.{free}"
                    if r["proof"] == "accepted"
                    else f"Rejected: {why(r)}"
                )
                same = (
                    " This is the expression of upstream's fix (the `repair` candidate of this repository)."
                    if "".join(r["expression"].split()) == repair["expression"]
                    else " This is not the text of upstream's fix."
                )
                s.append(
                    f"{head} The extractor bound it to the claim `Refund.C_{r['source_sha256'][:8]}….Correct` (candidate source sha256 `{r['source_sha256']}`).{same} "
                    f"The model then called `write_solution` with\n\n{proof}\n\n  {verdict}"
                )
        if n:
            again = (
                f" The job elaborated the saved `Solution.lean` and exported it again, because the sealed environment that `prepare.py` generates changed after the model's round. "
                f"The job has {a['proof_bytes']:,} proof bytes against environment `{a['base_sha256'][:16]}…`. "
                f"The round had {rep['rounds'][-1]['proof_bytes']:,} bytes against `{rep['rounds'][-1]['base_sha256'][:16]}…`. "
                "The Lean text is the model's, unchanged."
                if n.get("exported_again")
                else ""
            )
            s.append(
                f"- Complete job (started {n['job_started']}, {n['job_wall_seconds']:.0f} s, {n['node']}): {n['checks_passed']} of {n['checks']} checks passed.{again}\n\n"
                f"  The certificate of the kernel contract proves `{n['certificate_proved'].replace(a['source_sha256'], a['source_sha256'][:8] + '…')}` "
                f"and lists these axioms: {', '.join(n['certificate_axioms']) or 'none'}. The receipt of the kernel contract burnt {n['kernel_tgas']} TGas "
                f"({n['reveal_receipts_tgas']} TGas for all receipts of that transaction). "
                f"The bounty phase is {n['bounty_phase']}, and the winner is `{n['bounty_winner']}`. "
                f"Installed: {yn(n['installed'])}, wasm `{str(n['installed_wasm_sha256'])[:16]}…`"
                + (", byte for byte `artifacts/refund/fixed.wasm`" if n["installed_wasm_sha256"] == fixed_wasm else "")
                + f". The same account answered `{n['answer_before']}` before and `{n['answer_after']}` after."
            )
        elif a["accepted"]:
            s.append("- The complete job has no record for this attempt.")
        if a.get("statement_shown_vs_generated_now"):
            s.append(
                f"- `RefundCase.lean` as the model saw it, compared with the file that `prepare.py` generates for this candidate now: {a['statement_shown_vs_generated_now']}."
                + "".join(
                    f"\n\n      shown: {x.strip()}\n      now:   {y.strip()}"
                    for x, y in a["statement_lines_that_differ"]
                )
            )
        if a.get("bound_without_a_proof"):
            s.append(
                f"- The model proposed `{a['bound_without_a_proof']}`, and the extractor bound it to a claim. The run ended before the checker got a proof of it to judge."
            )
        return "\n".join(s)

    retried = [
        f"`{r['attempt']}` round {x['round']} ({x['patch'] if x['patch'] != 'bound' else 'proof ' + x['proof']})"
        for r in rows
        for x in r["rounds"]
        if x["patch"] != "bound" or x.get("proof") == "rejected"
    ]
    names = []
    for r in rows:
        ver = d / r["attempt"] / "nearai/verification.json"
        for c in load(ver)["checks"] if ver.exists() else []:
            if "names the deployment last started" in c["check"]:
                names.append(f"`{c['detail'].split(' ')[0]}` for `{r['attempt']}`")
    example = (ran or ok or rows or [{"attempt": "<attempt>"}])[0]["attempt"]
    traces = [r["attempt"] for r in ran if r["local_node"]["full_trace_kept"]]
    earlier = ""
    if gone:
        why_gone = sorted({g["superseded"]["reason"] for g in gone})
        earlier = (
            "\n## Earlier attempts, replaced\n\n"
            + table(gone)
            + "\n\n"
            + f"These {len(gone)} attempts are no longer in this tree. The reason: {'; '.join(why_gone)}. Their rows are in `attempts.json` under `superseded`. "
            f"Their requests are still in `spend.jsonl`. Their evidence is in {', '.join(sorted({g['superseded']['evidence_in_commit'] for g in gone}))}. "
            "They are not part of the results above, and `./verify.sh --nearai` does not check them again.\n"
        )
    text = FACTS.format(
        when=(
            f"The model runs started between {min(r['started'] for r in rows)} and {max(r['started'] for r in rows)}."
            if rows
            else "No attempt is recorded."
        )
        + (
            f" The complete jobs started between {min(r['local_node']['job_started'] for r in ran)} and {max(r['local_node']['job_started'] for r in ran)}, with the kernel "
            f"`{ran[0]['local_node']['code_sha256']['kernel'][:16]}…`, the board `{ran[0]['local_node']['code_sha256']['board'][:16]}…` and the gate `{ran[0]['local_node']['code_sha256']['gate'][:16]}…` of `artifacts/`. "
            "A job makes no model request: it submits the saved candidate and proof, so a job can be later than its model run."
            if ran and ran[0]["local_node"].get("code_sha256")
            else ""
        ),
        node=ran[0]["local_node"]["node"] if ran else "no job ran",
        short="\n\n".join(short),
        table=table(rows),
        totals=f"The ledger of this work (`spend.jsonl`), replaced attempts included, has {out['spend_requests']} requests: {usd(out['spend_usd_total'])} at list price, {usd(out['billed_usd_total'])} billed.",
        earlier=earlier,
        given=given((ok or rows)[0]) if rows else "",
        stories="\n\n".join(map(story, rows)),
        example=example,
        retry=(
            "The loop sent a model back "
            + str(len(retried))
            + " time"
            + "s" * (len(retried) != 1)
            + ": "
            + ", ".join(retried)
            + ". "
            if retried
            else "The loop sent no model back in these attempts. "
        )
        + "".join(
            f"No {kind} occurred. "
            for kind, hit in (
                ("refused patch", "refused"),
                ("refuted patch", "refuted"),
                ("rejected proof", "proof rejected"),
            )
            if not any(hit in x for x in retried)
        )
        + "`agent/test_nearai_patch.py` exercises a refuted patch and a rejected proof against a local stand-in for the API. "
        "`cases/intents-refund/test_prepare.py` exercises the extractor's refusals.",
        deployments=", ".join(names) or "none recorded",
        n=len(rows),
        models=len({r["model"] for r in rows}),
        traces=("`" + "`, `".join(traces) + "`") if traces else "no attempt",
    )
    return text, table(rows)


FACTS = """# A model writes the patch and its proof; the kernel contract checks it: recorded facts

`python3 -I agent/nearai_patch.py record` writes this file from the records beside it. Do not edit it by hand.

{when} All times are UTC.

Every chain step ran on a local NEAR node ({node}). The scripts sent nothing to testnet or mainnet. Every number
here is in `attempts.json` or in the named file of an attempt directory.

## In short

{short}

## All attempts

{table}

{totals}

The columns:

- *Rounds*: each expression that the model proposed, and its outcome.
- *List price*: all prompt and completion tokens at the prices of `GET /v1/models`.
- *Billed*: NEAR AI's own figure from `POST /v1/billing/costs` (`billed.json`).
- *Model time*: wall time from the first request to the end of the run, with the local checks in it.
- *Kernel contract*: the gas that the receipt of the kernel contract burnt in the transaction that revealed the proof.
- *Installed by the gate*: the result of the complete job and its wall time, which includes two Rust builds of the
  upstream contract.
{earlier}
## What the model was given

{given}

## Round by round

{stories}

## Who checked what

- The model and the machine it ran on decide nothing. Their output is two texts: an expression and a Lean file.
- `cases/intents-refund/propose.py` and `prepare.py` are the extractor, which we trust. They refuse anything
  outside the expression language or outside the one patch site. They generate the claim for the sha256 of the
  candidate file.
- Lean 4.35.0 elaborates the model's file and `lean4export` exports it. `export.sh` refuses a proof file that
  declares an axiom.
- nanoda type-checks the export twice: as a native build in the model's loop, and as `artifacts/kernel.wasm` inside
  the kernel contract in the complete job. The board pays only on the contract's verdict. The gate installs only
  the registered wasm of a candidate whose claim has a certificate.

## Re-check

Offline, with no network and no API key:

    ./verify.sh --nearai

For each accepted attempt this runs `python3 -S tools/verify_nearai.py evidence/nearai-refund/<attempt>` and the
same with `--tamper`. It checks:

1. The attestation report and the signature on every response (checks 1 to 7 at the top of
   `tools/verify_nearai.py`).
2. `Solution.lean` is the last `write_solution` call in the signed responses. `candidate.rs` is the pinned upstream
   file, and only the expression of the `propose_patch` call differs. `prompt.md` is the first message of every
   signed request. `RefundCase.lean` is in a signed request.
3. The proof file declares no axiom. Its theorem states `Refund.C_<sha256 of candidate.rs>.Correct` and no other
   claim. A native build of nanoda, from the source of the kernel contract, type-checks the sealed environment
   plus the proof.
4. The recorded job is for these bytes. The certificate names this claim, the sha256 of `proof.ndjson` and of the
   sealed environment, and the axioms that Lean reported. The board paid. The installed wasm is the build of the
   source with the sha256 of `candidate.rs`. The answers are 100 before and 1 after. The kernel, board and gate
   binaries are the ones in `artifacts/`.
5. Each changed copy of the evidence fails. 13 copies change the attestation or the signatures. 8 more change the
   prompt, the candidate, the statement, the proof bytes, the sealed environment, the certificate or the installed
   wasm. Two of them change the certificate: its proof bytes and its axioms.
6. With Lean installed: `propose.py --prepare-only` and `export.sh` derive the claim again from `candidate.rs` and
   elaborate `Solution.lean` again. The sealed environment and the proof bytes must be the same bytes.
   `#print axioms` must give the recorded axioms. `RefundCase.lean` must be the text that the model saw, or the
   same Lean with other comments. The output says which of the two.

The complete job again on a fresh local node (it fetches the pinned upstream revision from GitHub and builds it):

    python3 cases/intents-refund/propose.py \\
      --candidate evidence/nearai-refund/{example}/candidate.rs \\
      --proof evidence/nearai-refund/{example}/Solution.lean \\
      --side proof --out run-output/my-refund

A new attempt of your own (it needs a NEAR AI Cloud key and costs about what the table shows):

    export NEARAI_API_KEY=...  NEARAI_LEDGER=$PWD/run-output/my-spend.jsonl
    python3 -I agent/nearai_patch.py solve run-output/my-attempt --model deepseek-ai/DeepSeek-V4.1-Flash-1017
    python3 -I agent/nearai_patch.py job run-output/my-attempt
    python3 -S tools/verify_nearai.py run-output/my-attempt

The complete job again for every accepted attempt, with no model request, and this file again (for example after the
contract binaries changed):

    python3 -I agent/nearai_patch.py jobs

The loop itself against a local stand-in for the API, with scripted replies, no key and no network (it needs Lean):

    python3 agent/test_nearai_patch.py

All attempts again. This replaces this record, so commit the current one first. It needs the key:

    python3 -I agent/nearai_patch.py all --because "<why the attempts are replaced>"

## What this does not show

- The attestation shows which key signed a response: a key that an Intel TDX VM of NEAR AI's model service reported
  in its quote. It says nothing about whether the proof is correct. Lean, nanoda and the kernel contract decide
  that, and they do not look at the attestation. A signed wrong proof is still wrong.
- The script does not validate what needs a network service. That is Intel's TCB status, collateral freshness and
  revocation lists for the platform, and the NVIDIA GPU evidence. The script checks only that GPU evidence is
  present and carries the nonce.
- The script does not check these at all:
  - certificate validity dates
  - the identity of the quoting enclave
  - what the measured container images do
  - that the deployment named in the attested action log loads the weights that its name says
  - that the report and the completions came from the same VM

  The action log names: {deployments}.
- The nonce and the times in `records.json` are the agent's own. To anyone else they show consistency, not
  freshness. The agent fetched the report before the first completion. The check of the report ran afterwards.
- The record has no testnet or mainnet transaction. `prover.test.near` is an account that the job's script created
  on the local node. That script signed and sent the transactions with the model's proof bytes. The model signed
  nothing.
- The model did not find the bug. The prompt told it the observation and the rule, and the pinned file carries
  upstream's comment about the missing cap. Upstream knows the issue and fixed it.
- The claim is about one expression at one site of one pinned file, in a language of `min`, three inputs and
  literals. It is not a proof of the Intents contract. We trust the extractor, the Rust compiler and the
  registration of a wasm for a source, as `docs/TECHNICAL.md` says.
- {n} attempts with {models} models are not a success rate. A new attempt can propose another expression or fail.
- {retry}
- Lean elaborated each model's file on the local machine, behind a text filter that refuses `#eval`, `initialize`,
  `run_cmd`, `IO` and similar. That filter is not a sandbox.
- The checks of the recorded job (item 4 above) compare records that this repository wrote itself. They do not run
  a chain. The complete job runs one.

## Files

- `attempts.json`: every attempt as data. `spend.jsonl`: every request with its tokens and list-price cost.
  `billed.json`: what NEAR AI billed per request.
- `<attempt>/prompt.md`: the prompt. `<attempt>/nearai/NNNN.{{request,response,signature}}.json`: exact request and
  response bytes and NEAR AI's signature. `nearai/attestation.json`, `records.json`, `verification.json`: the report
  fetched before the run, the nonce and hashes, the result of the offline check. `transcript.jsonl`: assistant
  messages and tool results.
- `<attempt>/candidate.rs`: the upstream file with the model's expression. `RefundCase.lean`: the claim generated
  for it, as the model saw it. `Solution.lean`: the model's proof. `proof.ndjson`: its export, the bytes the kernel
  checked. `base.ndjson.gz`: the sealed environment of that candidate.
- `<attempt>/report.json`: the model run and the job. For the run it has the rounds with every proof text, the
  tokens, the cost and the time. For the job it has the command, the wall time, and the sha256 of the kernel, board
  and gate binaries. `result.json`: the result of `propose.py`. `upgrade.json`: the job's transactions without
  their arguments.
- `upgrade-full.json.gz` has the transactions of a job with their arguments. It is about 2.5 MB, most of it the
  two wasm binaries that the job staged. The repository keeps it for {traces}. `result.json` has its sha256 for
  every job, and `python3 -I agent/nearai_patch.py job <attempt> --trace` writes it again.

`attestation.json` contains NEAR AI's measured container configuration, which mentions an `Authorization` header
with a placeholder. The record stores no key of ours: it keeps requests as bodies only.
"""


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["all"]:
        everything(a[a.index("--because") + 1] if "--because" in a else "")
    elif a[:1] == ["solve"] and len(a) >= 2:
        sys.exit(
            0
            if solve(
                pathlib.Path(a[1]).resolve(),
                a[a.index("--model") + 1] if "--model" in a else DEEPSEEK,
                "--no-axioms" in a,
            )
            else 1
        )
    elif a[:1] == ["job"] and len(a) >= 2:
        job(pathlib.Path(a[1]).resolve(), "--trace" in a)
    elif a[:1] == ["jobs"]:
        jobs()
    elif a[:1] == ["record"]:
        record("--billed" in a)
    else:
        sys.exit(__doc__)
