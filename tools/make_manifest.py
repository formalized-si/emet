#!/usr/bin/env python3
"""Write proofs/MANIFEST.json: every delta the scenario reveals, its sha256, origin and expected verdict.

The agents' proofs live in evidence/agent/<Claim>-<model>/ (Solution.lean, delta.ndjson,
report.json, transcript.jsonl); the cheats in cheats/deltas/. Run after adding either.
"""

import hashlib, json, pathlib

R = pathlib.Path(__file__).resolve().parents[1]
sha = lambda p: hashlib.sha256((R / p).read_bytes()).hexdigest()
cfg = json.loads((R / "demo/bounties.json").read_text())
shelf = json.loads((R / cfg["shelf"] / "manifest.json").read_text())
entries = []
for c in cfg["couriers"] + ([dict(cfg["fix"]["courier"], fix=True)] if cfg.get("fix") else []):
    for name, d in c["solutions"].items():
        rep = json.loads((R / d / "report.json").read_text())
        a = rep["agent"]
        tool_calls = 0
        for line in (R / d / "transcript.jsonl").read_text().splitlines():
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "assistant":
                tool_calls += sum(1 for part in msg["message"].get("content", []) if part.get("type") == "tool_use")
        entries.append(
            {
                "claim": name,
                "delta": f"{d}/delta.ndjson",
                "sha256": sha(f"{d}/delta.ndjson"),
                "bytes": (R / d / "delta.ndjson").stat().st_size,
                "origin": "LLM prover agent (agent/solve.py)",
                "model": a.get("model"),
                "agent_seconds": a.get("seconds"),
                "agent_cost_usd": round(a.get("cost_usd") or 0, 4),
                "agent_turns_reported": a.get("turns"),
                "agent_tool_calls": tool_calls,
                "permission_denials": a.get("permission_denials"),
                "solution": f"{d}/Solution.lean",
                "courier": c["account"],
                "expected": "accepted",
            }
        )
# Proofs written live during the recorded run (LIVE_AGENT=1), saved next to it.
for d in sorted((R / "evidence/demo").glob("live-solve-*")):
    rel = str(d.relative_to(R))
    rep = json.loads((d / "report.json").read_text())
    a = rep["agent"]
    entries.append(
        {
            "claim": rep["claim"],
            "delta": f"{rel}/delta.ndjson",
            "sha256": sha(f"{rel}/delta.ndjson"),
            "bytes": (d / "delta.ndjson").stat().st_size,
            "origin": "written live during the recorded run (LIVE_AGENT=1)",
            "model": a.get("model"),
            "agent_seconds": a.get("seconds"),
            "agent_cost_usd": round(a.get("cost_usd") or 0, 4),
            "permission_denials": a.get("permission_denials"),
            "solution": f"{rel}/Solution.lean",
            "expected": "accepted",
        }
    )
lean_level = {"viaSorry", "viaAxiom", "weaker", "noRequests"}
head = next(b for b in cfg["bounties"] if b.get("headline"))
for ch in cfg["cheats"]:
    entries.append(
        {
            "claim": head["claim"],
            "delta": ch["delta"],
            "sha256": sha(ch["delta"]),
            "bytes": (R / ch["delta"]).stat().st_size,
            "origin": "cheats/Cheats.lean" if ch["name"] in lean_level else "tools/forge_cheats.py",
            "story": ch["story"],
            "expected": "refused: " + ch["expect"],
        }
    )
out = {"shelf": cfg["shelf"], "shelf_sha256": shelf["base_sha256"], "deltas": entries}
(R / "proofs/MANIFEST.json").write_text(json.dumps(out, indent=2) + "\n")
print(f"{len(entries)} entries")
