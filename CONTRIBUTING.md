# Contributing

Issues and pull requests are welcome. This page gives the setup, the commands to run before you send a change,
and the rules that keep the checks meaningful.

## Set up

| For | You need |
|---|---|
| The checks of every record and of the testnet deployment | Python 3 |
| Anything that runs contracts on a local NEAR node | Node 20.15 or newer; `npm ci` |
| A rebuild of contracts and proofs from source | Rust 1.98.0 with `wasm32-unknown-unknown`, cargo-near 0.22.0, Lean 4.35.0 (through elan) |

On Linux, if the host lacks a toolchain and Docker is present, `./verify.sh` runs the mode in the pinned
container of [Dockerfile](Dockerfile). `./verify.sh --run <command>` runs any command of the repository there.

## Before you send a change

```sh
./verify.sh              # the offline checks, then read-only checks of the testnet deployment: about a minute
npm test                 # unit tests of the page's evidence readers
./verify.sh --rehearse   # the refund case as real transactions on a fresh local node: about 4 minutes
npx prettier@3.6.2 --write . && uvx ruff@0.14.4 format .   # formatting of the scripts and the page
```

A change to a contract, a proof or a build script also needs `./verify.sh --lean` and `./verify.sh --refund`.
A change to the wallet case needs `./verify.sh --wallet` and `./verify.sh --faults`. [AGENTS.md](AGENTS.md)
lists every mode with its time and the last line of a run that passes.

## Rules that keep the checks meaningful

- **Contract sources decide the bytes of a binary.** The binaries in `artifacts/` are the ones deployed on
  testnet, and they rebuild from source to the same bytes. A change under `contracts/`, even a change of
  formatting, gives other bytes. For that reason the formatters skip that directory (`.prettierignore`, `ruff.toml`). A
  change to the build path (`cases/intents-refund/build.py`, `tools/near_build.sh`, `tools/rustc_stable_metadata.sh`)
  can do the same. Send such a change only if it is the point of the pull request, and say so.
- **A run writes each record. Do not edit one by hand.** Files under `evidence/`, `deploy/testnet*.json` and `artifacts/`
  come from the commands that [evidence/README.md](evidence/README.md) names. To change a record, change the code and run the command again.
- **No transaction leaves for a public network without `--send`.** A new script that can sign or deploy prints
  its plan by default and acts only with that flag.
- **A statement in the README has a command behind it.** If you add a claim, add its row to the
  [AGENTS.md](AGENTS.md) table: the command and the line to look for.
- **Say what we trust.** If a change adds an assumption, add it to "Trusted, not proved" in the README and to
  [docs/TECHNICAL.md](docs/TECHNICAL.md). An assumption can be a tool, a translation step or a registered pairing.

## Try a patch of your own

```sh
python3 cases/intents-refund/propose.py --candidate your-tokens.rs --out run-output/my-patch
```

Run `./verify.sh --refund` one time first. Copy `cases/intents-refund/upstream/tokens.rs`. Change only the refund
expression in the copy. Then run the command with your file.

The command derives the claim for your file and finds a proof or a counterexample. Then it builds the contract
and runs the bounty and the upgrade on a fresh local node.
[docs/TECHNICAL.md](docs/TECHNICAL.md#your-own-patch) has more.

## Commits

Make one change in one commit. The subject says what is now true, for example "The gate refuses a binary that
differs in one bit". It does not say what you did to the files. A commit that you wrote with an AI agent keeps
the co-author line of that agent.

## Security

Do not open a public issue for these two kinds of report. Send them as [SECURITY.md](SECURITY.md) says:

- A way to make the proof checker accept a false statement.
- A way to make the board or the gate act without a certificate.
