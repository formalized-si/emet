"""Prover backend on NEAR AI Cloud: an open-weight model in an attested TEE writes the proof.

Used by agent/solve.py (`--backend nearai --model <model id>`). Unlike the Claude Code backend this
is a small tool-calling loop of our own over the OpenAI-compatible `/v1/chat/completions`, without
streaming, so that every request and response body is kept byte for byte: NEAR AI signs
`<model>:<sha256(request body)>:<sha256(response body)>` with a key published in its TEE
attestation report, and `tools/verify_nearai.py` re-checks those signatures offline.

The model gets four tools, all confined to the workspace: read_file, write_solution, run_lean,
measure. Nothing it writes is trusted: solve.py re-checks the result with Lean and the chain checks
it again with its own kernel.

Order, as NEAR AI's verification docs require: first the attestation report for the model, requested with
a nonce made here (`provider=near`, no API key needed), then the completions, then their signatures. A
report fetched after a completion is not evidence for it.

Writes into <out>/nearai/: attestation.json (the gateway's and the model's report, exact bytes),
NNNN.request.json and NNNN.response.json (exact bytes), NNNN.signature.json, records.json (model, nonce,
hashes, times), and transcript.jsonl in <out>.
The API key comes from NEARAI_API_KEY or ~/.config/proof-courier/near-ai-cloud.key; it is never written.

Spend: every response's token usage is priced with GET /v1/models and, when NEARAI_LEDGER names a file,
appended to it as one JSON line; with NEARAI_CAP_USD set, no request is sent once the ledger's total
reaches the cap (so several runs share one budget).
"""

import hashlib, json, os, pathlib, secrets, subprocess, time, urllib.error, urllib.parse, urllib.request
from http.client import HTTPException

BASE = os.environ.get("NEARAI_BASE_URL", "https://cloud-api.near.ai/v1").rstrip("/")
SIGNING_ALGO = "ed25519"
MAX_TOOL_OUTPUT = 12_000
# One completion without streaming must end within 10 minutes: the gateway closes a longer one with no response
# (seen on 2026-11-11, always at 600 s). How many tokens fit depends on the hour: DeepSeek V4.1 Flash wrote 24 to
# 43 tokens/s at first and 15 to 23 later. So each request may write what the last measured rate produces in 7 minutes,
# between MIN_TOKENS and MAX_TOKENS; a cut request halves the rate.
MIN_TOKENS, MAX_TOKENS, REQUEST_SECONDS = 3_000, 16_000, 420

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file in the workspace (Policy/Core.lean, Policy/Spec.lean, Policy/Bounties.lean, SHELF.md, Solution.lean).",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_solution",
            "description": "Replace the whole content of Solution.lean.",
            "parameters": {"type": "object", "properties": {"content": {"type": "string"}}, "required": ["content"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_lean",
            "description": "Run `lake env lean Solution.lean` and return its output (empty output means it compiled with no errors or warnings).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "measure",
            "description": "Run ./measure.sh: export the proof as the chain will see it and report its size and heaviest declarations.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def api_key() -> str:
    k = os.environ.get("NEARAI_API_KEY", "").strip()
    if not k:
        f = pathlib.Path.home() / ".config/proof-courier/near-ai-cloud.key"
        k = f.read_text().strip() if f.exists() else ""
    if not k:
        raise SystemExit(
            "NEAR AI Cloud key: set NEARAI_API_KEY or write it to ~/.config/proof-courier/near-ai-cloud.key"
        )
    return k


def http(method, path, body: bytes | None = None, key: str | None = None, timeout=900, tries=4):
    """-> (status, body). Status 0 means the network failed `tries` times (for a POST the response, if any, is lost)."""
    req = urllib.request.Request(BASE + path, data=body, method=method)
    req.add_header("Accept", "application/json")
    req.add_header("Accept-Encoding", "identity")  # the signature covers the uncompressed bytes
    req.add_header("x-no-aliasing", "true")  # the model id we send is part of the signed text
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    err = ""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            raw = e.read()
            if e.code not in (429, 500, 502, 503, 504) or attempt == tries - 1:
                return e.code, raw
            err = f"HTTP {e.code}"
        except (urllib.error.URLError, OSError, HTTPException) as e:
            err = f"{type(e).__name__}: {e}"
            if method == "POST":  # it may have been served and billed: do not send it twice
                break
        time.sleep(5 * (attempt + 1))
    return 0, json.dumps({"error": {"message": "network: " + err}}).encode()


def pricing(model: str):
    st, raw = http("GET", "/models")
    if st != 200:
        return None
    for m in json.loads(raw).get("data", []):
        if m.get("id") == model:
            p = m.get("pricing") or {}
            return float(p.get("prompt") or 0), float(p.get("completion") or 0), m.get("owned_by")
    return None


def ledger_total(path) -> float:
    if not path or not pathlib.Path(path).exists():
        return 0.0
    return sum(json.loads(l).get("cost_usd", 0.0) for l in pathlib.Path(path).read_text().splitlines() if l.strip())


def ledger_add(path, row: dict):
    if path:
        pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(row) + "\n")


def inside(ws: pathlib.Path, rel: str) -> pathlib.Path | None:
    p = (ws / rel).resolve()
    return p if p.is_file() and ws.resolve() in p.parents and ".courier" not in p.parts else None


def run_tool(ws: pathlib.Path, name: str, args: dict, env) -> str:
    if name == "read_file":
        p = inside(ws, str(args.get("path", "")))
        return p.read_text()[: MAX_TOOL_OUTPUT * 4] if p else "error: no such file in the workspace"
    if name == "write_solution":
        content = str(args.get("content", ""))
        (ws / "Solution.lean").write_text(content, encoding="utf-8")
        return f"wrote Solution.lean ({len(content)} characters)"
    if name in ("run_lean", "measure"):
        cmd = ["lake", "env", "lean", "Solution.lean"] if name == "run_lean" else ["./measure.sh"]
        try:
            r = subprocess.run(cmd, cwd=ws, env=env, capture_output=True, text=True, timeout=900)
            out = (r.stdout + r.stderr).strip()
            for local, shown in ((str(ws.resolve()), "."), (str(ws), "."), (str(pathlib.Path.home()), "~")):
                out = out.replace(local, shown)  # local paths stay out of the prompts and the stored transcript
            return (
                out[-MAX_TOOL_OUTPUT:] if out else "(no output: compiled with no errors or warnings)"
            ) + f"\n[exit {r.returncode}]"
        except subprocess.TimeoutExpired:
            return "error: timed out after 900 s (the proof is too slow to elaborate; simplify it)"
    return f"error: unknown tool {name}"


# What the loop says besides the prompt: the note under it, the answer to a reply cut at the token limit, the answer
# to a reply with no tool call.
TEXTS = (
    "\n\nYou have tools: read_file, write_solution (replaces Solution.lean), run_lean and measure. "
    "Use them; when Solution.lean compiles and measure says OK, reply with one line: DONE.",
    "Your last reply was cut off at the output limit before any tool call. Work in smaller steps: "
    "write a first version of Solution.lean now, run_lean, and repair it from the errors.",
    "Continue with the tools until Solution.lean compiles and measure says OK, then reply DONE.",
)


def run(
    ws: pathlib.Path,
    out: pathlib.Path,
    prompt: str,
    model: str,
    env,
    max_turns=60,
    budget_usd=3.0,
    timeout=5400,
    tools=TOOLS,
    tool=run_tool,
    texts=TEXTS,
    stop=lambda: None,
):
    """The defaults are the wallet prover's. agent/nearai_patch.py passes its own tools, tool function and texts, and a
    `stop` that returns the final line once its own rule ends the run (it is asked after every tool call)."""
    key = api_key()
    rec = out / "nearai"
    rec.mkdir(parents=True, exist_ok=True)
    ledger, cap = os.environ.get("NEARAI_LEDGER"), float(os.environ.get("NEARAI_CAP_USD") or "inf")
    price = pricing(model)
    pin, pout, owner = price if price else (0.0, 0.0, None)
    if not price and cap != float("inf"):
        raise SystemExit(f"no price for {model} in GET /models: cannot keep to NEARAI_CAP_USD")
    # Preflight evidence: the model's attestation report, bound to a nonce made here, before any completion.
    nonce = secrets.token_hex(32)
    q = urllib.parse.urlencode({"model": model, "provider": "near", "signing_algo": SIGNING_ALGO, "nonce": nonce})
    att_http, raw = http("GET", f"/attestation/report?{q}")  # a public endpoint: the key is not sent
    (rec / "attestation.json").write_bytes(raw)
    meta = {
        "model": model,
        "signing_algo": SIGNING_ALGO,
        "base_url": BASE,
        "nonce": nonce,
        "attestation_http": att_http,
        "attestation_fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "records": [],
    }
    records = meta["records"]
    save = lambda: (rec / "records.json").write_text(json.dumps(meta, indent=1) + "\n")
    save()
    note, cut, nudge = texts
    messages = [{"role": "user", "content": prompt + note}]
    t0, cost, turns, final, calls, tokens = time.time(), 0.0, 0, None, 0, {"prompt": 0, "completion": 0}
    writes = lean_runs = lean_failures = lost = 0
    rate = 15.0  # completion tokens per second: the slowest seen, until a reply of 1,000 tokens or more is measured
    transcript = open(out / "transcript.jsonl", "w")
    halt = None
    while not halt and turns < max_turns and cost < budget_usd and time.time() - t0 < timeout:
        if ledger_total(ledger) >= cap:
            final = f"stopped: the spend cap of USD {cap} is reached"
            break
        turns += 1
        max_tokens = int(max(MIN_TOKENS, min(MAX_TOKENS, rate * REQUEST_SECONDS)))
        body = json.dumps(
            {"model": model, "messages": messages, "tools": tools, "tool_choice": "auto", "max_tokens": max_tokens}
        ).encode()
        n = f"{turns:04d}"
        (rec / f"{n}.request.json").write_bytes(body)
        sent = time.time()
        st, raw = http("POST", "/chat/completions", body, key)
        (rec / f"{n}.response.json").write_bytes(raw)
        if st != 200:
            final = f"HTTP {st}: {raw[:300].decode(errors='replace')}"
            if (
                st == 0
            ):  # no response, but it may have been served: count a generous guess of its cost, and try again twice
                lost += 1
                rate /= 2
                c = round(len(body) / 3 * pin + max_tokens * pout, 6)
                cost += c
                ledger_add(
                    ledger,
                    {
                        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "out": out.name,
                        "model": model,
                        "n": n,
                        "lost_response": True,
                        "cost_usd": c,
                    },
                )
                if lost <= 2:
                    continue
            break
        resp = json.loads(raw)
        u = resp.get("usage") or {}
        c = u.get("prompt_tokens", 0) * pin + u.get("completion_tokens", 0) * pout
        cost += c
        if u.get("completion_tokens", 0) >= 1000:
            rate = u["completion_tokens"] / max(1.0, time.time() - sent)
        tokens["prompt"] += u.get("prompt_tokens", 0)
        tokens["completion"] += u.get("completion_tokens", 0)
        records.append(
            {
                "n": n,
                "chat_id": resp.get("id"),
                "received_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "request_sha256": hashlib.sha256(body).hexdigest(),
                "response_sha256": hashlib.sha256(raw).hexdigest(),
                "prompt_tokens": u.get("prompt_tokens", 0),
                "completion_tokens": u.get("completion_tokens", 0),
                "cost_usd": round(c, 6),
            }
        )
        save()
        ledger_add(
            ledger,
            {
                "at": records[-1]["received_at"],
                "out": out.name,
                "model": model,
                "n": n,
                "chat_id": resp.get("id"),
                "prompt_tokens": u.get("prompt_tokens", 0),
                "completion_tokens": u.get("completion_tokens", 0),
                "cost_usd": round(c, 6),
            },
        )
        msg = resp["choices"][0]["message"]
        tcs = msg.get("tool_calls") or []
        transcript.write(
            json.dumps(
                {
                    "type": "assistant",
                    "turn": turns,
                    "chat_id": resp.get("id"),
                    "message": {
                        "content": ([{"type": "text", "text": msg.get("content") or ""}] if msg.get("content") else [])
                        + [
                            {
                                "type": "tool_use",
                                "name": tc["function"]["name"],
                                "input": tc["function"].get("arguments"),
                            }
                            for tc in tcs
                        ]
                    },
                }
            )
            + "\n"
        )
        transcript.flush()
        # Send back only what the API accepts as input (no reasoning fields).
        messages.append(
            {"role": "assistant", "content": msg.get("content") or "", **({"tool_calls": tcs} if tcs else {})}
        )
        if not tcs:
            final = (msg.get("content") or "").strip()[-500:]
            if resp["choices"][0].get("finish_reason") == "length":  # cut at max_tokens, usually while still thinking
                messages.append({"role": "user", "content": cut})
                continue
            if "DONE" in final or "GAVE UP" in final:
                break
            messages.append({"role": "user", "content": nudge})
            continue
        for tc in tcs:
            calls += 1
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"].get("arguments") or "{}")
                result = tool(ws, name, args if isinstance(args, dict) else {}, env)
            except json.JSONDecodeError as e:
                result = f"error: the tool arguments are not valid JSON ({e}); nothing was done"
            writes += name == "write_solution" and result.startswith("wrote")
            lean_runs += name == "run_lean"
            lean_failures += name == "run_lean" and ("error:" in result or not result.endswith("[exit 0]"))
            transcript.write(
                json.dumps({"type": "tool_result", "turn": turns, "name": name, "output": result[-4000:]}) + "\n"
            )
            messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
            halt = stop()
            if halt:
                final = halt
                break
    transcript.close()
    seconds = round(time.time() - t0, 1)
    # A signature for every response; the key that made it must be the one in the report fetched above.
    signed = 0
    q = urllib.parse.urlencode({"model": model, "signing_algo": SIGNING_ALGO})
    for r in records:
        if not r["chat_id"]:
            continue
        for attempt in range(6):
            st, raw = http("GET", f"/signature/{urllib.parse.quote(r['chat_id'])}?{q}", key=key)
            if st != 404:
                break
            time.sleep(2 + attempt)
        (rec / f"{r['n']}.signature.json").write_bytes(raw)
        try:
            signed += st == 200 and "signature" in json.loads(raw)
        except json.JSONDecodeError:
            pass
    return {
        "backend": "near-ai-cloud",
        "model": model,
        "model_owner": owner,
        "seconds": seconds,
        "turns": turns,
        "tool_calls": calls,
        "solution_writes": writes,
        "repair_rounds": max(0, writes - 1),
        "lean_runs": lean_runs,
        "lean_failures": lean_failures,
        "lost_responses": lost,
        "prompt_tokens": tokens["prompt"],
        "completion_tokens": tokens["completion"],
        "usd_per_token": {"prompt": pin, "completion": pout},
        "final": final,
        "cost_usd": round(cost, 4),
        "signed_responses": signed,
        "responses": len(records),
        "attestation_http": att_http,
        "permission_denials": 0,
    }
