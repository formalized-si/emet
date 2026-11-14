#!/usr/bin/env python3
"""Check, offline, what NEAR AI Cloud attests about an agent's proof (Python standard library only).

usage: python3 -S tools/verify_nearai.py <agent evidence dir>      (it has a nearai/ subdirectory)
       python3 -S tools/verify_nearai.py --tamper <agent evidence dir>
       python3 -S tools/verify_nearai.py --statement <saved RefundCase.lean> <generated RefundCase.lean>
           says whether the two are the same text, or the same Lean with other comments; fails otherwise.
           checks the checker: thirteen copies of the evidence, each with one change (a bit of a response, the
           nonce, a byte of the quote, another key, an edited log, an edited Solution.lean, ...), must all fail.
           A refund attempt gets up to nine more (the prompt, the patch, the statement, the proof bytes, the sealed
           environment, the recorded certificate and its axioms, the recorded installation, a round's refutation).

The evidence was recorded by agent/nearai.py in the order NEAR AI's verification docs require: the
attestation report first, with a nonce made by the agent (nearai/records.json), then the completions,
then their signatures. Nothing here calls the network.

The report (nearai/attestation.json). For the gateway, for every model report, and for the quote of
the compose manager inside each model report:
  1. the Intel TDX quote is version 4, TEE type 0x81, and the TD is not in debug mode;
  2. the quote's signatures: its certificate chain ends in the Intel SGX Root CA key pinned below, the
     leaf (PCK) key signed the quoting enclave's report, that report commits to the attestation key,
     and the attestation key signed the quote header and TD report;
  3. the quote's report_data is `signing key || nonce` with the agent's nonce (for the compose manager:
     `sha256(its action log) || nonce`);
  4. MRCONFIGID is the sha256 of the `app_compose` text in the report, and replaying the event log
     gives the quote's RTMR3.
  5. The model report names the model the agent asked for; the compose manager's quote carries the same
     measurements as the model's quote, and its attested action log names the deployment last started.
Every response (nearai/NNNN.{request,response,signature}.json):
  6. the signed text is `<model>:<sha256 of the request bytes>:<sha256 of the response bytes>` for
     exactly the bytes kept (or `<request>:<response>` for a gateway signature);
  7. the ed25519 signature verifies, and its key is the one in exactly one report checked above.
The proof:
  8. Solution.lean in the evidence directory is, byte for byte, the last `write_solution` call in
     those signed responses.
A refund attempt (agent/nearai_patch.py; the directory also has prompt.md and candidate.rs), each part when its
files are there:
  9. prompt.md is the first message of every signed request;
 10. candidate.rs is the pinned upstream file (cases/intents-refund/upstream/tokens.rs) with only the refund
     expression replaced, by the last `propose_patch` call before that `write_solution` call; a refuted round's
     round<k>-candidate.rs holds an expression some signed `propose_patch` call proposed; RefundCase.lean, the
     generated statement of the claim, is in a tool result of a signed request;
 11. proof.ndjson declares no axiom, its theorem `Refund.user_patch` states exactly the claim generated for the
     sha256 of candidate.rs, and nanoda, this repository's kernel built natively (tools/native), type-checks the
     sealed environment (base.ndjson.gz) plus the proof; the same for a refuted round's generated refutation;
 12. the recorded local job (result.json, upgrade.json, written by cases/intents-refund/propose.py and
     tools/package_proposal.py) is for these bytes: the kernel contract's certificate names this claim, the
     sha256 of proof.ndjson and of the sealed environment, and the axioms that report.json records from Lean's
     `#print axioms` (none, when the attempt asked for none); the board paid the prover, the gate installed the wasm
     built from the source with the sha256 of candidate.rs, the same account answered 100 before and 1 after, and
     the job used the kernel, board and gate binaries of this repository;
 13. upgrade-full.json.gz, when kept, is the full trace whose sha256 result.json names.
Checks 12 and 13 compare records this repository wrote itself; they do not run a chain.

What this shows: a key that an Intel TDX VM reported in its quote signed the model id together with
the hashes of each request and response, and the proof text is in one of those responses. So the text
came through NEAR AI's model-serving VM with the measured configuration, under that model id.

What it does not show. It says nothing about whether the proof is correct: Lean checks that, and the
kernel contract checks it again. Not checked here, because it needs a network service: Intel's TCB
status and revocation lists for the platform (use dcap-qvl or https://cloud.near.ai/verify), and the
NVIDIA GPU evidence (NVIDIA NRAS). Not checked at all: certificate validity dates; the identity of the
quoting enclave; what the measured images do, in particular that the deployment named in step 5 loads
the weights its name says (the deployment file itself is not in the report); that the report and the
completions came from the same VM (instances of one model share a signing key). The nonce and the times
in records.json are the agent's own: to anyone else they show consistency, not freshness.
"""

import base64, gzip, hashlib, json, pathlib, re, struct, subprocess, sys, tempfile

REPO = pathlib.Path(__file__).resolve().parents[1]

# --- ed25519 verification (RFC 8032, section 6 reference algorithm) ---------------------------
P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, P - 2, P) % P
I = pow(2, (P - 1) // 4, P)


def _xrecover(y):
    xx = (y * y - 1) * pow(D * y * y + 1, P - 2, P)
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P:
        x = x * I % P
    if x % 2:
        x = P - x
    return x


def _add(a, b):
    (x1, y1, z1, t1), (x2, y2, z2, t2) = a, b
    A, B = (y1 - x1) * (y2 - x2) % P, (y1 + x1) * (y2 + x2) % P
    C, Dd = t1 * 2 * D * t2 % P, z1 * 2 * z2 % P
    E, F, G, H = B - A, Dd - C, Dd + C, B + A
    return (E * F % P, G * H % P, F * G % P, E * H % P)


def _mul(s, pt):
    q = (0, 1, 1, 0)
    while s:
        if s & 1:
            q = _add(q, pt)
        pt, s = _add(pt, pt), s >> 1
    return q


def _decode(b):
    y = int.from_bytes(b, "little") & ((1 << 255) - 1)
    if y >= P:
        return None
    x = _xrecover(y)
    if (x & 1) != (b[31] >> 7):
        x = P - x
    if (-x * x + y * y - 1 - D * x * x * y * y) % P:
        return None
    return (x, y, 1, x * y % P)


def _eq(a, b):
    return (a[0] * b[2] - b[0] * a[2]) % P == 0 and (a[1] * b[2] - b[1] * a[2]) % P == 0


_BY = 4 * pow(5, P - 2, P) % P
BASE = (_xrecover(_BY), _BY, 1, _xrecover(_BY) * _BY % P)


def ed25519_verify(pub: bytes, msg: bytes, sig: bytes) -> bool:
    if len(pub) != 32 or len(sig) != 64:
        return False
    A, R = _decode(pub), _decode(sig[:32])
    s = int.from_bytes(sig[32:], "little")
    if A is None or R is None or s >= L:
        return False
    h = int.from_bytes(hashlib.sha512(sig[:32] + pub + msg).digest(), "little") % L
    return _eq(_mul(s, BASE), _add(R, _mul(h, A)))


# --- ECDSA P-256 verification (FIPS 186-4), for the quote and its certificate chain ------------
PP = 2**256 - 2**224 + 2**192 + 2**96 - 1
PN = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
PB = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
PG = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)
# The public key (X || Y) of the Intel SGX Root CA, the root of every TDX quote's certificate chain
# (Intel publishes the certificate at https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.pem).
INTEL_SGX_ROOT_KEY = bytes.fromhex(
    "0ba9c4c0c0c86193a3fe23d6b02cda10a8bbd4e88e48b4458561a36e705525f5"
    "67918e2edc88e40d860bd0cc4ee26aacc988e505a953558c453f6b0904ae7394"
)


def _padd(a, b):  # affine points; None is the point at infinity
    if a is None or b is None:
        return a or b
    (x1, y1), (x2, y2) = a, b
    if x1 == x2:
        if (y1 + y2) % PP == 0:
            return None
        lam = (3 * x1 * x1 - 3) * pow(2 * y1, -1, PP) % PP
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, PP) % PP
    x3 = (lam * lam - x1 - x2) % PP
    return x3, (lam * (x1 - x3) - y1) % PP


def _pmul(k, pt):
    r = None
    while k:
        if k & 1:
            r = _padd(r, pt)
        pt, k = _padd(pt, pt), k >> 1
    return r


def p256_verify(pub: bytes, msg: bytes, r: int, s: int) -> bool:
    if len(pub) != 64:
        return False
    x, y = int.from_bytes(pub[:32], "big"), int.from_bytes(pub[32:], "big")
    if not (0 < r < PN and 0 < s < PN and x < PP and y < PP) or (y * y - x * x * x + 3 * x - PB) % PP:
        return False
    e, w = int.from_bytes(hashlib.sha256(msg).digest(), "big"), pow(s, -1, PN)
    pt = _padd(_pmul(e * w % PN, PG), _pmul(r * w % PN, (x, y)))
    return pt is not None and pt[0] % PN == r


def _der(b, i):  # one DER element at i -> (tag, start of content, end)
    n, j = b[i + 1], i + 2
    if n & 0x80:
        k = n & 0x7F
        n, j = int.from_bytes(b[j : j + k], "big"), j + k
    return b[i], j, j + n


def cert_parts(der: bytes):
    """An X.509 certificate with a P-256 key and an ECDSA signature -> (signed bytes, key X||Y, r, s)."""
    _, a, _ = _der(der, 0)
    _, ta, te = _der(der, a)  # tbsCertificate
    _, _, se = _der(der, te)  # signatureAlgorithm
    _, ba, _ = _der(der, se)  # signature: BIT STRING { SEQUENCE { r, s } }
    _, qa, _ = _der(der, ba + 1)
    _, ra, re_ = _der(der, qa)
    _, sa, s_end = _der(der, re_)
    fields, i = [], ta  # [0] version, serial, algorithm, issuer, validity, subject, key
    while i < te:
        tag, x, y = _der(der, i)
        fields.append((tag, x))
        i = y
    _, _, alg_end = _der(der, fields[6 if fields[0][0] == 0xA0 else 5][1])
    _, ka, ke = _der(der, alg_end)  # BIT STRING: 00 04 X Y
    key = der[ka:ke]
    if len(key) != 66 or key[:2] != b"\x00\x04":
        raise ValueError("not an uncompressed P-256 key")
    return der[a:te], key[2:], int.from_bytes(der[ra:re_], "big"), int.from_bytes(der[sa:s_end], "big")


# --- the checks -----------------------------------------------------------------------------
def J(v):
    return json.loads(v) if isinstance(v, str) else v


def quote_fields(quote_hex: str):
    """A TDX quote v4 -> its TD report fields, after checking every signature from the quote up to the pinned root."""
    q = bytes.fromhex(quote_hex)
    if len(q) < 1100 or struct.unpack_from("<HHI", q, 0) != (4, 2, 0x81):
        raise ValueError("not a TDX quote v4 with an ECDSA P-256 attestation key")
    td = q[48:632]
    sig = q[636 : 636 + struct.unpack_from("<I", q, 632)[0]]
    quote_sig, att_key = sig[:64], sig[64:128]
    kind, size = struct.unpack_from("<HI", sig, 128)
    qe = sig[134 : 134 + size]  # type 6: QE report, its signature, QE auth data, then the certificates
    if kind != 6:
        raise ValueError(f"certification data type {kind}, expected 6")
    qe_report, qe_sig = qe[:384], qe[384:448]
    alen = struct.unpack_from("<H", qe, 448)[0]
    auth = qe[450 : 450 + alen]
    kind, size = struct.unpack_from("<HI", qe, 450 + alen)
    if kind != 5:
        raise ValueError(f"inner certification data type {kind}, expected 5 (a PCK certificate chain)")
    pem = qe[456 + alen : 456 + alen + size].decode()
    chain = [
        cert_parts(base64.b64decode(c))
        for c in re.findall(r"-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", pem, re.S)
    ]
    rs = lambda b: (int.from_bytes(b[:32], "big"), int.from_bytes(b[32:], "big"))
    steps = [len(chain) >= 2 and chain[-1][1] == INTEL_SGX_ROOT_KEY]
    steps += [
        p256_verify(issuer[1], tbs, r, s) for (tbs, _, r, s), issuer in zip(chain, chain[1:] + chain[-1:])
    ]  # the root signs itself
    steps += [
        p256_verify(chain[0][1], qe_report, *rs(qe_sig)),
        qe_report[320:352] == hashlib.sha256(att_key + auth).digest(),
        p256_verify(att_key, q[:632], *rs(quote_sig)),
    ]
    if not all(steps):
        raise ValueError(
            f"quote signature chain broken (root pin, certificates…, QE report, key binding, quote: {steps})"
        )
    return {
        "debug": bool(td[120] & 1),
        "mr_td": td[136:184],
        "mr_config_id": td[184:232],
        "rtmr": [td[328 + 48 * i : 376 + 48 * i] for i in range(4)],
        "report_data": td[520:584],
    }


def replay_rtmr3(event_log) -> bytes:
    r = bytes(48)
    for e in J(event_log):
        if e.get("imr") != 3:
            continue
        digest = hashlib.sha384(
            struct.pack("<I", e["event_type"])
            + b":"
            + e["event"].encode()
            + b":"
            + bytes.fromhex(e.get("event_payload") or "")
        ).digest()
        if e.get("digest") and bytes.fromhex(e["digest"]) != digest:
            raise ValueError(f"event {e['event']}: digest mismatch")
        r = hashlib.sha384(r + digest).digest()
    return r


def stated(export: bytes, theorem: str):
    """In a lean4export file: the name of the constant that is this theorem's type (None if it is anything else)."""
    names, consts, found = {0: ""}, {}, None
    try:
        for line in export.split(b"\n"):
            v = json.loads(line) if line.startswith((b'{"in"', b'{"const"', b'{"thm"')) else {}
            if "in" in v:
                pre, s = (v["str"]["pre"], v["str"]["str"]) if "str" in v else (v["num"]["pre"], str(v["num"]["i"]))
                names[v["in"]] = f"{names[pre]}.{s}" if names[pre] else s
            elif "const" in v:
                consts[v["ie"]] = names.get(v["const"]["name"])
            elif "thm" in v and names.get(v["thm"]["name"]) == theorem:
                found = consts.get(v["thm"]["type"])
    except (ValueError, KeyError, TypeError):  # a damaged file states nothing
        return None
    return found


NATIVE = REPO / "tools/native/target/release/proof-courier-native"


def statement(saved: str, generated: str):
    """The statement a model was shown against the generator's text -> "the same text", "the same declarations, other comments", or None."""
    bare = lambda t: [
        l.rstrip() for l in re.sub(r"--[^\n]*", "", re.sub(r"/-.*?-/", "", t, flags=re.S)).splitlines() if l.strip()
    ]
    return (
        "the same text"
        if saved == generated
        else "the same declarations, other comments"
        if bare(saved) == bare(generated)
        else None
    )


def native(export: bytes) -> bool:
    """nanoda as the kernel contract builds it (tools/native) type-checks this export file."""
    with tempfile.NamedTemporaryFile(suffix=".ndjson") as f:
        f.write(export)
        f.flush()
        return NATIVE.exists() and subprocess.run([str(NATIVE), f.name], capture_output=True).returncode == 0


def main(d: pathlib.Path) -> int:
    rec = d / "nearai"
    meta = json.loads((rec / "records.json").read_text())
    model, nonce = meta["model"], meta.get("nonce", "")
    att = json.loads((rec / "attestation.json").read_text())
    ok_all, results = True, []

    def check(label, ok, detail=""):
        nonlocal ok_all
        ok_all &= bool(ok)
        results.append({"check": label, "ok": bool(ok), "detail": detail})
        print(f"{'ok  ' if ok else 'FAIL'} {label}{(': ' + detail) if detail else ''}")

    def quote(label, quote_hex, want_first32: bytes, event_log, app_compose):
        """Checks 1-4 on one quote; returns its fields, or None if its signatures do not hold."""
        try:
            f = quote_fields(quote_hex)
        except (ValueError, IndexError, struct.error) as e:
            check(f"{label}: TDX quote v4, signed by a key certified under the Intel SGX Root CA", False, str(e))
            return None
        check(
            f"{label}: TDX quote v4, signed by a key certified under the Intel SGX Root CA; TD not in debug mode",
            not f["debug"],
        )
        check(
            f"{label}: report_data binds {'the signing key' if app_compose else 'the action log'} and the agent's nonce",
            len(nonce) == 64 and f["report_data"] == want_first32.ljust(32, b"\0") + bytes.fromhex(nonce),
            want_first32.hex()[:16] + "… || " + nonce[:16] + "…",
        )
        if app_compose is not None:
            check(
                f"{label}: MRCONFIGID is the sha256 of app_compose",
                f["mr_config_id"] == b"\x01" + hashlib.sha256(app_compose.encode()).digest() + bytes(15),
                hashlib.sha256(app_compose.encode()).hexdigest()[:16] + "…",
            )
        try:
            check(f"{label}: the event log replays to the quote's RTMR3", replay_rtmr3(event_log) == f["rtmr"][3])
        except (ValueError, KeyError) as e:
            check(f"{label}: the event log replays to the quote's RTMR3", False, str(e))
        return f

    def report(label, a):
        f = quote(
            label,
            a.get("intel_quote", ""),
            bytes.fromhex(a.get("signing_address", "")),
            a.get("event_log", "[]"),
            J(a.get("info", {}).get("tcb_info", {})).get("app_compose", ""),
        )
        good = (
            f is not None
            and a.get("signing_algo") == "ed25519"
            and a.get("request_nonce") == nonce
            and not a.get("tls_cert_fingerprint")
        )
        return f, good

    n_before = len(results)
    gw = att.get("gateway_attestation") or {}
    _, gw_ok = report("gateway", gw)
    keys = {
        "gateway": [gw["signing_address"]] if gw_ok and all(r["ok"] for r in results[n_before:]) else [],
        "provider_tee": [],
    }
    candidates = att.get("model_attestations") or []
    check(
        "the report has model evidence, fetched for the model the agent asked for",
        bool(candidates) and all(m.get("model_name") == model for m in candidates),
        model,
    )
    for i, m in enumerate(candidates):
        label, n_before = f"model report {i + 1}", len(results)
        f, good = report(label, m)
        cm = m.get("compose_manager_attestation") or {}
        acts = J(cm.get("actions") or [])
        log_hash = hashlib.sha256(json.dumps(acts, separators=(",", ":"), sort_keys=True).encode()).digest()
        g = quote(f"{label}, compose manager", cm.get("quote", ""), log_hash, cm.get("event_log", "[]"), None)
        check(
            f"{label}: the compose manager's quote carries the model quote's measurements (MRTD, RTMR0-3, MRCONFIGID)",
            bool(f and g) and all(f[k] == g[k] for k in ("mr_td", "mr_config_id", "rtmr")),
        )
        ups = [x for x in acts if x.get("action") == "compose_up"]
        last = ups[-1] if ups else {}
        check(
            f"{label}: the attested action log names the deployment last started",
            bool(last.get("file")),
            f"{last.get('file')} (commit {str(last.get('commit'))[:10]}, sha256 {str(last.get('file_sha256'))[:12]}…, {last.get('timestamp', '')[:19]})",
        )
        gpu = J(m.get("nvidia_payload") or "{}")
        check(
            f"{label}: GPU evidence is present and carries the nonce (its content is NOT verified here)",
            str(gpu.get("nonce", "")).lower() == nonce.lower(),
        )
        if good and all(r["ok"] for r in results[n_before:]):
            keys["provider_tee"].append(m["signing_address"])
    signed, bodies = 0, []
    for r in meta["records"]:
        n = r["n"]
        req, resp = (rec / f"{n}.request.json").read_bytes(), (rec / f"{n}.response.json").read_bytes()
        rh, ph = hashlib.sha256(req).hexdigest(), hashlib.sha256(resp).hexdigest()
        try:
            s = json.loads((rec / f"{n}.signature.json").read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            s = {}
        text, sig, addr, kind = (
            s.get("text", ""),
            s.get("signature", ""),
            s.get("signing_address", ""),
            s.get("signature_kind"),
        )
        expect = {"provider_tee": f"{model}:{rh}:{ph}", "gateway": f"{rh}:{ph}"}.get(kind)
        try:
            good = (
                s.get("signing_algo") == "ed25519"
                and text == expect
                and keys.get(kind, []).count(addr) == 1
                and ed25519_verify(bytes.fromhex(addr), text.encode(), bytes.fromhex(sig.removeprefix("0x")))
            )
        except ValueError:
            good = False
        signed += good
        if good and kind == "provider_tee":
            bodies.append((n, resp))
        check(
            f"response {n}: {kind or 'no'} signature over the model id and sha256 of the request and response bytes, by an attested key",
            good,
            f"{rh[:10]}…/{ph[:10]}…",
        )
    check(
        f"{signed} of {len(meta['records'])} responses carry a valid signature",
        signed == len(meta["records"]) and signed > 0,
    )
    # The proof text itself: the last write_solution call in the responses signed by the model's key.
    last_write, patches = (
        None,
        [],
    )  # patches: (position, expression) of every propose_patch call (agent/nearai_patch.py)
    for n, resp in bodies:
        for i, tc in enumerate(json.loads(resp)["choices"][0]["message"].get("tool_calls") or []):
            try:
                args = json.loads(tc["function"]["arguments"])
                if tc["function"]["name"] == "write_solution":
                    last_write = (n, str(args.get("content", "")), (n, i))
                elif tc["function"]["name"] == "propose_patch":
                    patches.append(((n, i), str(args.get("expression", "")).strip()))
            except (json.JSONDecodeError, AttributeError):  # the agent refused these arguments too
                pass
    sol = d / "Solution.lean"
    if sol.exists():
        check(
            "Solution.lean is, byte for byte, the last write_solution call in the responses signed by the model's key",
            last_write is not None and last_write[1].encode() == sol.read_bytes(),
            f"response {last_write[0]}, sha256 {hashlib.sha256(sol.read_bytes()).hexdigest()[:16]}…"
            if last_write
            else "no signed write_solution call",
        )
    try:
        refund(d, check, [n for n, _ in bodies], last_write, patches)
    except Exception as e:  # a damaged or missing file is a failed check, not a crash
        check("the files of the refund attempt can be read", False, f"{type(e).__name__}: {e}")
    (rec / "verification.json").write_text(
        json.dumps({"model": model, "ok": ok_all, "checks": results}, indent=1) + "\n"
    )
    print(
        "\nNEAR AI attestation checks passed (offline; see the top of tools/verify_nearai.py for what they do not show)."
        if ok_all
        else "\nSome NEAR AI attestation checks FAILED."
    )
    return 0 if ok_all else 1


def refund(d, check, signed, last_write, patches):
    """Checks 9-13: the parts of a refund attempt that are there."""
    sha = lambda b: hashlib.sha256(b).hexdigest()
    load = lambda name: json.loads((d / name).read_text())
    case = REPO / "cases/intents-refund"
    if (d / "prompt.md").exists():
        first = [json.loads((d / f"nearai/{n}.request.json").read_bytes())["messages"][0]["content"] for n in signed]
        check(
            "prompt.md is the first message of every signed request",
            bool(first) and all(m.encode() == (d / "prompt.md").read_bytes() for m in first),
        )
    rounds = sorted(d.glob("round*-candidate.rs"))
    if not rounds and not (d / "candidate.rs").exists():
        return
    sys.path.insert(0, str(case))
    import prepare

    upstream = (case / "upstream/tokens.rs").read_bytes()
    patched = lambda e: upstream.replace(prepare.SITE.encode(), f"let refund_amount = {e};".encode())
    check(
        "cases/intents-refund/upstream/tokens.rs is the pinned upstream file",
        sha(upstream) == prepare.UPSTREAM_SHA,
        prepare.UPSTREAM_SHA[:16] + "…",
    )

    def kernel(label, source, delta, base_gz, side, recorded):
        """Check 11 for one proof file -> (the claim it must state, the sealed environment, the proof)."""
        claim = f"Refund.C_{sha(source.read_bytes())}.{side}"
        base, proof = gzip.decompress(base_gz.read_bytes()), delta.read_bytes()
        check(
            f"{label} and its sealed environment are the bytes report.json records", (sha(proof), sha(base)) == recorded
        )
        check(
            f"{label} declares no axiom, opaque or quotient",
            not any(l.startswith((b'{"axiom"', b'{"opaque"', b'{"quot"')) for l in proof.split(b"\n")),
        )
        check(
            f"{label}: its theorem Refund.user_patch states exactly the claim generated for {source.name}",
            stated(base + proof, "Refund.user_patch") == claim,
            claim,
        )
        check(
            f"nanoda (this repository's kernel, native) type-checks the sealed environment + {label}",
            native(base + proof),
            f"{len(proof):,} bytes, sha256 {sha(proof)[:16]}…, environment {sha(base)[:16]}…"
            if NATIVE.exists()
            else "not built: (cd tools/native && cargo build --release)",
        )
        return claim, base, proof

    rep = load("report.json")
    for c in rounds:
        check(
            f"{c.name} is the pinned file with only the refund expression replaced, by a propose_patch call in a signed response",
            c.read_bytes() in [patched(e) for _, e in patches],
        )
        k = c.name.split("-")[0]
        if (d / f"{k}-refutation.ndjson").exists():
            row = rep["rounds"][int(k[5:]) - 1]
            kernel(
                f"{k}-refutation.ndjson",
                c,
                d / f"{k}-refutation.ndjson",
                d / f"{k}-base.ndjson.gz",
                "Refute",
                (row["refutation_sha256"], row["base_sha256"]),
            )
    cand = d / "candidate.rs"
    if not cand.exists():
        return
    before = [(at, e) for at, e in patches if last_write and at < last_write[2]]
    check(
        "candidate.rs is the pinned file with only the refund expression replaced, by the last propose_patch call before that write_solution call",
        bool(before) and cand.read_bytes() == patched(before[-1][1]),
        f"response {before[-1][0][0]}: {before[-1][1]}" if before else "no signed propose_patch call",
    )
    if (
        d / "RefundCase.lean"
    ).exists():  # the statement of the claim, as the model saw it: in a tool result of a signed request
        shown = [
            m.get("content") or ""
            for n in signed
            for m in json.loads((d / f"nearai/{n}.request.json").read_bytes())["messages"]
            if m.get("role") == "tool"
        ]
        check(
            "RefundCase.lean, the generated statement of the claim, is in a signed request",
            any((d / "RefundCase.lean").read_text() in c for c in shown),
        )
    if not (d / "proof.ndjson").exists() or not (d / "base.ndjson.gz").exists():
        return
    claim, base, proof = kernel(
        "proof.ndjson",
        cand,
        d / "proof.ndjson",
        d / "base.ndjson.gz",
        "Correct",
        (rep.get("proof_sha256"), rep.get("base_sha256")),
    )
    if not (d / "result.json").exists():
        return
    res, up, job = load("result.json"), load("upgrade.json"), rep.get("job", {})
    bounty, tx = up["candidate_bounty"], {t["label"]: t["result"] for t in up["transactions"]}
    cert = bounty.get("certificate") or {}
    build = next(c for c in up["build"]["candidates"] if c["label"] == "user_patch")
    answer = lambda label: json.loads(base64.b64decode(tx[label]["status"]["SuccessValue"]))[0]
    check(
        "recorded job: complete, every check of the run passed, the implementation did not change while it ran",
        res["state"] == "complete"
        and res["implementation_unchanged"]
        and up["ok"] is True
        and len(up["checks"]) >= 14
        and all(c["ok"] for c in up["checks"]),
        f"{sum(c['ok'] for c in up['checks'])}/{len(up['checks'])} checks",
    )
    check(
        "recorded job: the kernel contract's certificate is for this claim, these proof bytes and this sealed environment; the board paid the prover",
        cert.get("side") == "proof"
        and cert.get("proved") == claim
        and cert.get("delta_sha256") == sha(proof)
        and cert.get("base_hash") == sha(base) == up["base_sha256"]
        and bounty["phase"] == "Paid"
        and bounty["winner"] == up["accounts"]["prover"],
        f"bounty {bounty.get('id')}, winner {bounty.get('winner')}",
    )
    if rep.get("axioms") is not None:
        check(
            "recorded job: the certificate lists the axioms Lean reported for the model's proof"
            + (", and this attempt asked for none" if rep.get("no_axioms_asked") else ""),
            sorted(cert.get("axioms") or []) == sorted(rep["axioms"])
            and not (rep.get("no_axioms_asked") and rep["axioms"]),
            ", ".join(rep["axioms"]) or "no axiom",
        )
    check(
        "recorded job: the gate installed the wasm built from this candidate, and the same account answered 100 before and 1 after",
        build["source_sha256"] == sha(cand.read_bytes()) == res["source_sha256"]
        and up["gate"]["phase"] == "Applied"
        and up["gate"]["candidate"] == "user_patch"
        and up["installed"] is True
        and up["after_wasm_sha256"] == build["wasm_sha256"] != up["before_wasm_sha256"]
        and answer("old contract refund") == "100"
        and answer("same refund after upgrade") == "1"
        and not any(up["access_keys"].values()),
        f"wasm {str(up.get('after_wasm_sha256'))[:16]}…",
    )
    mine = {
        "kernel": sha((REPO / "artifacts/kernel.wasm").read_bytes()),
        "board": sha((REPO / "artifacts/board.wasm").read_bytes()),
        "gate": sha((REPO / "artifacts/refund/gate.wasm").read_bytes()),
    }
    check(
        "recorded job: it used this repository's kernel, board and gate binaries",
        job.get("code_sha256") == mine and up["patch_gate_sha256"] == mine["gate"],
        f"kernel {mine['kernel'][:16]}…",
    )
    if (d / "upgrade-full.json.gz").exists():
        check(
            "upgrade-full.json.gz is the full trace result.json names",
            sha(gzip.decompress((d / "upgrade-full.json.gz").read_bytes())) == res.get("full_record_sha256"),
        )


def tamper(d: pathlib.Path) -> int:
    import contextlib, io, shutil

    def att(change):  # a change to the attestation report
        def apply(w):
            p = w / "nearai/attestation.json"
            a = json.loads(p.read_text())
            change(a, a["model_attestations"][0])
            p.write_text(json.dumps(a))

        return apply

    def bit(name, at=None):  # one bit of a stored file
        def apply(w):
            p = w / name
            b = bytearray(p.read_bytes())
            b[len(b) // 2 if at is None else at] ^= 1
            p.write_bytes(b)

        return apply

    def quote_byte(at):
        def change(a, m):
            q = bytearray(bytes.fromhex(m["intel_quote"]))
            q[at] ^= 1
            m["intel_quote"] = q.hex()

        return att(change)

    def nonce(w):
        p = w / "nearai/records.json"
        p.write_text(json.dumps({**json.loads(p.read_text()), "nonce": "00" * 32}))

    ns = [
        r["n"] for r in json.loads((d / "nearai/records.json").read_text())["records"]
    ]  # the answered requests: one that got no response has no record

    def swap(w):
        a, b = w / f"nearai/{ns[0]}.signature.json", w / f"nearai/{ns[1]}.signature.json"
        x = a.read_bytes()
        a.write_bytes(b.read_bytes())
        b.write_bytes(x)

    def compose(a, m):
        t = J(m["info"]["tcb_info"])
        m["info"]["tcb_info"] = {**t, "app_compose": t["app_compose"] + " "}

    cases = {
        "nothing changed": lambda w: None,
        "one bit of the last response": bit(f"nearai/{ns[-1]}.response.json"),
        "one bit of the first request": bit(f"nearai/{ns[0]}.request.json"),
        "another nonce in records.json": nonce,
        "a byte of report_data inside the model's quote": quote_byte(570),
        "a byte of the model quote's signature": quote_byte(640),
        "the model report names the gateway's key": att(
            lambda a, m: m.update(signing_address=a["gateway_attestation"]["signing_address"])
        ),
        "the gateway's quote in place of the model's": att(
            lambda a, m: m.update(intel_quote=a["gateway_attestation"]["intel_quote"])
        ),
        "an edited line in the compose manager's action log": att(
            lambda a, m: m["compose_manager_attestation"]["actions"][-1].update(file="prod/Other.yaml")
        ),
        "one more character in app_compose": att(compose),
        "the report is for another model": att(lambda a, m: m.update(model_name="another/model")),
        "one more line in Solution.lean": lambda w: (w / "Solution.lean").write_text(
            (w / "Solution.lean").read_text() + "-- edited\n"
        ),
        "a signature file removed": lambda w: (w / f"nearai/{ns[0]}.signature.json").unlink(),
        "two signatures swapped": swap,
    }
    if len(ns) < 2:
        del cases["two signatures swapped"]

    def record(change):  # a change to the recorded local job
        def apply(w):
            u = json.loads((w / "upgrade.json").read_text())
            change(u)
            (w / "upgrade.json").write_text(json.dumps(u))

        return apply

    def base(w):
        b = bytearray(gzip.decompress((w / "base.ndjson.gz").read_bytes()))
        b[b.index(b"sourceDigest") + 1] ^= 1
        (w / "base.ndjson.gz").write_bytes(gzip.compress(bytes(b)))

    has = lambda name: (d / name).exists()
    lean_axioms = has("report.json") and json.loads((d / "report.json").read_text()).get("axioms") is not None
    refund_cases = [  # (it applies, what is changed, how)
        (
            has("prompt.md"),
            "one more character in prompt.md",
            lambda w: (w / "prompt.md").write_text((w / "prompt.md").read_text() + " "),
        ),
        (has("candidate.rs"), "one bit of candidate.rs", bit("candidate.rs")),
        (
            has("RefundCase.lean"),
            "another statement in RefundCase.lean",
            lambda w: (w / "RefundCase.lean").write_text((w / "RefundCase.lean").read_text().replace("∀", "∃")),
        ),
        (has("proof.ndjson"), "one bit of proof.ndjson", bit("proof.ndjson")),
        (has("base.ndjson.gz"), "one bit of the sealed environment", base),
        (
            has("upgrade.json"),
            "the recorded certificate names other proof bytes",
            record(lambda u: u["candidate_bounty"]["certificate"].update(delta_sha256="00" * 32)),
        ),
        (
            has("upgrade.json") and lean_axioms,
            "the recorded certificate lists another axiom",
            record(lambda u: u["candidate_bounty"]["certificate"].update(axioms=["Classical.choice"])),
        ),
        (
            has("upgrade.json"),
            "the recorded job installed another wasm",
            record(lambda u: u.update(after_wasm_sha256="00" * 32)),
        ),
    ]
    cases.update((name, change) for applies, name, change in refund_cases if applies)
    for f in sorted(d.glob("round*-refutation.ndjson"))[:1]:
        cases["one bit of a refuted round's refutation"] = bit(f.name)
    bad = 0
    for name, change in cases.items():
        with tempfile.TemporaryDirectory() as t:
            w = pathlib.Path(t) / "evidence"
            shutil.copytree(d, w)
            change(w)
            with contextlib.redirect_stdout(io.StringIO()):
                passed = main(w) == 0
        as_expected = passed == (name == "nothing changed")
        bad += not as_expected
        print(f"{'ok  ' if as_expected else 'FAIL'} {name}: the checks {'pass' if passed else 'fail'}")
    print(f"\n{len(cases) - 1} tamperings tried, {'each is caught' if not bad else str(bad) + ' NOT as expected'}.")
    return 1 if bad else 0


if __name__ == "__main__":
    # Known answers first, so the verifiers themselves are checked on every run: RFC 8032 test 1 (ed25519, empty message) ...
    assert ed25519_verify(
        bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
        b"",
        bytes.fromhex(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        ),
    )
    # ... and RFC 6979 A.2.5 (ECDSA P-256 with SHA-256, message "sample"), which must fail for another message.
    _K = bytes.fromhex(
        "60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299"
    )
    _R, _S = (
        0xEFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716,
        0xF7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8,
    )
    assert p256_verify(_K, b"sample", _R, _S) and not p256_verify(_K, b"sampl3", _R, _S)
    if sys.argv[1] == "--statement":
        same = statement(pathlib.Path(sys.argv[2]).read_text(), pathlib.Path(sys.argv[3]).read_text())
        sys.exit(print(same) if same else "the saved statement and the generated one are different Lean")
    sys.exit(tamper(pathlib.Path(sys.argv[2])) if sys.argv[1] == "--tamper" else main(pathlib.Path(sys.argv[1])))
