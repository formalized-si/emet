# A prover that is not ours: open-weight models on NEAR AI Cloud take the same bounties

Claude models wrote every proof in the wallet demo. Here the prover is an open-weight model. NEAR AI Cloud
(https://docs.near.ai/) serves it inside an Intel TDX VM on NEAR AI's own GPU fleet. The model gets the same prompt
and the same workspace as the Claude agents (`agent/solve.py`). The workspace has the four Policy files, a stub
`Solution.lean`, Lean and `./measure.sh`. It does not have the wallet author's own proofs.

The model works through a small loop of tool calls (`agent/nearai.py`). Three checkers then check its text: Lean, a
native build of this repository's kernel, and the kernel contract on a local NEAR node. They check the proof of
any other agent the same way.

The chain checks the proof, whoever writes it. The attestation says which model wrote the text and where it ran.
It says nothing about whether the proof is correct.

## Results

| Attempt | Model | Tokens in / out | Cost at list price | Billed | Wall time | Requests | Repair rounds | Lean | Native kernel | Kernel contract (local node) | Signed responses | Attestation (offline) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `AllowedReceiversOnly-deepseek-v4.1-flash` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 10,997 / 262 | USD 0.0036 | USD 0.0022 | 609 s | 3 + 1 cut | 0 | no | - | - | 3/3 | - |
| `AllowedReceiversOnly-deepseek-v4.1-flash-2` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 671,859 / 113,877 | USD 0.3382 | USD 0.1462 | 3621 s | 51 | 22 | yes | yes | yes (216 TGas) | 51/51 | yes |
| `NonceCountsPayments-deepseek-v4.1-flash` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 38,698 / 18,323 | USD 0.0336 | USD 0.0243 | 1026 s | 7 + 1 cut | 1 | no | - | - | 7/7 | - |
| `NonceCountsPayments-deepseek-v4.1-flash-2` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 362,635 / 113,308 | USD 0.2792 | USD 0.1412 | 4080 s | 34 + 1 cut | 14 | no | - | - | 34/34 | - |
| `NonceCountsPayments-deepseek-v4.1-flash-3` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 226,606 / 90,039 | USD 0.1760 | USD 0.1109 | 4658 s | 26 | 9 | no | - | - | 26/26 | - |
| `PerTxCapAlways-deepseek-v4.1-flash` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 101,243 / 49,619 | USD 0.0899 | USD 0.0628 | 2109 s | 16 + 1 cut | 6 | no | - | - | 16/16 | - |
| `PerTxCapAlways-deepseek-v4.1-flash-2` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 217,292 / 28,320 | USD 0.0992 | USD 0.0394 | 929 s | 24 | 9 | yes | yes | yes (215 TGas) | 24/24 | yes |
| `PerTxCapAlways-glm-5.3-flash` | `z-ai/glm-5.3-flash` | 846,579 / 46,548 | USD 0.0910 | USD 0.0398 | 1608 s | 60 | 28 | no | - | - | 60/60 | - |
| `PerTxCapAlways-qwen3.8-27b` | `Qwen/Qwen3.8-27B` | 628,321 / 120,473 | USD 0.1878 | USD 0.1743 | 1765 s | 60 | 32 | no | - | - | 60/60 | - |
| `Refute.SlidingDayCap-deepseek-v4.1-flash` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 169,202 / 18,222 | USD 0.0726 | USD 0.0268 | 583 s | 19 | 4 | yes | yes | yes (186 TGas) | 19/19 | yes |
| `Refute.SlidingDayCap-glm-5.3-flash` | `z-ai/glm-5.3-flash` | 74,018 / 16,549 | USD 0.0142 | USD 0.0099 | 661 s | 11 | 2 | yes | yes | yes (181 TGas) | 11/11 | yes |
| `Refute.SlidingDayCap-qwen3.8-27b` | `Qwen/Qwen3.8-27B` | 193,328 / 76,111 | USD 0.1105 | USD 0.1065 | 1150 s | 21 | 7 | yes | yes | yes (185 TGas) | 21/21 | yes |
| `SlidingTwiceCap-deepseek-v4.1-flash` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 11,003 / 233 | USD 0.0036 | USD 0.0021 | 608 s | 3 + 1 cut | 0 | no | - | - | 3/3 | - |
| `SlidingTwiceCap-deepseek-v4.1-flash-2` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 144,686 / 82,727 | USD 0.2062 | USD 0.1018 | 3698 s | 17 + 2 cut | 4 | no | - | - | 17/17 | - |
| `SlidingTwiceCap-deepseek-v4.1-flash-3` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 17,930 / 362 | USD 0.0667 | USD 0.0006 | 1744 s | 4 + 3 cut | 0 | no | - | - | 4/4 | - |
| `SlidingTwiceCap-deepseek-v4.1-flash-4` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 141,778 / 72,939 | USD 0.1423 | USD 0.0910 | 4535 s | 19 + 1 cut | 3 | no | - | - | 19/19 | - |

All 386 requests of this work cost USD 2.0022 at list price (billed for the answered ones: USD 1.0799).

- `AllowedReceiversOnly-deepseek-v4.1-flash`: not accepted: the proof still contains sorry. The service ended this attempt, and the model did not fail on the problem. The model still worked on the fourth request after 10 minutes, and the gateway closed the connection with no response (HTTP 0 in report.json). The model wrote nothing. Nobody here knows whether NEAR AI billed that request. With no response there is no id to ask about, and the ledger counts a guess for it.
- `AllowedReceiversOnly-deepseek-v4.1-flash-2`: accepted, a 159,991-byte proof file, axioms: none. This is the headline bounty of the wallet demo, and the proof covers every policy, state and request list. Byte-wise account equality is sound, and an allow verdict implies that the receiver passed the allowlist check. Then the proof uses induction on the list. The model wrote 23 versions, and 17 Lean runs failed. The attempt reached its one-hour limit before the model said DONE, and the check here is on the last version that it wrote.
- `NonceCountsPayments-deepseek-v4.1-flash`: not accepted: Solution.lean does not compile. The model wrote two versions, and neither compiled. Then the gateway cut the eighth request after 10 minutes with no response.
- `NonceCountsPayments-deepseek-v4.1-flash-2`: not accepted: Solution.lean does not compile. The model had no proof after 68 minutes and fifteen versions. The last file is a 19-line probe (an allowed step's nonce is not at its maximum). It does not compile and has no Solution.proof. The gateway cut one request at 600 s.
- `NonceCountsPayments-deepseek-v4.1-flash-3`: not accepted: Solution.lean does not compile. The model had no proof after 78 minutes and ten versions. The last version is a 14-line probe that does not compile. The gateway cut no request. The model wrote 15 to 23 tokens/s during the attempt, about half its earlier rate.
- `PerTxCapAlways-deepseek-v4.1-flash`: not accepted: Solution.lean does not compile. The model wrote seven versions, and none was complete. Then the gateway cut the seventeenth request after 10 minutes with no response. The model first tried to import Policy.Proofs, the wallet author's own proofs, which are not in the workspace.
- `PerTxCapAlways-deepseek-v4.1-flash-2`: accepted, a 169,374-byte proof file, axioms: propext. A proof for every policy, state and request list, by induction on the list. A step that answers allow implies amount <= perTxCap. The proof then uses the head or the induction hypothesis. The model wrote ten versions, and seven Lean runs failed. The recorded demo leaves this bounty unclaimed.
- `PerTxCapAlways-glm-5.3-flash`: not accepted: Solution.lean does not compile. The run stopped at its limit of 60 requests after 29 versions, and the last version does not compile. Midway the model measured a file that had helper lemmas and no Solution.proof, and ./measure.sh answered '0 bytes, OK'. The script agent/measure.py now says that there is nothing to check in that case.
- `PerTxCapAlways-qwen3.8-27b`: not accepted: Solution.lean does not compile. The run stopped at its limit of 60 requests in the middle of the model's experiments. The last file holds two helper lemmas and no Solution.proof.
- `Refute.SlidingDayCap-deepseek-v4.1-flash`: accepted, a 59,298-byte proof file, axioms: none. Its counterexample: day length 100, cap 10, payments of 10 at t = 99 and t = 100, both inside [99, 199). The first version that compiled exported to 157 KB. The model rewrote it three more times, down to 59 KB. The attested action log names prod/DeepSeek-V4.1-Flash-1017-vLLM-DEP8-Abliterated.yaml: one deployment serves this model id and its abliterated variant.
- `Refute.SlidingDayCap-glm-5.3-flash`: accepted, a 56,876-byte proof file, axioms: none. This is a third model family. Its counterexample: day length 4, cap 1, payments of 1 at t = 2 and t = 4, with t0 = 1. The model wrote three versions, and two Lean runs failed. The attested action log names prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V12Q8.yaml.
- `Refute.SlidingDayCap-qwen3.8-27b`: accepted, a 61,735-byte proof file, axioms: none. Its counterexample: day length 10, cap 1, payments of 1 at t = 9 and t = 10, with t0 = 1. For this model the attested action log names prod/small-models.yaml, a deployment whose name does not name the model.
- `SlidingTwiceCap-deepseek-v4.1-flash`: not accepted: the proof still contains sorry. This attempt failed the same way: the gateway cut the fourth request after 10 minutes with no response. The model wrote nothing.
- `SlidingTwiceCap-deepseek-v4.1-flash-2`: not accepted: Solution.lean does not compile. The model had no proof after an hour and five versions. The last version is a probe of the cases of step, with the proof still sorry. Three replies ended at the 16,000-token limit, and the gateway still cut two requests at 600 s. So we lowered the limit to 10,000 tokens for the third attempt.
- `SlidingTwiceCap-deepseek-v4.1-flash-3`: not accepted: the proof still contains sorry. The model wrote nothing: three of its seven requests got no response (one after 514 s, two at 600 s). By then the model wrote 15 to 23 tokens/s, as the attempt that ran beside it measured. At that rate a 10,000-token thought can miss the 10 minutes. From the fourth attempt on, the request limit follows the measured rate.
- `SlidingTwiceCap-deepseek-v4.1-flash-4`: not accepted: Solution.lean has no theorem Solution.proof. The model had no proof after 76 minutes and four versions. The request limit followed the measured rate: 15 to 21 tokens/s, so 4,100 to 8,900 tokens per request. The last version is a 14-line file of probes. Seven replies ended at the limit before the model finished its thought, and the gateway still cut one request.

This tree does not hold the requests, responses, signatures, attestation reports and transcripts of the 11 attempts with no accepted proof (about 16 MB). For those attempts it keeps only `report.json` and the last `Solution.lean`. Their rows above come from the reports, and nobody can verify them again from this tree.

The columns:

- *Attempt*: the directory under evidence/nearai. Its name starts with the claim, without `Wallet.Claim.`. `-2`
  marks a second attempt at the same claim with the same model.
- *Lean*: the independent check of `agent/solve.py`. The file compiles. `Solution.proof` has the claim as its
  type, and no other type. The file has no `sorry` and only allowed axioms. The export matches the sealed
  environment and fits the size limit.
- *Native kernel*: nanoda, built from the contract's source (`tools/native`), type-checks the sealed environment
  plus the proof.
- *Kernel contract*: a run on a fresh local node (`agent/nearai_local.cjs`, near-sandbox). A courier commits, runs
  the free `dry_run`, and reveals with its bond. The board pays after the verdict of the kernel contract.
- *Requests*: answered completions. "+ n cut" counts the requests that the gateway closed at 10 minutes with no
  response.
- *Repair rounds*: the number of times that the model rewrote `Solution.lean` after its first version.
- *Cost at list price*: all prompt and completion tokens at the prices of `GET /v1/models`. The spend cap counted
  this.
- *Billed*: the amount that NEAR AI charged for the answered requests (`POST /v1/billing/costs`, `billed.json`). It
  is lower, because NEAR AI charges cached input tokens at the cache-read price.

A request that the gateway cut has no id to ask about, so nobody here knows whether NEAR AI charged it. The
list-price column counts a guess for it: its input plus a full reply. The billed column counts nothing for it.

## What the attestation check verifies

`python3 -S tools/verify_nearai.py evidence/nearai/<attempt>` works offline on the stored bytes. It uses the Python
standard library only. Its ECDSA P-256 and ed25519 verifiers test themselves on RFC vectors. It checks six things:

1. The agent fetched the attestation report before the first completion, with a nonce that the agent made
   (`nearai/records.json`). The report holds three Intel TDX quotes: the gateway's, the model VM's, and the one of
   the model VM's compose manager.
2. The signatures of each quote hold up to the Intel SGX Root CA key that the script pins. The path of signatures
   is: certificate chain, quoting enclave report, attestation key, quote. The TD is not in debug mode.
3. The `report_data` of each quote is `signing key || nonce`. For the compose manager it is
   `sha256(action log) || nonce`. The MRCONFIGID of each quote is the sha256 of the `app_compose` text in the
   report, and its event log replays to RTMR3.
4. The quote of the compose manager has the measurements of the model quote. Its action log names the deployment
   that started last, with its git commit and sha256.
5. Every response of the attempt carries an ed25519 signature by the model VM's key. The signature covers the
   model id and the sha256 of the stored request and response bytes, and of no other bytes.
6. `Solution.lean` is, byte for byte, the last `write_solution` call in those signed responses.

`--tamper` makes thirteen changed copies of the evidence and requires each to fail.

The result: the proof text came out of the VM that serves NEAR AI's models, under that model id, in answer to the
stored prompts.

## What it does not show

- It shows nothing about correctness. A signed wrong proof is still wrong. Lean, nanoda and the kernel contract
  decide correctness, and they do not look at the attestation.
- The script does not check what needs a network service. That is Intel's TCB status and revocation lists for the
  platform (dcap-qvl, or https://cloud.near.ai/verify), and the NVIDIA GPU evidence (NVIDIA NRAS). The script
  checks only that the GPU evidence is present and carries the nonce.
- The script does not check these at all:
  - certificate validity dates
  - the identity of the quoting enclave
  - what the measured container images do
  - that the deployment file named in the action log loads the weights that its name says (the file is not in the
    report)
  - that the report and the completions came from the same VM (NEAR AI's docs: instances of one model share a
    signing key)
- We compared the Intel root key in the script with the certificate inside the quotes and with the public Intel
  SGX Root CA. We did not download it from Intel during this work.
- The nonce and the timestamps in `records.json` are the agent's own. To the agent they show that the report is
  fresh. To anyone else they show consistency only.
- NEAR AI's docs ask a client to verify the report before it sends a completion. Here the agent fetched the report
  before, and the check ran afterwards. That is enough for a record. It is not enough for a client that must
  refuse an unattested endpoint.

## Commands

    ./verify.sh --nearai        # offline: kernel, recorded contract verdict, Lean (with elan), attestation, tamper test

    NEAR_SANDBOX_BIN_PATH=$PWD/.sandbox/2.14.0/near-sandbox \
      node agent/nearai_local.cjs run-output/nearai-local.json evidence/nearai/AllowedReceiversOnly-deepseek-v4.1-flash-2 evidence/nearai/PerTxCapAlways-deepseek-v4.1-flash-2 evidence/nearai/Refute.SlidingDayCap-deepseek-v4.1-flash evidence/nearai/Refute.SlidingDayCap-glm-5.3-flash evidence/nearai/Refute.SlidingDayCap-qwen3.8-27b      # the kernel contract again, ~1 min

    export NEARAI_API_KEY=...  NEARAI_LEDGER=$PWD/evidence/nearai/spend.jsonl  NEARAI_CAP_USD=4.5
    python3 -I agent/solve.py Wallet.Claim.Refute.SlidingDayCap run-output/my-attempt --backend nearai \
      --model deepseek-ai/DeepSeek-V4.1-Flash-1017 --max-turns 30 --budget-usd 0.6 --timeout 900
    python3 -S tools/verify_nearai.py run-output/my-attempt

    python3 -I agent/nearai_record.py [--billed]      # this text; --billed asks NEAR AI what it charged (needs the key)

## Files in evidence/nearai

- `<attempt>/Solution.lean`, `delta.ndjson`: the model's proof and its export against the sealed environment.
- `<attempt>/report.json`: model, tokens, cost, wall time, repair rounds, and the independent Lean check.
- `<attempt>/transcript.jsonl`: every assistant message and tool result.
- `<attempt>/nearai/NNNN.{request,response,signature}.json`: exact request and response bytes, NEAR AI's signature.
- `<attempt>/nearai/attestation.json`, `records.json`, `verification.json`: the report fetched before the run, the
  nonce and hashes, the result of the offline check.
- `attempts.json`: the table as data. `local-node.json`: the local-node run (decisions, transactions, kernel gas,
  certificates). `spend.jsonl`: every request with its token usage and list-price cost. `billed.json`: what NEAR AI
  billed. `notes.json`: one remark per attempt.

`attestation.json` contains NEAR AI's measured container configuration, which mentions an `Authorization` header
with a placeholder. The record stores no key of ours: it keeps requests as bodies only.
