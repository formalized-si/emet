# Checking this repository

This file is for automated reviewers and coding agents. It makes no claim of its own. It lists each check, the tools that the check needs, the time that it takes and the output to expect. The claims are in [README.md](README.md). The trust boundaries are in [docs/TECHNICAL.md](docs/TECHNICAL.md).

## Start here

```sh
./verify.sh
```

The command needs Python 3 and nothing else, and takes about a minute. It runs the offline checks of every recorded run. Then it asks the deployment on NEAR testnet with read-only RPC calls. A run that passes has no `FAIL` line. It prints `all checks passed: 35 read-only RPC calls, …` and `Done: the offline checks and the read-only checks of the testnet deployment passed.`, and then lists the other modes.

Then, with Node 20.15 or newer, run `./verify.sh --rehearse`. It runs the main story as real transactions on a fresh local NEAR node in about 4 minutes. It ends with `18/18 checks passed.`

## Where things are

| Path | Contents |
|---|---|
| `contracts/kernel`, `contracts/board`, `contracts/patch-gate` | The proof checker, the bounty board and the upgrade gate (Rust). `contracts/kernel/vendor/nanoda_lib` is the third-party type checker with our patch beside it |
| `cases/intents-refund` | The NEAR Intents case: the rule in Lean, the extractor, the builder of the two upstream commits, the proofs, the sealed environment |
| `deploy/live-refund.cjs`, `deploy/testnet.json` | The script that ran the story on testnet, and its record of 52 transactions |
| `cases/near-proof-arena`, `deploy/live-arena.cjs`, `deploy/testnet-arena.json` | NEAR Proof Arena's transfer relation under the same checker: two propositions, the script that sealed them on testnet, its record |
| `tools/check_live.py` | The read-only check of the deployment |
| `demo/web` | The page; `index.html` at the root redirects to it |
| `agent` | The courier that claims a bounty, and the prover loops for Claude Code and for NEAR AI Cloud models |
| `evidence` | Records of earlier runs. `./verify.sh --offline` checks most of them, and [evidence/README.md](evidence/README.md) names the check for the rest |
| `contracts/wallet`, `contracts/factory`, `lean/Policy`, `demo/scenario.cjs` | The agent wallet case |
| `artifacts` | The built binaries, with `SHA256SUMS` |

## What to run

| Command | Needs | Time | Network | A run that passes ends with |
|---|---|---|---|---|
| `./verify.sh` | Python 3 | about 1 min | read-only RPC calls to NEAR testnet | `all checks passed: 35 read-only RPC calls, …`, `Done: the offline checks and the read-only checks of the testnet deployment passed. …`, then the list of the other modes |
| `./verify.sh --offline` | Python 3 | 2 s | none | `Done.` and no `FAIL` line |
| `./verify.sh --live` | Python 3 | about 1 min | read-only RPC calls to NEAR testnet | `all checks passed: 35 read-only RPC calls, …` |
| `python3 tools/check_live.py --tx` | Python 3 | 2 min | the same, and an archival node for older transactions | `all checks passed: … read-only RPC calls, …` (90 at first, and more after the first node drops the transactions and the script asks the archival node) |
| `./verify.sh --rehearse` | Node 20+ | about 4 min | npm packages and the near-sandbox binary, once | `18/18 checks passed. Record: run-output/live-refund-sandbox.json` |
| `./verify.sh --serve` | Node 20+ | ready in under a minute, then serves | the same downloads | `Ready: source-bound refund checker …` |
| `./verify.sh --refund` | Rust 1.98.0 with wasm32, cargo-near 0.22.0, Lean 4.35.0, Python 3.12+, git | 4 to 6 min | crates, the two pinned commits | `PASS refund evidence: …` (it writes `evidence/refund/` again) |
| `./verify.sh --wallet` | Node 20+ | about 11 min | as `--rehearse` | `19/19 claims PASS. …` |
| `./verify.sh --faults` | Node 20+ | about 11 min | as `--rehearse` | `12/12 failure-path checks PASS. …` |
| `./verify.sh --hostile` | Node 20+ | about 5 min | as `--rehearse` | `98 bad inputs in 174 checks: 0 admitted (…). Controls: 27/27 accepted. …` |
| `./verify.sh --nearai` | cargo; Lean 4.35.0 and lean4export if present | 2 to 6 min | crates, once | `4 accepted refund attempt(s) of a NEAR AI Cloud model re-checked …` |
| `./verify.sh --lean` | the toolchains above | 2 to 5 min | toolchain downloads, once | `ok … byte for byte` for kernel, board, factory and the gate on every host; for the two wallet binaries on macOS arm64 only |
| `bash tools/measure_nearspec.sh` | Lean 4.35.0, cargo, Node 20+, git | about 2 min | clones NEAR Proof Arena | three `check …` lines: two `true`, one refused with `statement_mismatch` |
| `tools/check_arena.sh` | Lean 4.35.0, cargo, git | about 1 min | clones the Lean Kernel Arena, once | `26 fixtures; 0 of the 19 expected-reject fixtures accepted` |

`./verify.sh --wallet` and `--faults` take about eleven minutes each. Each sends about a hundred transactions and waits until each transaction is final. If one command has a ten-minute limit, run these modes in the background. Every mode that starts a local node removes the directory of that node under `.runtime/` when the mode ends. `EMET_KEEP_RUNTIME=1` keeps the directory.

On Linux a host sometimes cannot run a mode: a toolchain is missing, or the C library is older than the local NEAR node needs. If Docker is available, the mode then runs itself again in a pinned container. If Docker is not available and only the C library is too old, the mode starts the node with Debian 13's C library (`tools/newer_glibc.py`). In any other case the mode stops within a second and names what is missing. `EMET_DOCKER=1` forces the container. `./verify.sh --run <command>` runs any command of this repository in the container.

**Scripts that can send a transaction to a public network.** No mode of `./verify.sh` sends one. `deploy/live-refund.cjs` and `deploy/live-arena.cjs` send only if you give them `--send`. `agent/claim.cjs` and `agent/courier.cjs` exist to claim a bounty with the account and the key that you give them. Two older scripts have no `--send` switch. They send if you run them by hand with your own key: `demo/hostile.cjs`, if `HOSTILE_NETWORK` names another network, and `contracts/wallet/lean-near/lean-near deploy`.

**The explorer.** `testnet.nearblocks.io` answers automated clients with a challenge page (HTTP 403). Use `python3 tools/check_live.py --tx`, which fetches every recorded transaction from an RPC node, or `https://api-testnet.nearblocks.io/v3/txns/<hash>`.

## Which command checks which statement

| Statement in the README | Checked by | Look for |
|---|---|---|
| The code on testnet is the code in this repository | `--live` | `PASS  kernel.v2.emet.testnet runs artifacts/kernel.wasm (…)` and the same for board, gate, the upgraded contract, receiver and ledger |
| Five contracts have no access key | `--live`; `--rehearse` on a local node | `PASS  … has no access key`, five lines |
| Only the gate can upgrade the contract, and only the guardian can pause it | `--live`; `--rehearse` | `PASS  on the upgraded contract only the gate may upgrade, only the guardian may pause, and nobody holds any other role` |
| The gate installed the fix on a proof certificate | `--live` | `PASS  the gate applied the repair, to this contract, on this board's certificate`; `PASS  bounty 1: the repair was proved, paid, and the certificate is for the proof file in this repository` |
| The checker accepts the five proofs and refuses wrong ones | `--live` (testnet); `--serve` then `node tools/check_patch_preview.cjs` (local) | `--live`: `PASS  kernel accepts …` five times, `PASS  kernel refuses …` four times. Local: `PASS original refuted` … `PASS repair proved` |
| The 52 transactions happened as recorded | `python3 tools/check_live.py --tx` | one `PASS  …: transaction … as recorded` line for each, and two `PASS  …: every receipt, log and outcome of it is as kept in deploy/testnet-batches.json.gz` |
| On the old code 80 transfers leave 80 credits without backing; after the upgrade the same transfers add none | `--live` (the state now); `--rehearse`, `--refund` (again, on a local node) | `PASS  the ledger and the contract still disagree by the 80 credits the old code left, and by nothing more`; on a local node `PASS Through a real token contract, the old code ends that batch with 80 credits that no token backs` and `PASS After the upgrade the same batch completes and adds no unbacked credit` |
| Without a proof the gate installs nothing; the gate refuses a binary that differs in one bit | `--rehearse`, `--refund`; `--tx` for the testnet transactions | `PASS Without a proof the gate installs nothing`; `PASS A binary that differs in one bit is refused by its hash` |
| A guardian can pause deposits and cannot change the code | `--rehearse` | `PASS The guardian pauses deposits in one transaction, and a deposit is then refused` |
| A bounty for a proof of `False` stands on the board | `--live`; `--rehearse` | `PASS  a bounty of 1 NEAR for a proof of False is open on the board, unclaimed` |
| The testnet board paid a bounty for a counterexample that an open-weight model wrote | `--live`: the chain, with the paid account and the bytes<br>`--nearai`: the signatures on the model's 29 responses, and the proof<br>`--offline`: the record against the files | `PASS  bounty 3 was paid to courier.emet.testnet for a counterexample to …; the certificate is for the proof file that deepseek-ai/DeepSeek-V4.1-Flash-1017 wrote`; `== Testnet: … wrote the counterexample that bounty 3 paid for` followed by `ok` lines; `PASS model claim record: …` |
| We left bounties open on the testnet board | `--live` | `PASS  the 3 bounties left open are on the board, each about a patch of this repository's catalog`, then one line for each: `open`, or `paid to <account>` |
| An account that is not ours can claim an open bounty with one command | `--rehearse` (on a local node, with an account outside the deployment) | `PASS A separate account claimed an open bounty with the documented command and was paid` |
| On a local node, four of five attempts by open-weight models ended with a proof that the proof checker accepted. The gate installed the contract that we built from the model's source | `--nearai`: signatures, proofs and the recorded local job, with no API call<br>`python3 -I agent/nearai_patch.py jobs`: the jobs again on a local node | `4 accepted refund attempt(s) of a NEAR AI Cloud model re-checked` |
| The patched source tree is the NEAR Intents team's own parent commit, file for file | `--refund` (`cases/intents-refund/build.py`) | `build.json` records `source_tree_is_upstream_revision` |
| The sealed environment holds no axiom and no proof of the five uses one | `grep -c '"axiom"' cases/intents-refund/shelf/base.ndjson` prints 0; `--live` | `PASS  the kernel sealed this repository's environment and type-checked all 534 declarations` |
| The four requirements leave one answer and no other | `python3 cases/intents-refund/test_prepare.py` (needs Lean) | `OK` |
| The model of the log length gives the length testnet refused, to the byte | `--offline` | `PASS testnet, old code, 80 token(s) … refund event 17519 (refused by the node) …`; `PASS the model gives the length of every recorded mint and refund event` |
| The Rust-built binaries rebuild to the same bytes on macOS arm64 and Linux x86_64 | `./verify.sh --lean`, or `./verify.sh --run tools/build_wasm.sh` | `ok   kernel.wasm rebuilt from source, byte for byte` and the same for board, factory and the gate |
| The wallet: 11 NEAR went through a limit of 6, and the board paid for a counterexample. The same transaction froze the wallet, and an agent proved the corrected policy | `--wallet` (again, on a local node); `--offline` (the record) | `19/19 claims PASS.`; offline: `ok   in the recorded run the transaction that paid the refutation froze the wallet: …` |
| The checker refuses 98 invalid proofs and accepts all 18 valid controls (27 checks) | `--hostile` (again, on a local node); `--offline` (the record) | `98 bad inputs in 174 checks: 0 admitted (…). Controls: 27/27 accepted.`; offline: `PASS  none of the 98 bad inputs was admitted` |
| A proof checker on testnet sealed NEAR Proof Arena's transfer relation and accepted the Arena's own proofs of two theorems about it | `--live`: the state of the contract now<br>`python3 tools/check_live.py --tx`: the three transactions and the proof bytes that they carried<br>`bash tools/measure_nearspec.sh`: the run again, on a local node<br>`--offline`: the local record | `PASS  it sealed the environment exported from NEAR Proof Arena's specification and type-checked all 1600 declarations`; `PASS  NearRelation.outputs_unique: transaction … sent the proof file of this repository under …, and the contract accepted it`; `ok   it accepted the Arena's own proofs of two theorems about its relation, each in one call, as the proof files kept here` |

## What is recorded and what is run again

With no option the script runs `--offline`, then `--live`. `--offline` reads records of earlier runs: `evidence/`, `deploy/testnet.json` and `deploy/testnet-arena.json`. It checks their hashes and their consistency with the binaries, proofs and sources in this checkout. It executes no contract.

The other modes execute. Six modes run contracts on a fresh local NEAR node: `--rehearse`, `--serve`, `--refund`, `--wallet`, `--faults` and `--hostile`. `--live` asks the public deployment. `--lean` and `--nearai` rebuild and check on this machine, with no node.

## What no command here establishes

- That the extractor reads the Rust expression as the compiler does. We sampled the extractor against rustc and did not prove it.
- That the Rust compiler, the proof checker (nanoda), the board, the gate or NEAR are correct. We trust or test them.
- That a model found anything about NEAR Intents, or acted on a chain by itself. We gave the models the claim or the rule. A script of this project signed every transaction. `evidence/nearai-refund/FACTS.md` and `evidence/nearai-testnet/README.md` list what those records do not show.
- Anything about NEAR Intents beyond the one refund expression. Its team found and fixed that issue. This project found nothing new.
- Anything about nearcore. We use NEAR Proof Arena's specification as it is, as a statement to check proofs against.
