# Narration

The video has no voice. To add one, read each block as one take. Save each take under the name of its scene:
`<scene>.wav`, `.m4a` or `.mp3`. Then run `demo/video/build.sh --url <page url> --audio-dir <that directory>`
to build the video again. A scene with a recording lasts as long as the recording, so the speed of the read
moves nothing out of step. A scene without a recording stays silent and lasts the seconds given here.
`record.cjs` writes this file from `script.json`. Edit the text there.

## 1 · The problem

**problem** · 3.4 s

> AI agents will write contract patches. Who decides what a contract installs?

**answer** · 3.6 s

> A Lean proof checker inside a NEAR contract decides.

## 2 · One check, from the button to the answer

**ask** · 5.2 s

> Ask the contract yourself: a read-only call from the browser, no wallet.

**refuted** · 4.6 s

> The deployed code of October first: refuted. One deposited, a hundred returned.

**fix-pick** · 2.0 s

> The team's own fix.

**fix** · 4.2 s

> Proved. The contract checked it a moment ago.

## 3 · The case and the rule

**case** · 3.8 s

> Old code: eighty credits with nothing behind them. Now: none.

**credit** · 3.5 s

> Its team found and fixed it. Emet found none of this.

**rule** · 4.0 s

> The rule: four lines of Lean. One was a comment.

## 4 · The gate

**gate** · 4.0 s

> These contracts deleted their own keys. Only the gate can upgrade.

**refused** · 3.1 s

> No proof: refused. One bit changed: refused.

**near** · 3.9 s

> On NEAR, one proof check is one function call.

**installed** · 3.4 s

> With the proof: installed. The same deposit answers one.

## 5 · A model's proof, paid on testnet

**paid** · 3.8 s · only when the page has `{"sel":"#open-bounties td","has":"paid: "}`

> The board already paid one bounty, for a counterexample that a model wrote.

**model** · 3.4 s · only when the page has `#agent`

> The model holds no key: our script signed.

## 6 · A larger statement

**arena** · 4.9 s · only when the page has `#arena`

> Two theorems of NEAR Proof Arena, checked on testnet.

## 7 · What this is not

**limits** · 3.2 s

> A proof about one expression, not about the contract.

## 8 · Check it yourself

**terminal** · 7.2 s

> Check all of it yourself with one read-only command.

## 9 · Where to go next

**end** · 3.6 s

> No proof, no upgrade.

176 words in all.
