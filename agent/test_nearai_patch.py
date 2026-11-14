#!/usr/bin/env python3
"""The loop of agent/nearai_patch.py against a local stand-in for NEAR AI Cloud: no key, no network, nothing recorded.

usage: python3 agent/test_nearai_patch.py        (needs Lean 4.35.0 and tools/native, like the driver)

The stand-in answers with a fixed script: a patch that breaks the rule, the repair, a proof by omega, a proof with no
axiom. The driver must answer REFUTED, BOUND, REJECTED (omega brings axioms with it) and ACCEPTED, in round 3.
"""

import json, os, pathlib, re, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

REPO = pathlib.Path(__file__).resolve().parents[1]
FILE = "import RefundCase\n\nnamespace Solution\n\ntheorem proof : {claim} := by\n  intro a _\n  show Refund.Rule a (min (min a.requested a.deposited) a.balance)\n%s\n\nend Solution\n"
OMEGA = "  unfold Refund.Rule\n  omega"
PROOF = """  refine ⟨Nat.le_trans (Refund.min_le_first _ _) (Refund.min_le_first _ _), Nat.le_trans (Refund.min_le_first _ _) (Refund.min_le_second _ _), Refund.min_le_second _ _, ?_⟩
  cases Nat.le_total (min a.requested a.deposited) a.balance with
  | inl h1 =>
    rw [Nat.min_eq_left h1]
    cases Nat.le_total a.requested a.deposited with
    | inl h2 => exact Or.inl (Nat.min_eq_left h2)
    | inr h2 => exact Or.inr (Or.inl (Refund.min_right h2))
  | inr h1 => exact Or.inr (Or.inr (Refund.min_right h1))"""
SCRIPT = [
    ("propose_patch", {"expression": "balance_left.min(requested_refund).min(5u128)"}),
    ("propose_patch", {"expression": "requested_refund.min(*deposited).min(balance_left)"}),
    ("write_solution", {"content": FILE % OMEGA}),
    ("write_solution", {"content": FILE % PROOF}),
]


class StandIn(BaseHTTPRequestHandler):
    step = 0

    def log_message(self, *a):
        pass

    def answer(self, obj):
        raw = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # the price list, the attestation report, a signature: only the first has content
        self.answer(
            {"data": [{"id": "stand-in", "owned_by": "test", "pricing": {"prompt": "0", "completion": "0"}}]}
            if "/models" in self.path
            else {"stand_in": True}
        )

    def do_POST(self):  # a chat completion: the next tool call of the script, about the claim the driver named last
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        claim = (
            re.findall(
                r"Prove `(Refund\.C_[0-9a-f]{64}\.Correct)`",
                " ".join(str(m.get("content")) for m in body["messages"][1:]),
            )
            or ["?"]
        )[-1]
        name, args = SCRIPT[min(StandIn.step, len(SCRIPT) - 1)]
        StandIn.step += 1
        call = {
            "id": f"call-{StandIn.step}",
            "type": "function",
            "function": {
                "name": name,
                "arguments": json.dumps({k: v.replace("{claim}", claim) for k, v in args.items()}),
            },
        }
        self.answer(
            {
                "id": f"stand-in-{StandIn.step}",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "", "tool_calls": [call]},
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            }
        )


def main():
    server = HTTPServer(("127.0.0.1", 0), StandIn)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="emet-patch-test-") as t:
        env = dict(
            os.environ,
            NEARAI_BASE_URL=f"http://127.0.0.1:{server.server_port}/v1",
            NEARAI_API_KEY="stand-in",
            NEARAI_LEDGER=t + "/spend.jsonl",
            NEARAI_CAP_USD="1",
        )
        r = subprocess.run(
            [sys.executable, "-I", str(REPO / "agent/nearai_patch.py"), "solve", t + "/attempt", "--model", "stand-in"],
            env=env,
            capture_output=True,
            text=True,
        )
        report = pathlib.Path(t, "attempt/report.json")
        assert report.exists(), r.stdout[-2000:] + r.stderr[-2000:]
        rep = json.loads(report.read_text())
    rounds = rep["rounds"]
    assert [(x["patch"], x.get("proof")) for x in rounds] == [
        ("refuted", None),
        ("bound", "rejected"),
        ("bound", "accepted"),
    ], rounds
    assert (
        rounds[0]["refutation_checked"]
        and "depends on axioms" in rounds[1]["error"]
        and rep["accepted"]
        and rep["axioms"] == []
    ), rep
    print(
        "ok   a refuted patch, a proof rejected for its axioms, a proof with no axiom accepted in round 3 (local stand-in: nothing was sent to NEAR AI Cloud)"
    )


if __name__ == "__main__":
    main()
