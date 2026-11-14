#!/usr/bin/env python3
"""Independent bounded sample check of the restricted extractor against rustc.

This is differential execution evidence, not a proof of translation correctness.
Writes only --out and a temporary Rust program; never edits the supplied repo.
"""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import subprocess
import tempfile
from datetime import datetime, timezone

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--repo", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
prepare = args.repo.resolve() / "cases/intents-refund/prepare.py"
spec = importlib.util.spec_from_file_location("independent_prepare_probe", prepare)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
rng = random.Random(731)
leaves = ["requested_refund", "(*deposited)", "balance_left", "0u128", "1u128", "100u128", str(module.MAX) + "u128"]


def expression(depth):
    if depth == 0 or rng.randrange(3) == 0:
        return rng.choice(leaves)
    return f"({expression(depth - 1)}).min({expression(depth - 1)})"


expressions = [expression(4) for _ in range(45)]
asts = [module.Parser(text).parse() for text in expressions]
source = """use std::io::{self,BufRead};
fn main(){for l in io::stdin().lock().lines(){
let l=l.unwrap();let v:Vec<&str>=l.split_whitespace().collect();
let requested_refund:u128=v[1].parse().unwrap();let d:u128=v[2].parse().unwrap();
let deposited=&d;let balance_left:u128=v[3].parse().unwrap();
let out:u128=match v[0]{"""
source += ",".join(f'"{i}"=>{text}' for i, text in enumerate(expressions))
source += ',_=>panic!()};println!("{}",out);}}'
edge = [0, 1, 2, 99, 100, module.MAX - 1, module.MAX]
inputs = [
    tuple(rng.choice(edge) if rng.randrange(2) else rng.randrange(module.MAX + 1) for _ in range(3)) for _ in range(60)
]
lines, expected = [], []
for i, ast in enumerate(asts):
    for requested, deposited, balance in inputs:
        lines.append(f"{i} {requested} {deposited} {balance}")
        expected.append(
            module.eval_expr(ast, {"requested_refund": requested, "deposited": deposited, "balance_left": balance})
        )
compiler = subprocess.run(["rustc", "+1.98.0", "--version"], text=True, capture_output=True, check=True).stdout.strip()
with tempfile.TemporaryDirectory(prefix="emet-extractor-review-") as temporary:
    directory = Path(temporary)
    (directory / "probe.rs").write_text(source)
    subprocess.run(
        ["rustc", "+1.98.0", "--edition=2024", str(directory / "probe.rs"), "-o", str(directory / "probe")],
        text=True,
        capture_output=True,
        check=True,
    )
    run = subprocess.run(
        [str(directory / "probe")], input="\n".join(lines) + "\n", text=True, capture_output=True, check=True
    )
    actual = list(map(int, run.stdout.splitlines()))
if len(actual) != len(expected):
    raise RuntimeError("Rust output count differs from expected count")
mismatches = [
    {"expression_index": i // len(inputs), "input_index": i % len(inputs), "rust": str(got), "extractor": str(want)}
    for i, (got, want) in enumerate(zip(actual, expected))
    if got != want
]
result = {
    "at": datetime.now(timezone.utc).isoformat(),
    "scope": "Differential execution samples only; no proof of translation correctness",
    "seed": 731,
    "compiler": compiler,
    "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "extractor_sha256": hashlib.sha256(prepare.read_bytes()).hexdigest(),
    "arbitrary_expressions": len(expressions),
    "bounded_cases": len(actual),
    "mismatch_count": len(mismatches),
    "mismatches": mismatches,
    "expressions": expressions,
    "inputs_requested_deposited_balance": [[str(value) for value in row] for row in inputs],
    "expected_sha256": hashlib.sha256(("\n".join(map(str, expected)) + "\n").encode()).hexdigest(),
    "actual_sha256": hashlib.sha256(("\n".join(map(str, actual)) + "\n").encode()).hexdigest(),
}
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_text(json.dumps(result, indent=2) + "\n")
print(
    json.dumps(
        {
            key: result[key]
            for key in ["arbitrary_expressions", "bounded_cases", "mismatch_count", "compiler", "extractor_sha256"]
        }
    )
)
raise SystemExit(1 if mismatches else 0)
