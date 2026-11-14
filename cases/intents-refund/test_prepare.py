"""Refuse source substitution and unsupported Rust; cross-check emitted terms against rustc."""

import itertools
import json
from pathlib import Path
import random
import shutil
import subprocess
import tempfile
import unittest

import prepare


class SourceBinding(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = (prepare.HERE / "upstream/tokens.rs").read_bytes()

    def test_changes_outside_expression_are_refused(self):
        for before, after in [
            (b"*deposited = refund_amount;", b"*deposited = 0;"),
            (b"&'a mut u128", b"&'a mut u64"),
            (b"let balance_left =", b"let balance_left2 ="),
        ]:
            self.assertIn(before, self.upstream)
            with self.assertRaises(ValueError):
                prepare.bind_candidate(self.upstream, self.upstream.replace(before, after))

    def test_comment_above_the_expression_may_only_be_one_of_upstreams_two(self):
        fixed = self.upstream.replace(
            prepare.SITE.encode(), b"let refund_amount = requested_refund.min(*deposited).min(balance_left);"
        )
        own = fixed.replace(prepare.TEMP_NOTE.encode(), prepare.MAIN_NOTE.encode())
        self.assertEqual(prepare.sha(own), prepare.PARENT_FILE_SHA)  # upstream's file at the parent commit
        self.assertEqual(prepare.bind_candidate(self.upstream, own)[0], prepare.bind_candidate(self.upstream, fixed)[0])
        with self.assertRaises(ValueError):
            prepare.bind_candidate(self.upstream, fixed.replace(prepare.TEMP_NOTE.encode(), b"// refunds are fine"))

    def test_changed_reference_source_is_refused(self):
        with self.assertRaises(ValueError):
            prepare.bind_candidate(self.upstream + b"\n", self.upstream + b"\n")

    def test_unrecognized_rust_is_refused(self):
        expressions = [
            "requested_refund.max(*deposited)",
            "requested_refund as u64",
            "evil(requested_refund)",
            "deposited",
            "*balance_left",
            "*deposited.min(balance_left)",
            "requested_refund.min(*deposited); panic!()",
            str(2**128),
            "1 0",
            "(requested_refund",
        ]
        for expression in expressions:
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                prepare.Parser(expression).parse()

    def test_zero_refund_does_not_satisfy_exactness(self):
        ast = prepare.Parser("0u128").parse()
        a = dict(requested_refund=5, deposited=7, balance_left=8)
        self.assertLessEqual(prepare.eval_expr(ast, a), min(a.values()))
        self.assertNotEqual(prepare.eval_expr(ast, a), min(a.values()))

    def test_lean_rule_is_bounded_to_u128_and_has_one_answer(self):
        source = """import RefundCase
open Refund
example : ¬ InRange ⟨maxU128 + 1, maxU128 + 1, maxU128 + 1⟩ := by
  unfold InRange maxU128
  decide
-- A patch with an extra u128::MAX bound meets the rule only because the inputs are u128 values.
example : meetsRule (.least (.least (.least .requested .deposited) .balance) (.literal maxU128)) := by
  intro a h
  have e : eval a (.least (.least (.least .requested .deposited) .balance) (.literal maxU128)) = min (min a.requested a.deposited) a.balance := by
    change min (min (min a.requested a.deposited) a.balance) maxU128 = _
    apply Nat.min_eq_left
    exact Nat.le_trans (Nat.min_le_left _ _) (Nat.le_trans (Nat.min_le_left _ _) h.1)
  unfold Rule
  rw [e]
  refine ⟨Nat.le_trans (min_le_first _ _) (min_le_first _ _), Nat.le_trans (min_le_first _ _) (min_le_second _ _), min_le_second _ _, ?_⟩
  cases Nat.le_total (min a.requested a.deposited) a.balance with
  | inl h1 =>
    rw [Nat.min_eq_left h1]
    cases Nat.le_total a.requested a.deposited with
    | inl h2 => exact Or.inl (Nat.min_eq_left h2)
    | inr h2 => exact Or.inr (Or.inl (min_right h2))
  | inr h1 => exact Or.inr (Or.inr (min_right h1))
-- The four requirements leave exactly one answer: the smallest of the three amounts.
example (a : Args) (r : Nat) : Rule a r ↔ r = min (min a.requested a.deposited) a.balance := by
  unfold Rule
  omega
-- The recorded transaction: 100 asked back on a deposit of 1 with a balance of 1000. Returning 100 breaks the rule, returning 1 meets it.
example : ¬ Rule ⟨100, 1, 1000⟩ 100 := by unfold Rule; decide
example : Rule ⟨100, 1, 1000⟩ 1 := by unfold Rule; decide
"""
        lake = shutil.which("lake") or str(Path.home() / ".elan/bin/lake")
        subprocess.run([lake, "env", "lean", "--stdin"], input=source, text=True, cwd=prepare.HERE, check=True)

    def test_log_budget_model(self):
        import check_log_model as model

        rows = {r["label"]: r for r in json.loads((prepare.HERE / "candidates.json").read_text())["candidates"]}
        old, repair = (
            rows[label]["claim"].removesuffix(".Correct") + ".expression" for label in ("original", "repair")
        )
        # Upstream's own regression batch, and forty tokens with mixed inputs (refunds of zero among them).
        rng = random.Random(20261112)
        amounts = [0, 1, 9, 10, 99, 100, 10**35, 10**37 + 80, 2**128 - 1]
        upstream = [(173, 10**35, 1, 10**37 + 80)] * 80
        mixed = [
            (rng.randrange(300), *(rng.choice(amounts + [rng.randrange(2**128)]) for _ in range(3))) for _ in range(40)
        ]
        self.assertTrue(
            all(model.digits(n) == len(str(n)) for k in range(39) for n in (10**k, 10 ** (k + 1) - 1, 2**128 - 1))
        )
        self.assertEqual(model.burn_bytes(rows["original"]["ast"], upstream) - model.mint_bytes(upstream), 2800)
        same = "".join(  # the Python model that check_log_model.py holds against the recorded logs computes what Lean computes
            f"example : mintBytes {items} = {model.mint_bytes(batch)} ∧ burnBytes {old} {items} = {model.burn_bytes(rows['original']['ast'], batch)}"
            f" ∧ burnBytes {repair} {items} = {model.burn_bytes(rows['repair']['ast'], batch)} := by decide\n"
            for batch in (upstream, mixed)
            for items in ["[" + ", ".join(f"⟨{i}, ⟨{r}, {d}, {b}⟩⟩" for i, r, d, b in batch) + "]"]
        )
        source = f"""import LogBudget
open Refund
example : digits 0 = 1 ∧ digits 9 = 1 ∧ digits 10 = 2 ∧ digits 99 = 2 ∧ digits 100 = 3
    ∧ digits (10 ^ 35) = 36 ∧ digits maxU128 = 39 := by decide
-- At both ends of every decade `digits` is the decimal length, and it is the length of Lean's own decimal string.
-- `digits_mono` covers what lies between, so `digits` is the decimal length of every amount below 10^39.
example : ∀ k < 38, digits (10 ^ (k + 1) - 1) = k + 1 ∧ digits (10 ^ (k + 1)) = k + 2 := by decide
example : ∀ k < 39, (toString (10 ^ k)).length = digits (10 ^ k)
    ∧ (toString (10 ^ (k + 1) - 1)).length = digits (10 ^ (k + 1) - 1) := by native_decide
example : (toString maxU128).length = digits maxU128 := by native_decide
-- Upstream's own batch: 80 tokens with ids of 173 bytes, a deposit of 1 each, 10^35 asked back from a balance of 10^37 + 80.
def batch : List Item := List.replicate 80 ⟨173, ⟨10 ^ 35, 1, 10 ^ 37 + 80⟩⟩
example : burnBytes {old} batch - mintBytes batch = 80 * 35 := by decide
example : burnBytes {repair} batch = mintBytes batch := by decide
{same}#print axioms refund_event_fits
#print axioms old_refund_event_can_outgrow
"""
        lake = shutil.which("lake") or str(Path.home() / ".elan/bin/lake")
        out = subprocess.run(
            [lake, "env", "lean", "--stdin"], input=source, text=True, cwd=prepare.HERE, check=True, capture_output=True
        ).stdout
        self.assertEqual(out.count("does not depend on any axioms"), 2, out)

    def test_sealed_environment_has_the_log_budget_and_no_axiom(self):
        roots = (prepare.HERE / "shelf/base_roots.txt").read_text().split()
        self.assertLessEqual({"Refund.refund_event_fits", "Refund.old_refund_event_can_outgrow"}, set(roots))
        self.assertNotIn(b'"axiom"', (prepare.HERE / "shelf/base.ndjson").read_bytes())

    def test_generated_model_agrees_with_rust_execution(self):
        rows = json.loads((prepare.HERE / "candidates.json").read_text())["candidates"]
        rng = random.Random(20261111)
        edge = [0, 1, 2, 100, 2**64 - 1, 2**64, 2**128 - 2, 2**128 - 1]
        inputs = list(itertools.product(edge, repeat=3))
        inputs += [tuple(rng.randrange(2**128) for _ in range(3)) for _ in range(300)]
        source = """use std::io::{self, BufRead};
fn main() { for line in io::stdin().lock().lines() {
 let line = line.unwrap(); let v:Vec<&str> = line.split_whitespace().collect();
 let requested_refund:u128=v[1].parse().unwrap(); let d:u128=v[2].parse().unwrap();
 let deposited=&d; let balance_left:u128=v[3].parse().unwrap();
 let result:u128=match v[0] {\n"""
        source += "\n".join(f'"{r["label"]}" => {r["expression"]},' for r in rows)
        source += '_=>panic!("bad label")}; println!("{}",result); } }\n'
        with tempfile.TemporaryDirectory(prefix="emet-refund-rust-") as tmp:
            p = Path(tmp)
            (p / "main.rs").write_text(source)
            subprocess.run(
                ["rustc", "+1.98.0", "--edition=2024", str(p / "main.rs"), "-o", str(p / "check")], check=True
            )
            lines = []
            expected = []
            for r in rows:
                for q, d, b in inputs:
                    lines.append(f"{r['label']} {q} {d} {b}")
                    expected.append(prepare.eval_expr(r["ast"], dict(requested_refund=q, deposited=d, balance_left=b)))
            actual = subprocess.run(
                [str(p / "check")], input="\n".join(lines) + "\n", text=True, capture_output=True, check=True
            )
            self.assertEqual(list(map(int, actual.stdout.splitlines())), expected)


if __name__ == "__main__":
    unittest.main()
