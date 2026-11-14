"""Re-express standalone lean4export exports (Lean Kernel Arena tests) as deltas on a sealed shelf.

usage: python3 -I arena_delta.py <shelf base.ndjson> <claim> <out_dir> <root_dir> <export.ndjson>...

An arena export is a whole environment: it declares `Nat`, `Eq`, ... again, so the kernel
contract's delta check would stop it at "redefines a shelf name" before the kernel sees anything.
This rewrites one mechanically, without touching what it says:

* every name, level and expression is renumbered into the shelf's tables (an entry the shelf
  already has keeps the shelf's index; a new one gets the next index, as lean4export would);
* a declaration whose name is on the shelf is dropped if it is the same declaration there up to
  the names and implicit/explicit marks of bound variables (the arena exports with Lean 4.34.1,
  the shelf with 4.35.0, and core's hygienic binder names and a few binder marks differ between
  them; the kernel never looks at either). If it
  differs in anything else, the export cannot be a delta on this shelf (`conflict`): the test IS
  a redefinition of a shelf name, and only the base-sealing path can run it;
* one theorem is appended, because the contract checks a delta only as the proof of something:
  - `claim`: the export's last declaration is a closed proof of `False`, so the theorem proves the
    bounty claim from it, `hostile.proof : <claim> := False.rec (fun _ => <claim>) <last>`, which
    is what an attacker would send;
  - `carrier`: otherwise `hostile.carrier : True := True.intro`. The contract type-checks every
    declaration of a delta, so the export's declarations still go through the kernel.

Writes <out_dir>/<export path under root_dir, '/' as '__'>.delta.ndjson and <out_dir>/index.json.
It always writes `carrier.delta.ndjson` too: the appended carrier theorem alone, a control.
"""

import hashlib, json, os, sys

# which fields of each line kind are indices into which table (n: name, l: level, e: expression)
REFS = {
    "str": {"pre": "n"},
    "num": {"pre": "n"},
    "succ": "l",
    "max": ["l"],
    "imax": ["l"],
    "param": "n",
    "bvar": None,
    "sort": "l",
    "natVal": None,
    "strVal": None,
    "const": {"name": "n", "us": ["l"]},
    "app": {"fn": "e", "arg": "e"},
    "lam": {"name": "n", "type": "e", "body": "e"},
    "forallE": {"name": "n", "type": "e", "body": "e"},
    "letE": {"name": "n", "type": "e", "value": "e", "body": "e"},
    "proj": {"typeName": "n", "struct": "e"},
}
DECL = {
    "name": "n",
    "type": "e",
    "value": "e",
    "levelParams": ["n"],
    "all": ["n"],
    "ctors": ["n"],
    "induct": "n",
    "ctor": "n",
    "rhs": "e",
}
KINDS = ("axiom", "def", "thm", "opaque", "quot", "inductive")
dump = lambda o: json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def tr(v, spec, m):
    """Translate the indices in payload `v` through the maps `m` = {"n": .., "l": .., "e": ..}."""
    if spec is None:
        return v
    if isinstance(spec, str):
        return m[spec][v]
    if isinstance(spec, list):
        return [m[spec[0]][x] for x in v]
    return {k: tr(x, spec.get(k), m) for k, x in v.items()}


def tr_decl(kind, body, m):
    if kind != "inductive":
        return tr(body, DECL, m)
    out = {part: [tr(x, DECL, m) for x in body.get(part, [])] for part in ("types", "ctors", "recs")}
    for r, src in zip(out["recs"], body.get("recs", [])):
        r["rules"] = [tr(x, DECL, m) for x in src.get("rules", [])]
    return out


def alpha(kind, payload, sem):
    """The expression `payload` with its subexpressions named by their classes in `sem`, binder names and marks dropped."""
    v = dict(payload) if isinstance(payload, dict) else payload
    if kind in ("lam", "forallE", "letE"):
        del v["name"]
        v.pop("binderInfo", None)
    for f, c in (REFS[kind] or {}).items() if isinstance(v, dict) else ():
        if c == "e":
            v[f] = sem[v[f]]
    return dump({kind: v})


def same_up_to_binders(kind, body, sem):
    """Canonical text of a declaration with every expression replaced by its class."""
    return dump({kind: tr_decl(kind, body, {"n": Ident(), "l": Ident(), "e": sem})})


class Ident(dict):
    def __missing__(self, k):
        return k


def declared(kind, body):
    if kind != "inductive":
        return [body["name"]]
    return [x["name"] for part in ("types", "ctors", "recs") for x in body.get(part, [])]


class Shelf:
    def __init__(self, path):
        self.key = {"n": {}, "l": {}, "e": {}}  # canonical payload -> index
        self.next = {"n": 1, "l": 1, "e": 0}
        self.decl = {}  # declared name index -> its declaration, up to binder names
        self.names = {0: ""}
        self.cls, self.sem = {}, {}  # expression class (up to binder names) of each index
        for line in open(path, "rb"):
            x = json.loads(line)
            t = "n" if "in" in x else "l" if "il" in x else "e" if "ie" in x else None
            if t:
                i = x.pop("i" + t)
                self.key[t][dump(x)] = i
                self.next[t] = max(self.next[t], i + 1)
                if t == "e":
                    ((k, v),) = x.items()
                    self.sem[i] = self.cls.setdefault(alpha(k, v, self.sem), len(self.cls))
                if t == "n":
                    ((k, v),) = x.items()
                    self.names[i] = (self.names[v["pre"]] + "." if v["pre"] else "") + str(
                        v["str"] if k == "str" else v["i"]
                    )
            else:
                ((k, v),) = x.items()
                if k in KINDS:
                    for n in declared(k, v):
                        self.decl[n] = same_up_to_binders(k, v, self.sem)


class Delta:
    """Lines to append to the shelf; allocates new indices after the shelf's."""

    def __init__(self, shelf):
        self.s, self.lines = shelf, []
        self.key = {t: dict(d) for t, d in shelf.key.items()}
        self.next = dict(shelf.next)
        self.names = dict(shelf.names)
        self.cls, self.sem = dict(shelf.cls), dict(shelf.sem)

    def intern(self, t, payload):
        k = dump(payload)
        i = self.key[t].get(k)
        if i is None:
            i = self.key[t][k] = self.next[t]
            self.next[t] += 1
            self.lines.append(dump({"i" + t: i, **payload}))
            if t == "e":
                ((kk, v),) = payload.items()
                self.sem[i] = self.cls.setdefault(alpha(kk, v, self.sem), len(self.cls))
            if t == "n":
                ((kk, v),) = payload.items()
                self.names[i] = (self.names[v["pre"]] + "." if v["pre"] else "") + str(
                    v["str"] if kk == "str" else v["i"]
                )
        return i

    def name(self, dotted):
        i = 0
        for part in dotted.split("."):
            i = self.intern("n", {"str": {"pre": i, "str": part}})
        return i

    def const(self, dotted):
        return self.intern("e", {"const": {"name": self.name(dotted), "us": []}})

    def thm(self, dotted, type_, value):
        n = self.name(dotted)
        self.lines.append(dump({"thm": {"all": [n], "levelParams": [], "name": n, "type": type_, "value": value}}))


def convert(shelf, claim, data):
    d = Delta(shelf)
    m = {"n": {0: 0}, "l": {0: 0}, "e": {}}
    last = None
    for ln, line in enumerate(data.split(b"\n"), 1):
        if not line.strip():
            continue
        try:
            x = json.loads(line)
            t = "n" if "in" in x else "l" if "il" in x else "e" if "ie" in x else None
            if t:
                i = x.pop("i" + t)
                ((k, v),) = x.items()
                m[t][i] = d.intern(t, {k: tr(v, REFS[k], m)})
                continue
            ((k, v),) = x.items()
            if k == "meta":
                continue
            body = tr_decl(k, v, m)
        except (ValueError, KeyError, TypeError, AttributeError) as e:
            return {"status": "unreadable", "why": f"line {ln}: {type(e).__name__}: {e}"}, None
        names = declared(k, body)
        on_shelf = [n for n in names if n in shelf.decl]
        if on_shelf:
            if len(on_shelf) == len(names) and all(shelf.decl[n] == same_up_to_binders(k, body, d.sem) for n in names):
                continue  # the shelf has this very declaration
            return {"status": "conflict", "why": f"declares the shelf name `{d.names[on_shelf[0]]}` differently"}, None
        d.lines.append(dump({k: body}))
        last = (k, body)
    info = {"status": "delta", "test_lines": len(d.lines)}
    false_ = d.key["e"].get(dump({"const": {"name": d.name("False"), "us": []}}))
    if (
        last
        and last[0] in ("thm", "def")
        and not last[1]["levelParams"]
        and last[1]["type"] == false_
        and false_ is not None
    ):
        c = d.const(claim)
        motive = d.intern("e", {"lam": {"binderInfo": "default", "name": d.name("x"), "type": false_, "body": c}})
        rec = d.intern("e", {"const": {"name": d.name("False.rec"), "us": [0]}})
        proof = d.intern(
            "e",
            {
                "app": {
                    "fn": d.intern("e", {"app": {"fn": rec, "arg": motive}}),
                    "arg": d.intern("e", {"const": {"name": last[1]["name"], "us": []}}),
                }
            },
        )
        d.thm("hostile.proof", c, proof)
        info.update(form="claim", statement_name=claim, proves_false=d.names[last[1]["name"]])
    else:
        d.thm("hostile.carrier", d.const("True"), d.const("True.intro"))
        info.update(form="carrier", statement_name="hostile.carrier")
    return info, ("\n".join(d.lines) + "\n").encode()


def main():
    base, claim, out, root, *exports = sys.argv[1:]
    shelf = Shelf(base)
    os.makedirs(out, exist_ok=True)
    index = {}
    for path in [None, *exports]:
        data = open(path, "rb").read() if path else b""
        rel = os.path.relpath(path, root) if path else "carrier"
        info, delta = convert(shelf, claim, data)
        if path:
            info["source_sha256"] = hashlib.sha256(data).hexdigest()
        if delta is not None:
            name = rel.replace(os.sep, "__").removesuffix(".ndjson") + ".delta.ndjson"
            open(os.path.join(out, name), "wb").write(delta)
            info.update(delta=name, delta_sha256=hashlib.sha256(delta).hexdigest(), delta_bytes=len(delta))
        index[rel] = info
    json.dump(index, open(os.path.join(out, "index.json"), "w"), indent=1)
    open(os.path.join(out, "index.json"), "a").write("\n")
    n = lambda **kw: sum(all(i.get(k) == v for k, v in kw.items()) for r, i in index.items() if r != "carrier")
    print(
        f"{len(exports)} exports: {n(status='delta')} deltas ({n(form='claim')} as a proof of the claim, {n(form='carrier')} with the carrier theorem), "
        f"{n(status='conflict')} redeclare a shelf name differently, {n(status='unreadable')} unreadable"
    )


if __name__ == "__main__":
    main()
