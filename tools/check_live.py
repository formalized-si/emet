#!/usr/bin/env python3
"""Check the deployed Emet contracts against this repository. Read-only: view calls and queries, no key.

    python3 tools/check_live.py                      the testnet deployment recorded in deploy/testnet.json
    python3 tools/check_live.py --record <file>      another record written by deploy/live-refund.cjs
    python3 tools/check_live.py --rpc <url>          ask a different RPC node

Python standard library only. It answers four questions from the chain's current state, not from the record:
is the code on the network the code in this repository; can anyone still change it; did the board certify
what the record says; and does the kernel, asked now, accept the real proofs and refuse wrong ones.
"""

import base64, gzip, hashlib, json, pathlib, sys, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ARCHIVAL = {
    "testnet": "https://archival-rpc.testnet.fastnear.com"
}  # asked by --tx for what the first node no longer keeps
CASE = ROOT / "cases/intents-refund"


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Rpc:
    def __init__(self, url):
        self.url, self.calls = url, 0

    def post(self, method, params):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        for attempt in range(4):
            try:
                req = urllib.request.Request(
                    self.url, body, {"content-type": "application/json", "user-agent": "emet-check-live"}
                )
                with urllib.request.urlopen(req, timeout=60) as r:
                    answer = json.load(r)
                self.calls += 1
                return answer
            except OSError:
                if attempt == 3:
                    raise
                time.sleep(1.5 * (attempt + 1))

    def query(self, **request):
        answer = self.post("query", {"finality": "final", **request})
        if "error" in answer:
            raise RuntimeError(json.dumps(answer["error"])[:300])
        return answer["result"]

    def view(self, account, method, args=None):
        """Returns (value, error): a contract that panics gives (None, text)."""
        r = self.query(
            request_type="call_function",
            account_id=account,
            method_name=method,
            args_base64=base64.b64encode(json.dumps(args or {}).encode()).decode(),
        )
        if r.get("error"):
            return None, r["error"]
        return json.loads(bytes(r["result"]).decode()), None

    def code(self, account):
        return base64.b64decode(self.query(request_type="view_code", account_id=account)["code_base64"])

    def keys(self, account):
        return self.query(request_type="view_access_key_list", account_id=account)["keys"]


def main():
    record_path = pathlib.Path(arg("--record", ROOT / "deploy/testnet.json"))
    if not record_path.exists():
        print(f"no record at {record_path}: nothing is deployed from this checkout yet (see deploy/live-refund.cjs)")
        return 2
    record = json.loads(record_path.read_text())
    rpc = Rpc(arg("--rpc", record.get("rpc")))
    acct = record["accounts"]
    catalog = {c["label"]: c for c in json.loads((CASE / "candidates.json").read_text())["candidates"]}
    shelf = json.loads((CASE / "shelf/manifest.json").read_text())
    build = {c["label"]: c for c in json.loads((ROOT / "artifacts/refund/build.json").read_text())["candidates"]}
    sums = dict(
        reversed(line.split()) for line in (ROOT / "artifacts/SHA256SUMS").read_text().splitlines() if line.strip()
    )
    failed = []

    def check(name, ok, detail=""):
        print(("PASS  " if ok else "FAIL  ") + name + (f"  [{detail}]" if detail and not ok else ""))
        if not ok:
            failed.append(name)

    started = time.time()
    print(f"{record['network']}: {rpc.url}")
    print(f"kernel {acct['kernel']}, board {acct['board']}, gate {acct['gate']}, upstream contract {acct['intents']}\n")

    # 1. The code on the network is the code in this repository.
    local = {
        "kernel": "artifacts/kernel.wasm",
        "board": "artifacts/board.wasm",
        "gate": "artifacts/refund/gate.wasm",
        "intents": "artifacts/refund/fixed.wasm",
        "receiver": "artifacts/refund/receiver.wasm",
        "ledger": "artifacts/refund/fixed.wasm",
    }
    for name, file in local.items():
        want, got = sha((ROOT / file).read_bytes()), sha(rpc.code(acct[name]))
        check(f"{acct[name]} runs {file} ({want[:12]}…)", got == want, f"on chain {got[:12]}…")
    check(
        "kernel.wasm and board.wasm are the ones in artifacts/SHA256SUMS",
        sums.get("kernel.wasm") == sha((ROOT / local["kernel"]).read_bytes())
        and sums.get("board.wasm") == sha((ROOT / local["board"]).read_bytes()),
    )
    check(
        "the installed binary is the one build.json ties to the repaired source",
        build["repair"]["wasm_sha256"] == sha((ROOT / local["intents"]).read_bytes())
        and build["repair"]["source_sha256"] == catalog["repair"]["source_sha256"],
    )

    # 2. Nobody holds a key to it.
    for name in ("kernel", "board", "gate", "intents", "ledger"):
        keys = rpc.keys(acct[name])
        check(f"{acct[name]} has no access key", len(keys) == 0, f"{len(keys)} key(s)")
    # The contract's own list of who may do what.
    roles, err = rpc.view(acct["intents"], "acl_get_permissioned_accounts")
    held = (roles or {}).get("roles", {})
    grantees = lambda role: held.get(role, {}).get("grantees", [])
    named = {"Upgrader": [acct["gate"]], "PauseManager": [acct["guardian"]], "UnpauseManager": [acct["guardian"]]}
    check(
        "on the upgraded contract only the gate may upgrade, only the guardian may pause, and nobody holds any other role",
        not err
        and not roles.get("super_admins")
        and all(grantees(r) == who for r, who in named.items())
        and all(not v.get("admins") and (r in named or not v.get("grantees")) for r, v in held.items()),
        err or roles,
    )
    paused, err = rpc.view(acct["intents"], "pa_is_paused", {"key": "mt_on_transfer"})
    check("deposits are not paused now", not err and paused is False, err or paused)

    # 3. What the contracts say about themselves.
    status, err = rpc.view(acct["kernel"], "status")
    check(
        f"the kernel sealed this repository's environment and type-checked all {shelf['base_decls']} declarations",
        not err
        and status["sealed"]
        and status["checked_upto"] == shelf["base_decls"]
        and shelf["base_sha256"] in json.dumps(status),
        err or status,
    )
    config, err = rpc.view(acct["board"], "get_config")
    check(
        "the board judges with that kernel and environment, and its kernel is not recorded broken",
        not err
        and config["kernel"] == acct["kernel"]
        and config["base_hash"] == shelf["base_sha256"]
        and config.get("kernel_broken_by") is None,
        err or config,
    )
    refuted, err = rpc.view(acct["board"], "get_bounty", {"id": "0"})
    check(
        "bounty 0: the old expression was refuted, and the refutation was paid",
        not err
        and refuted["phase"] == "Paid"
        and refuted["certificate"]["side"] == "refutation"
        and refuted["certificate"]["proved"] == catalog["original"]["counter_claim"],
        err,
    )
    proved, err = rpc.view(acct["board"], "get_bounty", {"id": "1"})
    proof = (CASE / "proofs/repair.ndjson").read_bytes()
    check(
        "bounty 1: the repair was proved, paid, and the certificate is for the proof file in this repository",
        not err
        and proved["phase"] == "Paid"
        and proved["certificate"]["side"] == "proof"
        and proved["certificate"]["proved"] == catalog["repair"]["claim"]
        and proved["certificate"]["delta_sha256"] == sha(proof)
        and proved["certificate"]["axioms"] == [],
        err,
    )
    canary = record.get("kernel_bounty")
    if canary:
        b, err = rpc.view(acct["board"], "get_bounty", {"id": canary["id"]})
        check(
            f"a bounty of {canary['reward_near']} NEAR for a proof of False is open on the board, unclaimed",
            not err and b and b["claim"] == "False" and b["phase"] == "Open",
            err or (b or {}).get("phase"),
        )
    tokens = record.get("tokens")
    if tokens:
        backing, e1 = rpc.view(
            acct["ledger"], "mt_balance_of", {"account_id": acct["intents"], "token_id": tokens["on_ledger"]}
        )
        credit, e2 = rpc.view(
            acct["intents"], "mt_balance_of", {"account_id": acct["receiver"], "token_id": tokens["in_contract"]}
        )
        gap = None if (e1 or e2) else int(credit) - int(backing)
        check(
            "the ledger and the contract still disagree by the 80 credits the old code left, and by nothing more",
            gap == 80,
            e1 or e2 or f"credit {credit}, backing {backing}",
        )
    gate, err = rpc.view(acct["gate"], "status")
    registered = {c["id"]: c for c in gate["candidates"]} if not err else {}
    check(
        "the gate applied the repair, to this contract, on this board's certificate",
        not err
        and gate["phase"] == "Applied"
        and gate["candidate"] == "repair"
        and gate["target"] == acct["intents"]
        and gate["board"] == acct["board"],
        err or gate.get("phase"),
    )
    check(
        "the gate registered the repair as exactly this source, this binary and this claim",
        "repair" in registered
        and registered["repair"]["wasm_sha256"] == build["repair"]["wasm_sha256"]
        and registered["repair"]["source_sha256"] == catalog["repair"]["source_sha256"]
        and registered["repair"]["claim"] == catalog["repair"]["claim"],
    )

    # 4. Ask the kernel now. These are fresh view calls; nothing here is read from the record.
    print()
    for label, c in catalog.items():
        delta = (CASE / f"proofs/{label}.ndjson").read_text()
        t = time.time()
        result, err = rpc.view(acct["kernel"], "dry_run", {"theorem_name": c["proved"], "delta": delta})
        side = "the rule holds" if c["proved"] == c["claim"] else "the rule fails"
        check(
            f"kernel accepts the proof that for `{c['expression']}` {side}  ({len(delta)} bytes, {time.time() - t:.1f} s)",
            not err and result.get("ok") is True,
            err or result,
        )

    # Wrong on purpose: each must be refused.
    def with_other_body(delta):
        """The same file with its theorem pointing at the term one before its real proof."""
        lines = delta.rstrip("\n").split("\n")
        row = json.loads(lines[-1])
        row["thm"]["value"] -= 1
        return "\n".join(lines[:-1] + [json.dumps(row, separators=(",", ":"))]) + "\n"

    text = lambda label: (CASE / f"proofs/{label}.ndjson").read_text()
    wrong = [
        (
            "the old expression's refutation, offered as a proof that the old expression is correct",
            catalog["original"]["claim"],
            text("original"),
        ),
        ("the repair's proof, offered for the old expression", catalog["original"]["claim"], text("repair")),
        (
            "the repair's proof with its proof term swapped for another term",
            catalog["repair"]["proved"],
            with_other_body(text("repair")),
        ),
        (
            "the always-zero patch's refutation with its proof term swapped for another term",
            catalog["zero_refund"]["proved"],
            with_other_body(text("zero_refund")),
        ),
    ]
    for name, theorem, delta in wrong:
        result, err = rpc.view(acct["kernel"], "dry_run", {"theorem_name": theorem, "delta": delta})
        check(f"kernel refuses {name}", bool(err) or result.get("ok") is not True, result)

    # The bounties that were left open: who holds them now is read from the board, not from the record.
    listed = record.get("open_bounties") or []
    if listed:
        print()
        board, err = rpc.view(acct["board"], "list_bounties", {})
        now = {b["id"]: b for b in (board or [])}
        check(
            f"the {len(listed)} bounties left open are on the board, each about a patch of this repository's catalog",
            not err
            and all(
                b["id"] in now
                and now[b["id"]]["claim"] == catalog[b["label"]]["claim"]
                and now[b["id"]]["counter_claim"] == catalog[b["label"]]["counter_claim"]
                for b in listed
            ),
            err,
        )
        for b in listed:
            state = now.get(b["id"], {})
            now_is = (
                f"paid to {state.get('winner')}"
                if state.get("phase") == "Paid"
                else str(state.get("phase", "missing")).lower()
            )
            print(f"      #{b['id']}  {b['expression']:<34} {b['reward_near']} NEAR  {now_is}")

    # A bounty paid on this deployment for a proof that a model wrote (evidence/nearai-testnet/claim.json).
    claim_path = ROOT / "evidence/nearai-testnet/claim.json"
    if claim_path.exists() and record["network"] == "testnet":
        claim = json.loads(claim_path.read_text())
        bounty, err = rpc.view(acct["board"], "get_bounty", {"id": claim["bounty"]})
        cert = (bounty or {}).get("certificate") or {}
        proof = (ROOT / claim["proof"]["file"]).read_bytes()
        print()
        check(
            f"bounty {claim['bounty']} was paid to {claim['account']} for a counterexample to `{claim['expression']}`; "
            f"the certificate is for the proof file that {claim['model']} wrote ({len(proof)} bytes, no axiom)",
            not err
            and bounty["phase"] == "Paid"
            and bounty["winner"] == claim["account"]
            and cert.get("side") == "refutation"
            and cert.get("proved") == claim["claim"]
            and cert.get("delta_sha256") == sha(proof)
            and cert.get("axioms") == [],
            err or cert,
        )

    # NEAR Proof Arena's transfer relation, sealed in a second kernel on this network (deploy/testnet-arena.json).
    arena_path = ROOT / "deploy/testnet-arena.json"
    arena = json.loads(arena_path.read_text()) if arena_path.exists() and record["network"] == "testnet" else None
    if arena:
        env = json.loads((ROOT / "evidence/nearspec/size.json").read_text())["sealed_environment"]
        who = arena["account"]
        print()
        check(
            f"{who} runs artifacts/kernel.wasm and has no access key",
            sha(rpc.code(who)) == sha((ROOT / "artifacts/kernel.wasm").read_bytes()) and rpc.keys(who) == [],
        )
        status, err = rpc.view(who, "status")
        check(
            f"it sealed the environment exported from NEAR Proof Arena's specification and type-checked all {env['declarations_as_the_kernel_counts_them']} declarations",
            not err
            and status["sealed"] is True
            and status["base_hash"] == env["sha256"]
            and status["checked_upto"] == status["base_decls"] == env["declarations_as_the_kernel_counts_them"],
            err or status,
        )

    # 5. The recorded transactions, when this node still has them (non-archival nodes forget after a few days).
    if "--tx" in sys.argv:
        print()
        named = {tx["hash"]: step for step, tx in record.get("story", {}).items()}
        old = Rpc(ARCHIVAL[record["network"]]) if record["network"] in ARCHIVAL and not arg("--rpc") else None
        kept_file = (
            ROOT / "deploy/testnet-batches.json.gz"
        )  # the two batch transactions with their logs, for check_log_model.py
        kept = (
            json.loads(gzip.decompress(kept_file.read_bytes()))
            if kept_file.exists() and record["network"] == "testnet"
            else {}
        )
        for tx in record.get("transactions", []):
            step = named.get(tx["hash"]) or tx["label"]
            ask = {"tx_hash": tx["hash"], "sender_account_id": tx["signer"], "wait_until": "NONE"}
            answer = rpc.post("tx", ask)
            if (
                "error" in answer and old
            ):  # an ordinary node forgets transactions after a few days; an archival one keeps them
                answer = old.post("tx", ask)
            if "error" in answer:
                print(
                    f"SKIP  {step}: no node asked has transaction {tx['hash']} (pass an archival --rpc, or open {tx.get('explorer')})"
                )
                continue
            result = answer["result"]
            # "Succeeded" as the record means it: the final status is not a failure and no receipt failed on the way.
            steps = [result.get("transaction_outcome", {})] + result.get("receipts_outcome", [])
            ok = "Failure" not in json.dumps(result.get("status", {})) and not any(
                "Failure" in json.dumps(o.get("outcome", {}).get("status", {})) for o in steps
            )
            check(
                f"{step}: transaction {tx['hash'][:10]}… {'ran without a failed receipt' if tx['ok'] else 'had a failed receipt'}, as recorded",
                ok == tx["ok"]
                and result["transaction"]["signer_id"] == tx["signer"]
                and result["transaction"]["receiver_id"] == tx["receiver"],
            )
            if step in kept:
                receipts = lambda t: [
                    (o["id"], o["outcome"]["logs"], o["outcome"]["status"]) for o in t["receipts_outcome"]
                ]
                check(
                    f"{step}: every receipt, log and outcome of it is as kept in deploy/testnet-batches.json.gz",
                    receipts(result) == receipts(kept[step]),
                )

        # The transactions that carried the Arena's proofs: what was sent, and what the contract returned.
        for row in (arena or {}).get("results", []):
            ask = {"tx_hash": row["hash"], "sender_account_id": arena["master"], "wait_until": "NONE"}
            answer = rpc.post("tx", ask)
            if "error" in answer and old:
                answer = old.post("tx", ask)
            if "error" in answer:
                print(f"SKIP  {row['label']}: no node asked has transaction {row['hash']}")
                continue
            result = answer["result"]
            sent = base64.b64decode(result["transaction"]["actions"][0]["FunctionCall"]["args"])
            claim, _, proof = sent.partition(b"\n")
            verdict = json.loads(base64.b64decode(result["status"].get("SuccessValue") or "e30="))
            file = (ROOT / row["proof"]).read_bytes()
            check(
                f"{row['label']}: transaction {row['hash'][:10]}… sent the proof file of this repository under `{row['claim']}`, and the contract "
                + ("accepted it" if row["must_be_accepted"] else "refused it"),
                claim.decode() == row["claim"]
                and sha(proof) == sha(file) == row["proof_sha256"]
                and (verdict.get("ok") is True) == row["must_be_accepted"] == row["accepted"]
                and result["transaction"]["receiver_id"] == arena["account"],
                verdict.get("reason"),
            )
    calls = rpc.calls + (old.calls if "--tx" in sys.argv and old else 0)
    print(
        f"\n{'all checks passed' if not failed else str(len(failed)) + ' check(s) FAILED'}: {calls} read-only RPC calls, {time.time() - started:.0f} s"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OSError as error:  # the RPC node is unreachable; nothing was checked
        print(f"could not reach the RPC node: {error}. Nothing was checked. Pass --rpc <url> to ask another node.")
        sys.exit(2)
