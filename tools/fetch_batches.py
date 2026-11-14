#!/usr/bin/env python3
"""Write deploy/testnet-batches.json.gz: the full `tx` RPC result of the two batch transactions of a deployment
(old_batch and new_batch in deploy/testnet.json), the receipts, logs and outcomes that check_live.py --tx and
cases/intents-refund/check_log_model.py compare against the chain.

usage: python3 tools/fetch_batches.py [--record deploy/testnet.json] [--rpc https://test.rpc.fastnear.com]
                                      [--out deploy/testnet-batches.json.gz]
Read-only: it fetches transactions and writes one file.
"""

import argparse, gzip, json, pathlib, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
ap = argparse.ArgumentParser()
ap.add_argument("--record", type=pathlib.Path, default=ROOT / "deploy/testnet.json")
ap.add_argument("--rpc", default="https://test.rpc.fastnear.com")
ap.add_argument("--archival", default="https://archival-rpc.testnet.fastnear.com")
ap.add_argument("--out", type=pathlib.Path, default=ROOT / "deploy/testnet-batches.json.gz")
ap.add_argument("--steps", nargs="*", default=["old_batch", "new_batch"])
args = ap.parse_args()

record = json.loads(args.record.read_text())
story = record.get("story", {})


def tx(hash_, signer, rpc):
    req = urllib.request.Request(
        rpc,
        data=json.dumps(
            {
                "jsonrpc": "2.0",
                "id": "1",
                "method": "tx",
                "params": {"tx_hash": hash_, "sender_account_id": signer, "wait_until": "NONE"},
            }
        ).encode(),
        headers={"content-type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


out = {}
for step in args.steps:
    s = story.get(step)
    if not s or "hash" not in s:
        raise SystemExit(f"{step} is not a transaction in {args.record}")
    answer = tx(s["hash"], s.get("signer", record["accounts"]["root"]), args.rpc)
    if "error" in answer:
        answer = tx(s["hash"], s.get("signer", record["accounts"]["root"]), args.archival)
    if "error" in answer:
        raise SystemExit(f"{step}: {answer['error']}")
    out[step] = answer["result"]
    print(f"{step}: {s['hash']} — {len(answer['result'].get('receipts_outcome', []))} receipts")

args.out.write_bytes(gzip.compress((json.dumps(out) + "\n").encode()))
print(f"wrote {args.out.relative_to(ROOT)} ({args.out.stat().st_size} bytes)")
