# Changes to nanoda_lib in this kernel

`vendor/nanoda_lib/` is upstream [nanoda_lib](https://github.com/ammkrn/nanoda_lib) 0.4.32 at commit
`0da9f98feadd3a0a2ef4b3dbcf52a298a6fef929` plus **`vendor/nanoda_lib.PATCH.diff`**. That file is the complete diff
of `src/`: upstream with the diff applied is the vendored `src/`, with no difference. We did not vendor upstream's CI
files and test resources. The diff changes three files. All three are inside the trusted base of Emet.

| File | Change | Reason | Effect on soundness |
|---|---|---|---|
| `src/inductive.rs` (+5) | during the type check of a mutual inductive block, set `declar_info`, so that the checker enforces the declared-universe premise as for ordinary declarations | upstream 0.4.31 accepted the Lean Kernel Arena fixture `inductive-undeclared-universe` (a declaration that uses a universe that it does not declare) | strengthens: refuses a known wrong-accept of 0.4.31. Upstream 0.4.32 has its own check for it, as the next section says |
| `src/parser.rs` (+73) | a fast path, `canonical_app`, that decodes `{"ie":N,"app":{"fn":A,"arg":B}}` lines in the one form that lean4export writes. Any other line goes to the serde parser. Unit tests compare both parsers on a corpus and on adversarial encodings | the parse of the sealed environment takes most of the gas of each check | neutral if correct: it must produce the same object as serde. It accepts one exact byte pattern only |
| `src/util.rs` (+190) | helpers that the contract calls. `claim_proof` finds the delta theorem whose type is one `Prop` constant of the sealed environment and nothing more. `analyze` lists the new declarations, the constants that a statement mentions and the axioms used. The others are `pp_declar_to_string`, `declaration_name_indices` and `find_declar_by_str` | claim matching and the board's verdict fields | trusted: `claim_proof` decides which theorem counts as a proof of the claim, and `declaration_name_indices` feeds the pre-parse redefinition scan |

The patch does not touch the Lean type checker itself (`tc.rs`, `expr.rs`, `level.rs`, `env.rs`, `quot.rs`).

## Upstream version

Until 2026-11-11 the kernel was nanoda_lib 0.4.31 (`8de7e0c4ed3052745a7f8725164efd9e76d84c56`). That version accepts two
proofs of `False` that the Lean Kernel Arena published on 2026-11-10: `bugs/rec-rule-proof-irrel` and
`bugs/rec-rule-proof-irrel-nested`. Each proof replaces one rule of a recursor by an ill-typed proof. The kernel compared
the exported rule with the rule that it derives, up to definitional equality. It did not type-check the exported rule
first, so proof irrelevance hid the forgery.

Upstream 0.4.32 is commit `3a3b9bb`, merged as `0da9f98` with the same tree. It type-checks every exported recursor
rule and hardens the quotient declarations. It adds its own check that a declaration uses only the universe parameters
that it declares. The patch above applies to 0.4.32 unchanged, hunk for hunk. Upstream's new universe check also refuses
`inductive-undeclared-universe` on its own. We kept our `inductive.rs` lines, which now overlap with that check.

The regression checks are:

- `cargo test --release` here: the contract's `run_check` on the sealed environment, with the two forged proofs as
  deltas (`cheats/deltas/forgedRec*.delta.ndjson`)
- `tools/check_arena.sh`
- check F7 of `demo/faults.cjs` on a local node
