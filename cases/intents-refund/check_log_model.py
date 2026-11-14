#!/usr/bin/env python3
"""Compare the Lean model of the two events (LogBudget.lean) with the logs of the recorded transactions.

For every recorded deposit it takes the `mt_mint` event the contract wrote, and the `mt_burn` event of the
refund: the event itself when it was written, or the length the node reports when the callback failed
("The length of a log message N exceeds the limit 16384"; N is the total of the logs of that call, and the
refund event is its only log). It checks, in bytes:

  mint event   = its text outside the two lists + mintBytes - 2
  refund event = mint event + (6 - length of the deposit memo) + burnBytes - mintBytes

The first constant is what upstream's check_refund adds to the mint event before it compares with the limit.
The 2 is the comma that the model counts after the last entry of each list and JSON does not write.
Refund amounts are computed here from the candidate's expression, the request and the balance, not read
from the refund event. It also checks that the deposit event lists every token the transaction sent, that
each event is the only log of its call, and that the record holds both a refused and a written refund event.
The recorded runs do not exercise a refund of zero, a balance that limits a refund, a batch of different
tokens, or amounts of other lengths than 1, 3 and 36 digits. Standard library only; reads evidence/refund/,
runs nothing.

When deploy/testnet-batches.json.gz is there, it does the same for the two batch transactions of the testnet
deployment (deploy/testnet.json: old_batch, new_batch), as the node returned them with their logs.
`python3 tools/check_live.py --tx` compares that file with what the node returns now.
"""

import base64
import gzip
import hashlib
import json
import re
import sys

from prepare import HERE, eval_expr

ROOT = HERE.parents[1]
REFUND_MEMO = "refund"  # upstream: crates/near/utils/src/event.rs
LIMIT = 16384  # upstream: TOTAL_LOG_LENGTH_LIMIT; the node: max_total_log_length


def digits(n):  # LogBudget.lean: digits
    return 1 + sum(1 for k in range(1, 39) if 10**k <= n)


def entry_bytes(id_len, amount):  # LogBudget.lean: entryBytes
    return (id_len + 3) + (digits(amount) + 3)


def mint_bytes(items):  # items: (id length, requested, deposited, balance). LogBudget.lean: mintBytes
    return sum(entry_bytes(i, d) for i, _, d, _ in items)


def burn_bytes(ast, items):  # LogBudget.lean: burnBytes
    refunds = [(i, eval_expr(ast, dict(requested_refund=r, deposited=d, balance_left=b))) for i, r, d, b in items]
    return sum(entry_bytes(i, x) for i, x in refunds if x != 0)


def event(log):
    body = json.loads(log.removeprefix("EVENT_JSON:"))
    compact = lambda v: "EVENT_JSON:" + json.dumps(v, separators=(",", ":"), ensure_ascii=False)
    assert compact(body) == log, "the event is not compact JSON"
    (data,) = body["data"]
    frame = len(compact({**body, "data": [{**data, "token_ids": [], "amounts": []}]}).encode())
    return body["event"], data, frame


def main():
    record = json.loads((ROOT / "evidence/refund/replay.json").read_text())
    raw = gzip.decompress((ROOT / "evidence/refund/replay-full.json.gz").read_bytes())
    assert hashlib.sha256(raw).hexdigest() == record["full_trace"]["uncompressed_sha256"], (
        "the full trace is not the recorded one"
    )
    full = json.loads(raw)
    catalog = {c["label"]: c for c in json.loads((HERE / "candidates.json").read_text())["candidates"]}
    ok, seen = True, set()
    runs = [("local node", run) for run in full["runs"] + full["backed_runs"]]
    live, traces = ROOT / "deploy/testnet.json", ROOT / "deploy/testnet-batches.json.gz"
    if live.exists() and traces.exists():
        deployed, sent_there = json.loads(live.read_text()), json.loads(gzip.decompress(traces.read_bytes()))
        for version, step in (("old", "old_batch"), ("fixed", "new_batch")):
            assert sent_there[step]["transaction"]["hash"] == deployed["story"][step]["hash"], (
                "the stored testnet transaction is not the recorded one"
            )
            runs.append(
                (
                    "testnet",
                    {
                        "version": version,
                        "transaction": sent_there[step],
                        "before": json.loads(deployed["marks"][f"position_before_{step}"]),
                    },
                )
            )
    for where, run in runs:
        label = {"old": "original", "fixed": "repair"}[run["version"]]
        ast = catalog[label]["ast"]
        tx = run["transaction"]
        sent = tx["transaction"]
        args = json.loads(base64.b64decode(sent["actions"][0]["FunctionCall"]["args"]))
        request = json.loads(args["msg"])
        requested = int(json.loads(request["msg"])["ReturnValue"])
        found = [
            (name, (log, data, frame, len(o["outcome"]["logs"])))
            for o in tx["receipts_outcome"]
            for log in o["outcome"]["logs"]
            if log.startswith("EVENT_JSON:")
            for name, data, frame in [event(log)]
            if name in ("mt_mint", "mt_burn")
        ]
        events = dict(found)
        assert "mt_mint" in events and len(events) == len(found), (
            "one deposit event and at most one refund event are expected"
        )
        mint_log, mint, mint_frame, mint_logs = events["mt_mint"]
        ids, deposits = mint["token_ids"], [int(a) for a in mint["amounts"]]
        assert len(set(ids)) == 1, "the recorded batches use one token id"
        callers = (
            sent["signer_id"],
            sent["receiver_id"],
        )  # the token contract: the signer itself, or the ledger it called
        before = run["before"]
        balance = int(before["credit"] if isinstance(before, dict) else before) + sum(deposits)
        items, refunds = [], []  # the loop of resolve_deposit_internal: the balance falls with every refund
        for token_id, deposited in zip(ids, deposits):
            items.append((len(token_id.encode()), requested, deposited, balance))
            refunds.append(eval_expr(ast, dict(requested_refund=requested, deposited=deposited, balance_left=balance)))
            balance -= refunds[-1]
        mint_model, burn_model = mint_bytes(items), burn_bytes(ast, items)
        mint_real = len(mint_log.encode())
        budget = mint_real + len(REFUND_MEMO) - len(mint["memo"])  # what check_refund compares with the limit
        predicted = budget + burn_model - mint_model
        failed = [
            int(m.group(1))
            for o in tx["receipts_outcome"]
            for m in [
                re.search(
                    r"length of a log message (\d+) exceeds the limit %d" % LIMIT, json.dumps(o["outcome"]["status"])
                )
            ]
            if m
        ]
        checks = {
            "the deposit event lists every token the transaction sent, in order, with its amount": len(ids)
            == len(args["token_ids"])
            and mint["amounts"] == args["amounts"]
            and all(t in [f"nep245:{c}:{a}" for c in callers] for t, a in zip(ids, args["token_ids"])),
            "the deposit event is for the receiver named in the transaction, and is the only log of its call": mint[
                "owner_id"
            ]
            == request["receiver_id"]
            and mint_logs == 1,
            "deposit event = text outside the lists + mintBytes - 2": mint_real == mint_frame + mint_model - 2,
            "what check_refund compared with the limit was within it": budget <= LIMIT,
        }
        if "mt_burn" in events:
            burn_log, burn, burn_frame, burn_logs = events["mt_burn"]
            burn_real, how = len(burn_log.encode()), "written"
            checks.update(
                {
                    "the refund event was written, as the only log of its call": not failed
                    and burn_logs == 1
                    and burn_real <= LIMIT,
                    "the refund event differs from the deposit event outside the lists by the memo only, in length": burn[
                        "memo"
                    ]
                    == REFUND_MEMO
                    and burn["owner_id"] == mint["owner_id"]
                    and burn_frame - mint_frame == len(REFUND_MEMO) - len(mint["memo"]),
                    "the refund event lists the tokens and the amounts computed here": burn["token_ids"]
                    == [t for t, x in zip(ids, refunds) if x]
                    and burn["amounts"] == [str(x) for x in refunds if x],
                    "refund event = text outside the lists + burnBytes - 2": burn_real == burn_frame + burn_model - 2,
                }
            )
        else:
            (burn_real,), how = failed, "refused by the node"
            checks["the refused log was over the limit"] = burn_real > LIMIT
        checks["refund event = deposit event + (6 - memo) + burnBytes - mintBytes"] = burn_real == predicted
        checks["with the repair, burnBytes is not above mintBytes"] = label != "repair" or burn_model <= mint_model
        ok &= all(checks.values())
        if where == "local node":
            seen.add((run["version"], how))
        power = len(str(requested)) - 1
        asked = f"10^{power}" if requested == 10**power and power > 2 else str(requested)
        print(
            f"{'PASS' if all(checks.values()) else 'FAIL'} {where}, {run['version']} code, {len(ids)} token(s) (id {items[0][0]} bytes, deposit {deposits[0]}, {asked} asked back): "
            f"mint event {mint_real} = {mint_frame} + mintBytes {mint_model} - 2; budget {budget};\n"
            f"     refund event {burn_real} ({how}) = budget + burnBytes {burn_model} - mintBytes {mint_model}"
        )
        for name, passed in checks.items():
            if not passed:
                print("     not true:", name)
    both = {
        ("old", "refused by the node"),
        ("fixed", "written"),
    } <= seen  # a record without both outcomes measures too little
    if not both:
        print("FAIL the record has no refused refund event on the old code, or no written one on the fixed code")
    ok = ok and both
    print("PASS the model gives the length of every recorded mint and refund event" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
