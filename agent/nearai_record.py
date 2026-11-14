#!/usr/bin/env python3
"""One row per NEAR AI Cloud prover attempt, from what each attempt left on disk.

usage: python3 -I agent/nearai_record.py [evidence/nearai] [--billed]

For every <dir>/<attempt>/report.json (written by agent/solve.py --backend nearai): the claim, the model, tokens,
cost, wall time and repair rounds from the report; whether nanoda, this repository's kernel built natively
(tools/native), type-checks shelf + delta; whether the kernel contract accepted it on a local node
(<dir>/local-node.json, written by agent/nearai_local.cjs); and whether NEAR AI's attestation and signatures
verified (<attempt>/nearai/verification.json, written by tools/verify_nearai.py).
Writes <dir>/attempts.json and prints the summary of the work to standard output as Markdown: what was run, the
table of attempts, a note per attempt (<dir>/notes.json, optional: {attempt: text}), what the attestation check
shows and does not show, and the commands. It writes no other file.

Two costs per attempt. `cost_usd` is what the spend cap counted: every prompt and completion token of every
response at the list price of GET /v1/models. `billed_usd` is what NEAR AI charged: with --billed (needs the API
key, one call per 100 requests) POST /v1/billing/costs is asked for every request in <dir>/spend.jsonl and the
answer is kept in <dir>/billed.json. It is lower because cached input tokens are charged at the cache-read price.
"""

import json, pathlib, subprocess, sys, tempfile, uuid

REPO = pathlib.Path(__file__).resolve().parents[1]
NATIVE = REPO / "tools/native/target/release/proof-courier-native"


def native_accepts(shelf: pathlib.Path, delta: pathlib.Path) -> bool:
    if not NATIVE.exists():
        subprocess.run(["cargo", "build", "--release", "--quiet"], cwd=REPO / "tools/native", check=True)
    with tempfile.NamedTemporaryFile(suffix=".ndjson") as f:
        f.write((shelf / "base.ndjson").read_bytes() + delta.read_bytes())
        f.flush()
        return subprocess.run([str(NATIVE), f.name], capture_output=True).returncode == 0


def fetch_billed(d: pathlib.Path, spend):
    sys.path.insert(0, str(REPO / "agent"))
    import nearai

    ids = {
        str(uuid.uuid5(uuid.NAMESPACE_DNS, r["chat_id"])): r["chat_id"] for r in spend if r.get("chat_id")
    }  # the `inference-id` of a response
    billed, todo = {}, list(ids)
    for i in range(0, len(todo), 100):
        st, raw = nearai.http(
            "POST", "/billing/costs", json.dumps({"requestIds": todo[i : i + 100]}).encode(), nearai.api_key()
        )
        if st != 200:
            raise SystemExit(f"POST /billing/costs: HTTP {st}: {raw[:200]!r}")
        for x in json.loads(raw)["requests"]:
            billed[ids[x["requestId"]]] = x["costNanoUsd"]
    (d / "billed.json").write_text(
        json.dumps({"source": "POST /v1/billing/costs, nano-USD per chat completion id", "nano_usd": billed}, indent=1)
        + "\n"
    )


def main(d: pathlib.Path, billed_now=False):
    spend = (
        [json.loads(l) for l in (d / "spend.jsonl").read_text().splitlines() if l.strip()]
        if (d / "spend.jsonl").exists()
        else []
    )
    if billed_now:
        fetch_billed(d, spend)
    billed = json.loads((d / "billed.json").read_text())["nano_usd"] if (d / "billed.json").exists() else None
    billed_usd = (
        lambda rows: round(sum(billed.get(r.get("chat_id"), 0) for r in rows) / 1e9, 4) if billed is not None else None
    )
    local = json.loads((d / "local-node.json").read_text()) if (d / "local-node.json").exists() else {}
    on_chain = {r["dir"]: r for r in local.get("results", [])}
    rows = []
    for rep_file in sorted(d.glob("*/report.json")):
        a, rep = rep_file.parent, json.loads(rep_file.read_text())
        ag, chk, exp = rep["agent"], rep.get("check", {}), rep.get("export") or {}
        delta = a / "delta.ndjson"
        ver = a / "nearai/verification.json"
        chain = on_chain.get(str(a.resolve().relative_to(REPO)))
        if "Unknown constant `Solution.proof`" in (chk.get("log") or ""):
            why = "Solution.lean has no theorem Solution.proof"
        elif not chk.get("compiles"):
            why = "Solution.lean does not compile"
        elif chk.get("mentions_sorry"):
            why = "the proof still contains sorry"
        elif not chk.get("axioms_allowed"):
            why = "uses an axiom that is not allowed"
        elif not rep.get("ready_to_claim"):
            why = "the export is too big or does not match the shelf"
        else:
            why = None
        rows.append(
            {
                "attempt": a.name,
                "claim": rep["claim"],
                "model": ag.get("model"),
                "started": rep.get("started"),
                "prompt_tokens": ag.get("prompt_tokens"),
                "completion_tokens": ag.get("completion_tokens"),
                "cost_usd": ag.get("cost_usd"),
                "billed_usd": billed_usd([r for r in spend if r["out"] == a.name]),
                "wall_seconds": ag.get("seconds"),
                "requests": ag.get("responses"),
                "tool_calls": ag.get("tool_calls"),
                "requests_without_response": sum(1 for r in spend if r["out"] == a.name and r.get("lost_response")),
                "repair_rounds": ag.get("repair_rounds"),
                "agent_final": (ag.get("final") or "")[:200],
                "lean_accepts": bool(rep.get("ready_to_claim")),
                "not_accepted_because": why,
                "delta_bytes": exp.get("delta_bytes"),
                "delta_sha256": exp.get("delta_sha256"),
                "axioms": chk.get("axioms"),
                "native_kernel_accepts": native_accepts(REPO / rep["shelf"], delta) if delta.exists() else None,
                "kernel_contract_accepts_locally": chain["accepted_by_kernel_contract"] if chain else None,
                "kernel_contract_tgas": round(chain["reveal"]["kernel_tgas"], 1)
                if chain and chain.get("reveal")
                else None,
                "signed_responses": f"{ag.get('signed_responses')}/{ag.get('responses')}",
                "attestation_verified_offline": json.loads(ver.read_text())["ok"] if ver.exists() else None,
            }
        )
    out = {
        "attempts": rows,
        "spend_usd_total": round(sum(r.get("cost_usd", 0) for r in spend), 4),
        "billed_usd_total": billed_usd(spend),
        "spend_requests": len(spend),
        "spend_note": "every request of this work; spend_usd_total prices all its tokens at the list price of GET /v1/models (what the cap counted) "
        "and counts a guess for each request the gateway cut; billed_usd_total is NEAR AI's own figure from POST /v1/billing/costs "
        "for the answered requests (cached input is charged less; a cut request has no id to ask about)",
    }
    (d / "attempts.json").write_text(json.dumps(out, indent=1) + "\n")
    yn = lambda v: "-" if v is None else ("yes" if v else "no")
    usd = lambda v: "-" if v is None else f"USD {v:.4f}"
    table = [
        "| Attempt | Model | Tokens in / out | Cost at list price | Billed | Wall time | Requests | Repair rounds | Lean | Native kernel | Kernel contract (local node) | Signed responses | Attestation (offline) |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        tgas = f" ({r['kernel_contract_tgas']:.0f} TGas)" if r["kernel_contract_tgas"] else ""
        table.append(
            f"| `{r['attempt']}` | `{r['model']}` | {r['prompt_tokens']:,} / {r['completion_tokens']:,} | {usd(r['cost_usd'])} | {usd(r['billed_usd'])} | {r['wall_seconds']:.0f} s "
            f"| {r['requests']}{' + ' + str(r['requests_without_response']) + ' cut' if r['requests_without_response'] else ''} | {r['repair_rounds']} | {yn(r['lean_accepts'])} | {yn(r['native_kernel_accepts'])} | {yn(r['kernel_contract_accepts_locally'])}{tgas} "
            f"| {r['signed_responses']} | {yn(r['attestation_verified_offline'])} |"
        )
    said = json.loads((d / "notes.json").read_text()) if (d / "notes.json").exists() else {}
    notes = []
    for r in rows:
        verdict = (
            f"accepted, a {r['delta_bytes']:,}-byte proof file, axioms: {', '.join(r['axioms']) or 'none'}"
            if r["lean_accepts"]
            else f"not accepted: {r['not_accepted_because']}"
        )
        notes.append(f"- `{r['attempt']}`: {verdict}. {said.get(r['attempt'], '')}".rstrip())
    accepted = " ".join(f"evidence/nearai/{r['attempt']}" for r in rows if r["lean_accepts"])
    bare = [r["attempt"] for r in rows if not (d / r["attempt"] / "nearai").is_dir()]
    kept = (
        f"\nThis tree does not hold the requests, responses, signatures, attestation reports and transcripts of the {len(bare)} attempts "
        "with no accepted proof (about 16 MB). For those attempts it keeps only `report.json` and the last `Solution.lean`. "
        "Their rows above come from the reports, and nobody can verify them again from this tree.\n"
        if bare
        else ""
    )
    print(
        SUMMARY.format(
            table="\n".join(table),
            notes="\n".join(notes),
            kept=kept,
            accepted=accepted,
            n=len(spend),
            listed=usd(out["spend_usd_total"]),
            billed=usd(out["billed_usd_total"]),
        )
    )


SUMMARY = """# A prover that is not ours: open-weight models on NEAR AI Cloud take the same bounties

Claude models wrote every proof in the wallet demo. Here the prover is an open-weight model. NEAR AI Cloud
(https://docs.near.ai/) serves it inside an Intel TDX VM on NEAR AI's own GPU fleet. The model gets the same prompt
and the same workspace as the Claude agents (`agent/solve.py`). The workspace has the four Policy files, a stub
`Solution.lean`, Lean and `./measure.sh`. It does not have the wallet author's own proofs.

The model works through a small loop of tool calls (`agent/nearai.py`). Three checkers then check its text: Lean, a
native build of this repository's kernel, and the kernel contract on a local NEAR node. They check the proof of
any other agent the same way.

The chain checks the proof, whoever writes it. The attestation says which model wrote the text and where it ran.
It says nothing about whether the proof is correct.

## Results

{table}

All {n} requests of this work cost {listed} at list price (billed for the answered ones: {billed}).

{notes}
{kept}
The columns:

- *Attempt*: the directory under evidence/nearai. Its name starts with the claim, without `Wallet.Claim.`. `-2`
  marks a second attempt at the same claim with the same model.
- *Lean*: the independent check of `agent/solve.py`. The file compiles. `Solution.proof` has the claim as its
  type, and no other type. The file has no `sorry` and only allowed axioms. The export matches the sealed
  environment and fits the size limit.
- *Native kernel*: nanoda, built from the contract's source (`tools/native`), type-checks the sealed environment
  plus the proof.
- *Kernel contract*: a run on a fresh local node (`agent/nearai_local.cjs`, near-sandbox). A courier commits, runs
  the free `dry_run`, and reveals with its bond. The board pays after the verdict of the kernel contract.
- *Requests*: answered completions. "+ n cut" counts the requests that the gateway closed at 10 minutes with no
  response.
- *Repair rounds*: the number of times that the model rewrote `Solution.lean` after its first version.
- *Cost at list price*: all prompt and completion tokens at the prices of `GET /v1/models`. The spend cap counted
  this.
- *Billed*: the amount that NEAR AI charged for the answered requests (`POST /v1/billing/costs`, `billed.json`). It
  is lower, because NEAR AI charges cached input tokens at the cache-read price.

A request that the gateway cut has no id to ask about, so nobody here knows whether NEAR AI charged it. The
list-price column counts a guess for it: its input plus a full reply. The billed column counts nothing for it.

## What the attestation check verifies

`python3 -S tools/verify_nearai.py evidence/nearai/<attempt>` works offline on the stored bytes. It uses the Python
standard library only. Its ECDSA P-256 and ed25519 verifiers test themselves on RFC vectors. It checks six things:

1. The agent fetched the attestation report before the first completion, with a nonce that the agent made
   (`nearai/records.json`). The report holds three Intel TDX quotes: the gateway's, the model VM's, and the one of
   the model VM's compose manager.
2. The signatures of each quote hold up to the Intel SGX Root CA key that the script pins. The path of signatures
   is: certificate chain, quoting enclave report, attestation key, quote. The TD is not in debug mode.
3. The `report_data` of each quote is `signing key || nonce`. For the compose manager it is
   `sha256(action log) || nonce`. The MRCONFIGID of each quote is the sha256 of the `app_compose` text in the
   report, and its event log replays to RTMR3.
4. The quote of the compose manager has the measurements of the model quote. Its action log names the deployment
   that started last, with its git commit and sha256.
5. Every response of the attempt carries an ed25519 signature by the model VM's key. The signature covers the
   model id and the sha256 of the stored request and response bytes, and of no other bytes.
6. `Solution.lean` is, byte for byte, the last `write_solution` call in those signed responses.

`--tamper` makes thirteen changed copies of the evidence and requires each to fail.

The result: the proof text came out of the VM that serves NEAR AI's models, under that model id, in answer to the
stored prompts.

## What it does not show

- It shows nothing about correctness. A signed wrong proof is still wrong. Lean, nanoda and the kernel contract
  decide correctness, and they do not look at the attestation.
- The script does not check what needs a network service. That is Intel's TCB status and revocation lists for the
  platform (dcap-qvl, or https://cloud.near.ai/verify), and the NVIDIA GPU evidence (NVIDIA NRAS). The script
  checks only that the GPU evidence is present and carries the nonce.
- The script does not check these at all:
  - certificate validity dates
  - the identity of the quoting enclave
  - what the measured container images do
  - that the deployment file named in the action log loads the weights that its name says (the file is not in the
    report)
  - that the report and the completions came from the same VM (NEAR AI's docs: instances of one model share a
    signing key)
- We compared the Intel root key in the script with the certificate inside the quotes and with the public Intel
  SGX Root CA. We did not download it from Intel during this work.
- The nonce and the timestamps in `records.json` are the agent's own. To the agent they show that the report is
  fresh. To anyone else they show consistency only.
- NEAR AI's docs ask a client to verify the report before it sends a completion. Here the agent fetched the report
  before, and the check ran afterwards. That is enough for a record. It is not enough for a client that must
  refuse an unattested endpoint.

## Commands

    ./verify.sh --nearai        # offline: kernel, recorded contract verdict, Lean (with elan), attestation, tamper test

    NEAR_SANDBOX_BIN_PATH=$PWD/.sandbox/2.14.0/near-sandbox \\
      node agent/nearai_local.cjs run-output/nearai-local.json {accepted}      # the kernel contract again, ~1 min

    export NEARAI_API_KEY=...  NEARAI_LEDGER=$PWD/evidence/nearai/spend.jsonl  NEARAI_CAP_USD=4.5
    python3 -I agent/solve.py Wallet.Claim.Refute.SlidingDayCap run-output/my-attempt --backend nearai \\
      --model deepseek-ai/DeepSeek-V4.1-Flash-1017 --max-turns 30 --budget-usd 0.6 --timeout 900
    python3 -S tools/verify_nearai.py run-output/my-attempt

    python3 -I agent/nearai_record.py [--billed]      # this text; --billed asks NEAR AI what it charged (needs the key)

## Files in evidence/nearai

- `<attempt>/Solution.lean`, `delta.ndjson`: the model's proof and its export against the sealed environment.
- `<attempt>/report.json`: model, tokens, cost, wall time, repair rounds, and the independent Lean check.
- `<attempt>/transcript.jsonl`: every assistant message and tool result.
- `<attempt>/nearai/NNNN.{{request,response,signature}}.json`: exact request and response bytes, NEAR AI's signature.
- `<attempt>/nearai/attestation.json`, `records.json`, `verification.json`: the report fetched before the run, the
  nonce and hashes, the result of the offline check.
- `attempts.json`: the table as data. `local-node.json`: the local-node run (decisions, transactions, kernel gas,
  certificates). `spend.jsonl`: every request with its token usage and list-price cost. `billed.json`: what NEAR AI
  billed. `notes.json`: one remark per attempt.

`attestation.json` contains NEAR AI's measured container configuration, which mentions an `Authorization` header
with a placeholder. The record stores no key of ours: it keeps requests as bodies only."""


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--billed"]
    main(pathlib.Path(args[0] if args else REPO / "evidence/nearai").resolve(), "--billed" in sys.argv)
