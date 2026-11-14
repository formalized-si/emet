# Security

Emet is a hackathon project. It runs on NEAR testnet and on local nodes, and it holds no funds of value. No
outside party audited it. Do not use it to guard anything real.

## Reporting

Use GitHub's private reporting for this repository: **Security → Report a vulnerability**. Do not open a public
issue for a report in scope until we fix it or 30 days pass.

A useful report has three parts:

- The input: a proof file, a transaction or a call.
- The command that shows the effect on a local node. `./verify.sh --serve` gives a proof checker to send to.
- The result that you expected instead.

## In scope

- **The proof checker accepts something false.** `contracts/kernel` accepts a proof file for a statement that does
  not hold. That includes a proof of `False`, a statement other than the claimed one, a smuggled axiom, and a
  redefined declaration of the sealed environment.
- **The board pays or records a certificate without an accepted proof**, pays twice, or lets a copied proof win.
- **The gate installs a binary** without a certificate for that candidate's claim, installs a binary other than
  the registered one, or installs more than once.
- **A key or a role that the README says nobody has**: any way to change the code or the state of the deployed
  contracts.

A bounty of 1 testnet NEAR for a proof of `False` stands on the testnet board. Testnet NEAR has no value. The
bounty makes a break visible on the chain. It does not pay for one.

## Known limits, not vulnerabilities

The README and [docs/TECHNICAL.md](docs/TECHNICAL.md) state these limits:

- We sample the extractor's reading of a Rust expression against rustc. We do not prove it.
- The deployer of a gate chooses the rule, the candidates and the pairing of source and binary.
- We trust or test the Rust compiler, nanoda, the code of the board and of the gate, and NEAR. We do not prove
  them.
- Nobody can patch a contract with no access key in place. A fix is a new deployment.

## History

On 11 November 2026 the pinned version of the type checker, nanoda_lib 0.4.31, accepted two forged proofs of
`False`. The Lean Kernel Arena published them the day before. We updated it to 0.4.32 the same day, and both
proofs are regression tests ([contracts/kernel/PATCHES.md](contracts/kernel/PATCHES.md)).

On 13 November 2026 a review found a second way to prove `False`: a proof file could declare a name that the
checker computes by itself (`Nat.gcd` and five more, and in the wallet's environment also `Nat.div`, `String` and
`Char.ofNat`), which the sealed environment did not declare. Our first live deployment, `kernel.v1.emet.testnet`,
had this hole; it has no access key, so it cannot be corrected. We claimed the bounty for a proof of `False` on
its board, which recorded the checker broken on chain, and redeployed the fixed checker as `v2`. The fix refuses a
delta that declares any of the 31 names the checker computes by itself, every sealed environment now declares
them, and the two proofs are regression tests. The cause was ours: nanoda documents that its nat and string
literal extensions are trusted as axioms ([ammkrn/nanoda_lib#68](https://github.com/ammkrn/nanoda_lib/issues/68)),
and we sealed environments that left those names for a stranger to define.
