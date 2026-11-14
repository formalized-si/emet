# Records of runs

A command of this repository wrote every record here. `./verify.sh --offline` checks most of them against the
binaries, proofs and sources of the checkout. `./verify.sh --nearai` checks `nearai/` and `nearai-refund/`, and
`tools/check_arena.sh` checks `lean-kernel-arena/`. No command checks `shelf-measurements/`, the record of a
rejected experiment. To change a record, change the code and run its command again.

| Directory | Contents | Written by |
|---|---|---|
| `refund/` | The refund case on a local node: the old and the fixed NEAR Intents builds, the bounty, the upgrade | `./verify.sh --refund` |
| `proposals/` | Three runs with patches of other shapes: two proved and installed, one refuted | `cases/intents-refund/propose.py`, packed by `tools/package_proposal.py` |
| `refund-translation/` | A sample of the extractor against rustc: 45 expressions, 2,700 inputs | `evidence/refund-translation/check_translation.py` |
| `nearai-testnet/` | A model's counterexample, paid on testnet ([README](nearai-testnet/README.md)) | `agent/solve.py --backend nearai`, then `agent/courier.cjs` |
| `nearai-refund/` | Open-weight models propose a patch and prove it, on a local node ([FACTS](nearai-refund/FACTS.md)) | `agent/nearai_patch.py` |
| `nearai/` | Open-weight models on the wallet's bounties ([SUMMARY](nearai/SUMMARY.md)) | `agent/solve.py --backend nearai`, `agent/nearai_record.py` |
| `nearspec/` | NEAR Proof Arena's transfer relation and two of its theorems, on a local node | `tools/measure_nearspec.sh` |
| `demo/` | The wallet scenario and its failure paths, and one run in which an agent wrote its proof during the run | `./verify.sh --wallet`, `./verify.sh --faults` |
| `agent/` | The proofs that Claude models wrote for the wallet's bounties, with their sessions ([README](agent/README.md)) | `agent/solve.py` |
| `hostile/` | 96 invalid proofs sent through the proof checker | `./verify.sh --hostile` |
| `lean-kernel-arena/` | The Lean Kernel Arena's fixtures against a native build of this proof checker | `tools/check_arena.sh` |
| `shelf-measurements/` | Earlier measurements of environment sizes and gas | `tools/measure-shelf.cjs` |

The records of the public deployment are beside the scripts that made them: `deploy/testnet.json` and
`deploy/testnet-arena.json`.
