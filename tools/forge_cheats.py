"""Forge the cheats Lean itself refuses to produce, at the export (NDJSON) level.

usage: python3 forge_cheats.py <shelf base.ndjson> <valid delta.ndjson> <valid theorem> <out_dir>

* fakePropext.delta.ndjson: declares `axiom propext : False` (a shelf name) and proves the
  claim from it. The kernel must refuse the redefinition before parsing anything.
* twinPropext.delta.ndjson: the same axiom under a fresh name-table entry spelling `propext`,
  so the shelf's name index is not reused. The redefinition scan cannot see it by index, but the
  delta still declares an axiom, which the scan refuses (nanoda's parser would also reject the
  duplicate name).
* swapPolicy.delta.ndjson: re-declares `Wallet.step` with another definition's body, i.e.
  "prove the property about a different wallet". Refused the same way.
* illTyped.delta.ndjson: the valid proof with the final theorem's value replaced by its own
  type. It parses, but the Lean kernel's type check fails (a panic in the contract).
* builtinGcd.delta.ndjson and builtinString.delta.ndjson: each declares a name that the type checker
  computes by itself and that the shelf does not declare. `Nat.gcd` gets the body "always 0". The checker
  still computes `Nat.gcd 4 6` to 2, so `2 = 0` has a proof, and from it `False` and the claim. `String`
  becomes `def String : Prop := False`, and the checker gives a string literal that type. The bare type
  checker accepts both files. The contract refuses a delta that declares such a name
  (`builtin_name_in_delta`). The kernel of 12 November 2026 accepted both.

The same two for another sealed environment and claim:
       python3 forge_cheats.py builtin <base.ndjson> <claim constant> <out_dir>
"""

import json, os, sys


def load(path):
    return [json.loads(line) for line in open(path) if line.strip()]


def builtin_forgeries(base_path, claim, out):
    """Two proof files for `claim` over a sealed environment that lacks `Nat.gcd` and `String`.
    A file is not written if the environment declares the name that the file needs."""
    names, dotted, exprs, declared = {}, {0: ""}, {}, set()
    max_in = max_ie = 0
    succ0 = None  # the index of universe level 1
    for x in load(base_path):
        if "in" in x:
            part = x.get("str") or x["num"]
            comp = part["str"] if "str" in x else str(part["i"])
            names[(part["pre"], comp)] = x["in"]
            dotted[x["in"]] = (dotted[part["pre"]] + "." if dotted[part["pre"]] else "") + comp
            max_in = max(max_in, x["in"])
        elif "ie" in x:
            exprs[json.dumps({k: v for k, v in x.items() if k != "ie"}, sort_keys=True)] = x["ie"]
            max_ie = max(max_ie, x["ie"])
        elif "il" in x:
            if x.get("succ") == 0:
                succ0 = x["il"]
        elif "inductive" in x:
            declared |= {dotted[t["name"]] for k in ("types", "ctors", "recs") for t in x["inductive"].get(k, [])}
        else:
            for kind in ("axiom", "def", "thm", "opaque", "quot"):
                if kind in x:
                    declared.add(dotted[x[kind]["name"]])
    assert succ0 is not None, "the environment has no universe level 1"
    w = lambda o: json.dumps(o, sort_keys=True, separators=(",", ":"))
    os.makedirs(out, exist_ok=True)

    def forge(file, needs, absent, build):
        missing = [n for n in needs + [claim] if n not in declared]
        assert not missing, f"the environment does not declare {missing}"
        if absent in declared:
            print(f"{file}: not written, the environment declares {absent}")
            return
        lines, state = [], {"in": max_in, "ie": max_ie, "names": dict(names), "exprs": dict(exprs)}

        def name(text):
            pre = 0
            for comp in text.split("."):
                if (pre, comp) not in state["names"]:
                    state["in"] += 1
                    state["names"][(pre, comp)] = state["in"]
                    lines.append(w({"in": state["in"], "str": {"pre": pre, "str": comp}}))
                pre = state["names"][(pre, comp)]
            return pre

        def expr(o):
            key = json.dumps(o, sort_keys=True)
            if key not in state["exprs"]:
                state["ie"] += 1
                state["exprs"][key] = state["ie"]
                lines.append(w({**o, "ie": state["ie"]}))
            return state["exprs"][key]

        def app(f, *args):
            for a in args:
                f = expr({"app": {"fn": f, "arg": a}})
            return f

        const = lambda n, us=(): expr({"const": {"name": name(n), "us": list(us)}})
        x = name("x")
        lam = lambda ty, body: expr({"lam": {"binderInfo": "default", "body": body, "name": x, "type": ty}})
        pi = lambda ty, body: expr({"forallE": {"binderInfo": "default", "body": body, "name": x, "type": ty}})
        thm = lambda n, ty, val: lines.append(
            w({"thm": {"all": [name(n)], "levelParams": [], "name": name(n), "type": ty, "value": val}})
        )
        absurd = build(name, expr, app, const, lam, pi, thm, lines, w)  # a proof of False
        # theorem <file>.proof : <claim> := False.rec (fun _ => <claim>) absurd
        stem = file.split(".")[0]
        thm(f"{stem}.proof", const(claim), app(const("False.rec", [0]), lam(const("False"), const(claim)), absurd))
        open(os.path.join(out, file), "w").write("\n".join(lines) + "\n")

    def gcd(name, expr, app, const, lam, pi, thm, lines, w):
        nat, prop = const("Nat"), expr({"sort": 0})
        lit = lambda k: expr({"natVal": str(k)})
        eq = lambda a, b: app(const("Eq", [succ0]), nat, a, b)
        # def Nat.gcd : Nat → Nat → Nat := fun _ _ => 0
        g = name("Nat.gcd")
        lines.append(
            w(
                {
                    "def": {
                        "all": [g],
                        "hints": {"regular": 1},
                        "levelParams": [],
                        "name": g,
                        "safety": "safe",
                        "type": pi(nat, pi(nat, nat)),
                        "value": lam(nat, lam(nat, lit(0))),
                    }
                }
            )
        )
        # theorem builtinGcd.zero : ∀ a b : Nat, Nat.gcd a b = 0 := fun a b => Eq.refl 0    (true for the body above)
        thm(
            "builtinGcd.zero",
            pi(nat, pi(nat, eq(app(const("Nat.gcd"), expr({"bvar": 1}), expr({"bvar": 0})), lit(0)))),
            lam(nat, lam(nat, app(const("Eq.refl", [succ0]), nat, lit(0)))),
        )
        # theorem builtinGcd.absurd : False :=
        #   @Eq.rec Nat 2 (fun n _ => Nat.rec False (fun _ _ => True) n) True.intro 0 (builtinGcd.zero 4 6)
        # `builtinGcd.zero 4 6 : Nat.gcd 4 6 = 0`. The checker computes `Nat.gcd 4 6` to 2 and takes it for `2 = 0`.
        is_succ = lambda n: app(
            const("Nat.rec", [succ0]), lam(nat, prop), const("False"), lam(nat, lam(prop, const("True"))), n
        )
        motive = lam(nat, lam(eq(lit(2), expr({"bvar": 0})), is_succ(expr({"bvar": 1}))))
        thm(
            "builtinGcd.absurd",
            const("False"),
            app(
                const("Eq.rec", [0, succ0]),
                nat,
                lit(2),
                motive,
                const("True.intro"),
                lit(0),
                app(const("builtinGcd.zero"), lit(4), lit(6)),
            ),
        )
        return const("builtinGcd.absurd")

    def string(name, expr, app, const, lam, pi, thm, lines, w):
        # def String : Prop := False
        s = name("String")
        lines.append(
            w(
                {
                    "def": {
                        "all": [s],
                        "hints": "abbrev",
                        "levelParams": [],
                        "name": s,
                        "safety": "safe",
                        "type": expr({"sort": 0}),
                        "value": const("False"),
                    }
                }
            )
        )
        # theorem builtinString.absurd : False := "x"      (the checker gives the literal the type `String`)
        thm("builtinString.absurd", const("False"), expr({"strVal": "x"}))
        return const("builtinString.absurd")

    forge(
        "builtinGcd.delta.ndjson",
        ["Nat", "Nat.rec", "Eq", "Eq.refl", "Eq.rec", "True", "True.intro", "False", "False.rec"],
        "Nat.gcd",
        gcd,
    )
    forge("builtinString.delta.ndjson", ["False", "False.rec"], "String", string)


def main():
    if sys.argv[1] == "builtin":
        return builtin_forgeries(*sys.argv[2:5])
    base_path, valid_path, valid_thm, out = sys.argv[1:5]
    base = load(base_path)
    names, rev = {}, {}
    max_in = max_ie = 0
    for x in base:
        if "in" in x:
            max_in = max(max_in, x["in"])
            if "str" in x:
                names.setdefault((x["str"]["pre"], x["str"]["str"]), x["in"])
                rev[x["in"]] = (x["str"]["pre"], x["str"]["str"])
            else:
                rev[x["in"]] = (x["num"]["pre"], str(x["num"]["i"]))
        if "ie" in x:
            max_ie = max(max_ie, x["ie"])

    def idx(dotted):
        pre = 0
        for part in dotted.split("."):
            pre = names[(pre, part)]
        return pre

    def full(i):
        parts = []
        while i:
            pre, s = rev[i]
            parts.append(s)
            i = pre
        return ".".join(reversed(parts))

    w = lambda o: json.dumps(o, separators=(",", ":"))
    os.makedirs(out, exist_ok=True)
    const_expr = {}
    for x in base:
        if "const" in x and x["const"]["us"] == []:
            const_expr.setdefault(x["const"]["name"], x["ie"])

    # 1. axiom propext : False, then a "proof" of the claim by False.elim-free reuse.
    lines = []
    n_propext, n_false = idx("propext"), idx("False")
    ie_false = const_expr.get(n_false)
    if ie_false is None:
        max_ie += 1
        ie_false = max_ie
        lines.append(w({"const": {"name": n_false, "us": []}, "ie": ie_false}))
    max_in += 1
    n_bad = max_in
    lines.insert(0, w({"in": n_bad, "str": {"pre": 0, "str": "fake_propext_proof"}}))
    lines.append(w({"axiom": {"isUnsafe": False, "levelParams": [], "name": n_propext, "type": ie_false}}))
    max_ie += 1
    lines.append(w({"const": {"name": n_propext, "us": []}, "ie": max_ie}))
    lines.append(w({"thm": {"all": [n_bad], "levelParams": [], "name": n_bad, "type": ie_false, "value": max_ie}}))
    open(os.path.join(out, "fakePropext.delta.ndjson"), "w").write("\n".join(lines) + "\n")

    # 1b. The same, under a fresh name-table entry that spells `propext` again, so the
    #     declaration does not reuse the shelf's name index.
    lines = []
    if const_expr.get(n_false) is None:
        lines.append(w({"const": {"name": n_false, "us": []}, "ie": ie_false}))
    max_in += 1
    n_twin = max_in
    max_in += 1
    n_bad2 = max_in
    lines.insert(0, w({"in": n_twin, "str": {"pre": 0, "str": "propext"}}))
    lines.insert(1, w({"in": n_bad2, "str": {"pre": 0, "str": "fake_propext_twin_proof"}}))
    lines.append(w({"axiom": {"isUnsafe": False, "levelParams": [], "name": n_twin, "type": ie_false}}))
    max_ie += 1
    lines.append(w({"const": {"name": n_twin, "us": []}, "ie": max_ie}))
    lines.append(w({"thm": {"all": [n_bad2], "levelParams": [], "name": n_bad2, "type": ie_false, "value": max_ie}}))
    open(os.path.join(out, "twinPropext.delta.ndjson"), "w").write("\n".join(lines) + "\n")

    # 2. Re-declare Wallet.step with the body of another definition.
    step = next(x for x in base if "def" in x and full(x["def"]["name"]) == "Wallet.step")
    other = next(x for x in base if "def" in x and full(x["def"]["name"]) == "Wallet.rollDay")
    swapped = json.loads(json.dumps(step))
    swapped["def"]["value"] = other["def"]["value"]
    open(os.path.join(out, "swapPolicy.delta.ndjson"), "w").write(w(swapped) + "\n")

    # 3. Ill-typed: the valid delta, with the claimed theorem's value set to its type.
    out_lines, hit = [], False
    for x in load(valid_path):
        if "in" in x:
            if "str" in x:
                rev[x["in"]] = (x["str"]["pre"], x["str"]["str"])
            else:
                rev[x["in"]] = (x["num"]["pre"], str(x["num"]["i"]))
        if "thm" in x and full(x["thm"]["name"]) == valid_thm:
            x["thm"]["value"] = x["thm"]["type"]
            hit = True
        out_lines.append(w(x))
    assert hit, f"{valid_thm} not found in {valid_path}"
    open(os.path.join(out, "illTyped.delta.ndjson"), "w").write("\n".join(out_lines) + "\n")

    # 4. A name that the type checker computes by itself, declared by the delta. The claim is the type of the valid proof.
    valid = load(valid_path)
    thm_type = next(x["thm"]["type"] for x in valid if "thm" in x and full(x["thm"]["name"]) == valid_thm)
    claim = next(full(x["const"]["name"]) for x in base + valid if x.get("ie") == thm_type and "const" in x)
    builtin_forgeries(base_path, claim, out)
    print(
        "forged fakePropext, twinPropext, swapPolicy (Wallet.step <- Wallet.rollDay body), illTyped, builtinGcd, builtinString"
    )


if __name__ == "__main__":
    main()
