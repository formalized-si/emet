#!/usr/bin/env python3
"""Translate one pinned Rust patch site. Unsupported syntax/context fails closed.

This small extractor is trusted, not a verified general Rust frontend. Only the
refund expression in the exact recorded upstream file may change. Its grammar
is u128 variables, u128 literals, parentheses, and the inherent u128 min method.
"""

import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAX = 2**128 - 1
UPSTREAM_SHA = "72245952a41246be823dfbe992b2ff76be05461008b4257b6ad0cb20954fc37e"
ORIGINAL = "balance_left.min(requested_refund)"
SITE = "let refund_amount = " + ORIGINAL + ";"
# The comment on the line above the expression. The pinned commit carries the first; its parent commit, and
# upstream's main branch, carry the second. A candidate may have either. With the second and upstream's
# expression the file is byte for byte upstream's own at the parent commit.
TEMP_NOTE = "// TEMPORARY LOCAL CHANGE: refunds are NOT capped by deposited amounts"
MAIN_NOTE = "// NOTE: refunds are capped by deposited amounts and balance left on the receiver"
PARENT_REVISION = "de07b1f16f28af30778d02cae188710e30bd02fa"
PARENT_FILE_SHA = "9ceacc45c79c529b7c5176cb562c983378487348c42bcd1dfbd8c90c42d77bb1"


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Parser:
    def __init__(self, source):
        if len(source) > 4096:
            raise ValueError("expression is too large")
        self.tokens = re.findall(r"requested_refund|balance_left|deposited|\d+u128|\d+|min|[.*()]", source)
        if "".join(self.tokens) != re.sub(r"\s", "", source):
            raise ValueError("unsupported Rust expression")
        self.i = 0

    def take(self, token):
        if self.i >= len(self.tokens) or self.tokens[self.i] != token:
            raise ValueError(f"expected {token}")
        self.i += 1

    def expr(self):
        if self.i >= len(self.tokens):
            raise ValueError("missing expression")
        token = self.tokens[self.i]
        self.i += 1
        if token == "(":
            e = self.expr()
            self.take(")")
        elif token == "*":
            self.take("deposited")
            # Rust reads `*deposited.min(x)` as `*(deposited.min(x))`, which does not type-check (`.min` on &u128);
            # a method call on the dereference needs `(*deposited).min(x)`. Return here so `.min` cannot bind to a
            # bare `*deposited`: `*deposited.min(x)` then fails closed with trailing tokens.
            return ["arg", "deposited"]
        elif token in ("requested_refund", "balance_left"):
            e = ["arg", token]
        elif re.fullmatch(r"\d+(u128)?", token):
            n = int(token.removesuffix("u128"))
            if n > MAX:
                raise ValueError("u128 literal overflow")
            e = ["lit", n]
        else:
            raise ValueError("unsupported variable or dereference")
        while self.i < len(self.tokens) and self.tokens[self.i] == ".":
            self.take(".")
            self.take("min")
            self.take("(")
            rhs = self.expr()
            self.take(")")
            e = ["min", e, rhs]
        return e

    def parse(self):
        result = self.expr()
        if self.i != len(self.tokens):
            raise ValueError("trailing expression tokens")
        return result


def eval_expr(e, args):
    if e[0] == "arg":
        return args[e[1]]
    if e[0] == "lit":
        return e[1]
    return min(eval_expr(e[1], args), eval_expr(e[2], args))


def lean_expr(e):
    if e[0] == "arg":
        return {"requested_refund": ".requested", "deposited": ".deposited", "balance_left": ".balance"}[e[1]]
    if e[0] == "lit":
        return "(.literal maxU128)" if e[1] == MAX else f"(.literal {e[1]})"
    return f"(.least {lean_expr(e[1])} {lean_expr(e[2])})"


def bind_candidate(upstream, source):
    if sha(upstream) != UPSTREAM_SHA:
        raise ValueError("upstream context hash changed")
    template = upstream.decode().split(SITE)
    if len(template) != 2:
        raise ValueError("upstream patch site is not unique")
    text = source.decode()
    head, suffix = template[0], ";" + template[1]
    if head.count(TEMP_NOTE) != 1 or not head.rstrip(" ").endswith(TEMP_NOTE + "\n"):
        raise ValueError("upstream comment above the patch site is not where it was")
    for note in (TEMP_NOTE, MAIN_NOTE):
        prefix = head.replace(TEMP_NOTE, note) + "let refund_amount = "
        if text.startswith(prefix) and text.endswith(suffix):
            expr = text[len(prefix) : len(text) - len(suffix)]
            return expr, Parser(expr).parse()
    raise ValueError("candidate changes code outside the reviewed patch site")


def main():
    upstream = (HERE / "upstream/tokens.rs").read_bytes()
    if sha(upstream) != UPSTREAM_SHA:
        raise ValueError("upstream file differs from its pinned digest")
    candidates = {
        "original": ORIGINAL,
        "deposit_only": "requested_refund.min(*deposited)",
        "ignore_request": "(*deposited).min(balance_left)",
        "zero_refund": "0u128",
        "repair": "requested_refund.min(*deposited).min(balance_left)",
    }
    proposal_path = HERE / "proposal.json"
    proposal = json.loads(proposal_path.read_text()) if proposal_path.exists() else None
    if proposal is not None:
        expression = proposal["expression"]
        Parser(expression).parse()
        candidates = {"original": ORIGINAL, "user_patch": expression}
    records = []
    generated = [
        "import Init\nnamespace Refund\n",
        "inductive Expr where\n  | requested | deposited | balance | literal (n : Nat) | least (a b : Expr)\n",
        "structure Args where\n  requested : Nat\n  deposited : Nat\n  balance : Nat\n",
        "def eval (a : Args) : Expr → Nat\n  | .requested => a.requested\n  | .deposited => a.deposited\n  | .balance => a.balance\n  | .literal n => n\n  | .least x y => min (eval a x) (eval a y)\n",
        f"def maxU128 : Nat := {MAX}\n",
        "def InRange (a : Args) : Prop := a.requested ≤ maxU128 ∧ a.deposited ≤ maxU128 ∧ a.balance ≤ maxU128\n",
        # The rule is stated as requirements, not as a formula to copy. Its second line is upstream's own
        # comment ("refunds are capped by deposited amounts and balance left on the receiver").
        "/-- The refund rule for one deposit: `r` is the amount returned. -/\n"
        "def Rule (a : Args) (r : Nat) : Prop :=\n"
        "  r ≤ a.requested ∧  -- never more than the receiver asked to return\n"
        '  r ≤ a.deposited ∧  -- upstream\'s comment: "refunds are capped by deposited amounts"\n'
        '  r ≤ a.balance ∧    -- "and balance left on the receiver"\n'
        "  (r = a.requested ∨ r = a.deposited ∨ r = a.balance)  -- and never less than the three allow\n",
        "def meetsRule (e : Expr) : Prop := ∀ a : Args, InRange a → Rule a (eval a e)\n",
        # Three facts about `min`, proved here from the definition so that a proof of the rule needs no axiom
        # (the library's own Nat.min_le_left, Nat.min_le_right and Nat.min_eq_right depend on propext).
        "theorem min_right {x y : Nat} (h : y ≤ x) : min x y = y := by\n"
        "  cases Nat.le_total x y with\n"
        "  | inl hxy => exact (Nat.min_eq_left hxy).trans (Nat.le_antisymm hxy h)\n"
        "  | inr _ =>\n"
        "    rw [Nat.min_def]\n"
        "    cases Nat.lt_or_ge y x with\n"
        "    | inl hlt => exact ite_eq_right (Nat.not_le_of_gt hlt)\n"
        "    | inr hge => exact (ite_eq_left hge).trans (Nat.le_antisymm hge h)\n",
        "theorem min_le_first (x y : Nat) : min x y ≤ x := by\n"
        "  cases Nat.le_total x y with\n"
        "  | inl h => rw [Nat.min_eq_left h]; exact Nat.le_refl x\n"
        "  | inr h => rw [min_right h]; exact h\n",
        "theorem min_le_second (x y : Nat) : min x y ≤ y := by\n"
        "  cases Nat.le_total x y with\n"
        "  | inl h => rw [Nat.min_eq_left h]; exact h\n"
        "  | inr h => rw [min_right h]; exact Nat.le_refl y\n",
        "theorem min_repeat (x y : Nat) : min x (min x y) = min x y := by rw [← Nat.min_assoc, Nat.min_self]\n",
    ]
    proofs = [
        "import RefundCase\n"
        + ("import CandidateProof\n" if proposal and proposal.get("external_proof") else "")
        + "set_option linter.unusedSimpArgs false\nnamespace Refund\n"
    ]
    # Generic tactic proofs may use propext. It is part of the explicitly checked
    # initial environment, never an axiom introduced by a submitted proof delta.
    # The sealed environment of the five candidates contains no axiom. A caller's own patch gets an environment
    # that also admits propext and the library lemmas that depend on it, because simp-style proofs need them.
    roots = [
        "Nat.le_trans",
        "Nat.le_total",
        "Nat.le_antisymm",
        "Nat.le_refl",
        "Nat.min_eq_left",
        "Nat.min_def",
        "Nat.lt_or_ge",
        "Nat.not_le_of_gt",
        "Nat.not_le",
        "Nat.lt_irrefl",
        "Nat.lt_of_lt_of_le",
        "Nat.le_of_lt",
        "Refund.min_right",
        "Refund.min_le_first",
        "Refund.min_le_second",
    ]
    roots += (
        [
            "propext",
            "Nat.min_le_left",
            "Nat.min_le_right",
            "Nat.min_eq_right",
            "Nat.le_min",
            "Nat.min_assoc",
            "Nat.min_comm",
            "Nat.min_left_comm",
            "Nat.min_self",
            "Refund.min_repeat",
        ]
        if proposal
        else []
    )
    (HERE / "candidates").mkdir(exist_ok=True)
    for label, expression in candidates.items():
        candidate = upstream.replace(SITE.encode(), ("let refund_amount = " + expression + ";").encode())
        if label == "repair":
            # Upstream's own two lines: the repaired file is upstream's file at the parent commit.
            candidate = candidate.replace(TEMP_NOTE.encode(), MAIN_NOTE.encode())
            if sha(candidate) != PARENT_FILE_SHA:
                raise ValueError("the repair is not upstream's file at the parent commit")
        rust, ast = bind_candidate(upstream, candidate)
        digest = sha(candidate)
        ns = "C_" + digest
        claim, counter = f"Refund.{ns}.Correct", f"Refund.{ns}.Refute"
        generated += [
            f"namespace {ns}\n",
            f'def sourceDigest : String := "{digest}"\n',
            f"def expression : Expr := {lean_expr(ast)}\n",
            "def Correct : Prop := meetsRule expression\n",
            "def Refute : Prop := ¬ Correct\n",
            f"end {ns}\n",
        ]
        witness = None
        # First the request the recorded run sends: 100 asked back on a deposit of 1, by a receiver that then holds 1001.
        grid = [(100, 1, 1001)] + [
            (r, d, b) for r in [1, 2, 100, MAX, 0] for d in [1, 2, 100, MAX, 0] for b in [1, 2, 100, MAX, 0]
        ]
        for request, deposit, balance in grid:
            args = dict(requested_refund=request, deposited=deposit, balance_left=balance)
            got = eval_expr(ast, args)
            want = min(request, deposit, balance)
            if got != want and witness is None:
                broken = [
                    text
                    for ok, text in [
                        (got <= request, "more than was requested"),
                        (got <= deposit, "more than was deposited"),
                        (got <= balance, "more than the receiver holds"),
                        (got in (request, deposit, balance), "less than the rule allows"),
                    ]
                    if not ok
                ]
                witness = dict(**args, actual=got, expected=want, breaks=broken[0])
        external = bool(proposal and proposal.get("external_proof") and label == "user_patch")
        if external:
            positive = proposal.get("proof_side", "proof") == "proof"
            proof = f"{ns}.Correct" if positive else f"{ns}.Refute"
            proofs += [f"theorem {label} : {proof} := Solution.proof\n"]
        elif witness:
            r, d, b = [witness[k] for k in ("requested_refund", "deposited", "balance_left")]
            proof = f"{ns}.Refute"
            proofs += [
                f"theorem {label} : {proof} := by\n  intro h\n  have valid : InRange ⟨{r}, {d}, {b}⟩ := by unfold InRange; decide\n  have bad : Rule ⟨{r}, {d}, {b}⟩ (eval ⟨{r}, {d}, {b}⟩ {ns}.expression) := h ⟨{r}, {d}, {b}⟩ valid\n  revert bad\n  unfold Rule\n  decide\n"
            ]
        else:
            proof = f"{ns}.Correct"
            canonical = Parser("requested_refund.min(*deposited).min(balance_left)").parse()
            body = (
                "    rfl\n"
                if ast == canonical
                else (
                    "    have hr := Nat.min_eq_left h.1\n"
                    "    have hd := Nat.min_eq_left h.2.1\n"
                    "    have hb := Nat.min_eq_left h.2.2\n"
                    "    have hmr := Nat.min_eq_right h.1\n"
                    "    have hmd := Nat.min_eq_right h.2.1\n"
                    "    have hmb := Nat.min_eq_right h.2.2\n"
                    "    have all_le : min a.requested (min a.deposited a.balance) ≤ maxU128 := Nat.le_trans (Nat.min_le_left _ _) h.1\n"
                    "    have h_all := Nat.min_eq_left all_le\n"
                    "    have h_max := Nat.min_eq_right all_le\n"
                    f"    simp only [{ns}.expression, eval, Nat.min_assoc, Nat.min_comm, Nat.min_left_comm, Nat.min_self, min_repeat, hr, hd, hb, hmr, hmd, hmb, h_all, h_max]\n"
                )
            )
            # First: this expression computes the smallest of the three amounts. Then: the smallest of three meets the rule.
            proofs += [
                f"theorem {label} : {proof} := by\n  intro a h\n"
                f"  have e : eval a {ns}.expression = min (min a.requested a.deposited) a.balance := by\n"
                + body
                + "  unfold Rule\n  rw [e]\n"
                "  refine ⟨Nat.le_trans (min_le_first _ _) (min_le_first _ _), Nat.le_trans (min_le_first _ _) (min_le_second _ _), min_le_second _ _, ?_⟩\n"
                "  cases Nat.le_total (min a.requested a.deposited) a.balance with\n"
                "  | inl h1 =>\n"
                "    rw [Nat.min_eq_left h1]\n"
                "    cases Nat.le_total a.requested a.deposited with\n"
                "    | inl h2 => exact Or.inl (Nat.min_eq_left h2)\n"
                "    | inr h2 => exact Or.inr (Or.inl (min_right h2))\n"
                "  | inr h1 => exact Or.inr (Or.inr (min_right h1))\n"
            ]
        roots += [f"Refund.{ns}.sourceDigest", claim, counter]
        (HERE / "candidates" / (label + ".rs")).write_bytes(candidate)
        records.append(
            dict(
                label=label,
                source_sha256=digest,
                expression=rust,
                ast=ast,
                **(
                    {
                        "identical_to_upstream": dict(
                            revision=PARENT_REVISION, file="contracts/defuse/src/contract/tokens/mod.rs"
                        )
                    }
                    if label == "repair"
                    else {}
                ),
                claim=claim,
                counter_claim=counter,
                proof=f"Refund.{label}",
                proved=(claim if proposal.get("proof_side", "proof") == "proof" else counter)
                if external
                else (counter if witness else claim),
                counterexample=witness,
            )
        )
    # The log budget (LogBudget.lean, a static file that imports the generated one): the refund event of an
    # expression that meets the rule is not longer than the deposit event; the old expression's can be.
    roots += ["Refund.refund_event_fits", "Refund.old_refund_event_can_outgrow"]
    generated += ["end Refund\n"]
    proofs += ["end Refund\n"]
    (HERE / "RefundCase.lean").write_text("".join(generated))
    (HERE / "RefundProofs.lean").write_text("".join(proofs))
    (HERE / "base_roots.txt").write_text("\n".join(roots) + "\n")
    (HERE / "candidates.json").write_text(
        json.dumps(
            dict(
                upstream_revision="35044fd1795b0de9d1ac269c6aa28a0d6a7efdfa",
                upstream_sha256=sha(upstream),
                candidates=records,
            ),
            indent=2,
        )
        + "\n"
    )
    print(f"Bound {len(records)} candidates to one unchanged upstream context")


if __name__ == "__main__":
    main()
