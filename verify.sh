#!/usr/bin/env bash
# The checks behind README.md. AGENTS.md maps each statement to a mode and to the line to look for.
#   ./verify.sh             The offline checks, then the read-only checks of the testnet deployment.
#                           Needs Python 3 only. About a minute. Then it lists the other modes.
#   ./verify.sh --offline   The offline checks only: every recorded run against this checkout. 2 seconds.
#   ./verify.sh --live      Read-only questions to the deployment in deploy/testnet.json, with
#                           python3 tools/check_live.py. More arguments go to that script. About a minute.
#   ./verify.sh --rehearse  The refund case as real transactions on a local NEAR node: 18 checks, about 4 min.
#                           It sends nothing to a public network.
#   ./verify.sh --serve     The page, with a proof checker on a local NEAR node behind its button.
#   ./verify.sh --wallet    The wallet scenario on a local NEAR node: 19 claims, about 11 min.
#   ./verify.sh --faults    The failure paths of the wallet case on a local NEAR node: 12 checks, about 11 min.
#   ./verify.sh --hostile   98 invalid proofs through the proof checker on a local NEAR node. About 5 min.
#   ./verify.sh --refund    Both NEAR Intents commits built from source, then the refund case on a local NEAR
#                           node. It writes evidence/refund/ again. 4 to 6 min.
#   ./verify.sh --lean      The sealed environment, the proofs, the invalid proofs and the four buggy wallets
#                           built from Lean again, and the wasm binaries built from Rust again. It compares
#                           each with the file in this checkout, byte for byte, and checks the proofs
#                           with a native build of nanoda. The two wallet binaries compare on macOS arm64
#                           only. Needs elan, cargo and cargo-near. 2 to 5 min.
#   ./verify.sh --nearai    The proofs of the open-weight models and their signatures, checked again with no
#                           API call. Needs cargo. 2 to 6 min.
#   ./verify.sh --run CMD   Any command of this repository in the toolchain container (Linux with Docker).
# Every mode except --nearai and --run starts with the offline checks.
# A mode with a local NEAR node needs Node 20 or newer, npm, curl, and one download of the npm packages and of
# the near-sandbox binary. It runs on macOS arm64 and on Linux x86_64. Each run removes the directory of its
# node under .runtime/ when it ends (tools/local-node.cjs). EMET_KEEP_RUNTIME=1 keeps that directory.
# To write a proof with your own LLM agent:  python3 agent/solve.py Wallet.Claim.AllowedReceiversOnly run-output/my-agent
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-}"
case "$MODE" in -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;; esac
case "$MODE" in ""|--offline|--wallet|--lean|--faults|--serve|--hostile|--refund|--nearai|--rehearse|--live|--run) ;; *) echo "unknown option $MODE"; exit 64 ;; esac
# ---- host or container: begin ------------------------------------------------------------------------------
# Every mode first checks that this host can run it. On Linux with Docker, a mode the host cannot run (a tool
# is missing, or glibc is older than the local NEAR node needs) re-runs itself in a pinned image with this
# checkout mounted at /work: node:22-trixie by digest when the mode needs only Node, the image built from
# ./Dockerfile (Rust 1.98.0, cargo-near 0.22.0, Lean 4.35.0) for --refund, --lean, --nearai and --run.
#   EMET_DOCKER=1 ./verify.sh [mode]   use the container whatever the host has
#   EMET_DOCKER=0 ./verify.sh [mode]   never use it: say what is missing and stop
#   ./verify.sh --run <command ...>    run any command of this repository in the toolchain image, for example
#                                      ./verify.sh --run python3 cases/intents-refund/propose.py --candidate ... --out ...
# Without Docker, a host whose only problem is an older glibc still runs the local NEAR node: the same
# near-sandbox binary is started with Debian 13's C library (tools/newer_glibc.py). Anything else missing
# stops the command before it does any work, and the message names it.
SANDBOX_VERSION=2.14.0
ARGS=("${1:-}" "${@:2}")
export PATH="$PATH:$HOME/.cargo/bin:$HOME/.elan/bin"
case "$MODE" in ""|--offline|--lean|--nearai|--live) needs_node=no ;; *) needs_node=yes ;; esac
can_docker() { [ -z "${EMET_IN_DOCKER:-}" ] && [ "${EMET_DOCKER:-}" != 0 ] && [ "$(uname -s)" = Linux ] && docker info >/dev/null 2>&1; }
in_container() {   # $1: why this host cannot run the mode
  local image extra="" port="${EMET_PORT:-8798}"
  if [ -n "${EMET_IN_DOCKER:-}" ]; then echo "verify.sh${MODE:+ $MODE}: $1 (inside the container; rebuild the image from ./Dockerfile)" >&2; exit 2; fi
  if [ "${EMET_DOCKER:-}" != 1 ] && ! can_docker; then
    echo "verify.sh${MODE:+ $MODE} cannot run on this host: $1." >&2
    echo "Provide what is named above (versions: README.md, under Run it), or on Linux install Docker and run the same command again: it then runs in a pinned container. ./verify.sh --offline needs only python3." >&2
    exit 2
  fi
  case "$MODE" in
    --refund|--lean|--nearai|--run)
      image="emet-verify:$(cksum < Dockerfile | cut -d' ' -f1)"
      if ! docker image inspect "$image" >/dev/null 2>&1; then
        echo "building $image from ./Dockerfile (once: about 4 minutes, 7 GB)" >&2
        docker build --platform linux/amd64 -t "$image" - < Dockerfile >&2
      fi ;;
    *) image=$(sed -n 's/^FROM //p' Dockerfile) ;;
  esac
  [ "$MODE" != --serve ] || extra="-p 127.0.0.1:$port:$port -e EMET_PORT=$port -e EMET_HOST=0.0.0.0 --name emet-serve-$port"
  if [ -t 0 ] && [ -t 1 ]; then extra="$extra -it"; fi
  docker info -f '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless || extra="$extra --user $(id -u):$(id -g)"
  echo "$1: running ./verify.sh${MODE:+ $MODE} in $image" >&2
  mkdir -p .runtime/home
  # shellcheck disable=SC2086
  exec docker run --rm --init --platform linux/amd64 $extra -e EMET_IN_DOCKER=1 -e EMET_REPRO -e EMET_KEEP_RUNTIME -e USER=emet \
    -e HOME=/work/.runtime/home -e CARGO_HOME=/work/.runtime/home/.cargo -v "$PWD":/work -w /work "$image" ./verify.sh "${ARGS[@]}"
}
if [ "$MODE" = --run ]; then
  [ $# -gt 1 ] || { echo "usage: ./verify.sh --run <command ...>"; exit 64; }
  [ -n "${EMET_IN_DOCKER:-}" ] || EMET_DOCKER=1 in_container "--run"
  shift; exec "$@"
fi
[ "${EMET_DOCKER:-}" != 1 ] || [ -n "${EMET_IN_DOCKER:-}" ] || in_container "EMET_DOCKER=1"
tools=python3
[ $needs_node = no ] || tools="$tools curl node npm"
case "$MODE" in --nearai) tools="$tools cargo" ;; --lean) tools="$tools git cargo cargo-near lake" ;; --refund) tools="$tools git rustup cargo cargo-near lake" ;; esac
missing=""
for t in $tools; do command -v "$t" >/dev/null || missing="$missing $t"; done
[ -z "$missing" ] || in_container "missing:$missing"
[ $needs_node = no ] || node -e 'process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)' || in_container "node $(node --version) is older than 20"
# cases/intents-refund/build.py unpacks the upstream archive with tarfile's data filter: Python 3.10.12 (Ubuntu
# 22.04) refuses a relative symlink in it and Python 3.11.2 (Debian 12) has no such filter; 3.12.3 and newer work.
[ "$MODE" != --refund ] || python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))' \
  || in_container "python3 is $(python3 -c 'import platform; print(platform.python_version())'), and --refund needs 3.12 or newer"
[ "$MODE" != --refund ] || rustup target list --toolchain 1.98.0 --installed 2>/dev/null | grep -qx wasm32-unknown-unknown \
  || in_container "missing: Rust 1.98.0 with wasm32-unknown-unknown (rustup toolchain install 1.98.0 --target wasm32-unknown-unknown)"
case "$(uname -s)-$(uname -m)" in Linux-x86_64|Darwin-arm64) platform="$(uname -s)-$(uname -m)" ;; *) platform=unsupported ;; esac
fetch_sandbox() {   # prints the directory of a near-sandbox binary that runs on this host
  [ "$platform" != unsupported ] || return 1
  local dir="$PWD/.sandbox/$1"
  if [ ! -x "$dir/near-sandbox" ]; then
    echo "downloading near-sandbox $1 for $platform" >&2
    mkdir -p "$dir"
    curl -fsSL "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/$platform/$1/near-sandbox.tar.gz" | tar -xz -C "$dir" --strip-components=1 || { rm -rf "$dir"; return 3; }
  fi
  "$dir/near-sandbox" --version >/dev/null 2>&1 || return 1
  echo "$dir"
}
[ $needs_node = no ] || sandbox_dir=$(fetch_sandbox "$SANDBOX_VERSION") || sandbox_dir=$?
if [ "${sandbox_dir:-}" = 3 ]; then
  echo "verify.sh${MODE:+ $MODE}: could not download near-sandbox $SANDBOX_VERSION from s3-us-west-1.amazonaws.com/build.nearprotocol.com. Without that download ./verify.sh, --offline and --live still run: they start no local node." >&2; exit 2
elif [ "${sandbox_dir:-}" = 1 ]; then
  why="near-sandbox $SANDBOX_VERSION does not run here (it needs Linux x86_64 with glibc >= 2.38, such as Ubuntu 24.04 or Debian 13, or macOS arm64; this is $(uname -sm), $(getconf GNU_LIBC_VERSION 2>/dev/null || echo no glibc))"
  if can_docker || [ "$platform" != Linux-x86_64 ] || ! python3 tools/newer_glibc.py ".sandbox/$SANDBOX_VERSION" || ! sandbox_dir=$(fetch_sandbox "$SANDBOX_VERSION"); then
    in_container "$why"
  fi
  echo "$why: started it with Debian 13's glibc 2.41 instead, unpacked into .sandbox/$SANDBOX_VERSION/glibc" >&2
fi
# ---- host or container: end --------------------------------------------------------------------------------
# ---- --nearai: begin ---------------------------------------------------------------------------------------
#   ./verify.sh --nearai    offline, no API call: the proofs an open-weight model served by NEAR AI Cloud wrote
#                           (evidence/nearai/; `python3 -I agent/nearai_record.py` prints the summary and the
#                           table). For each accepted one: nanoda, this kernel built natively
#                           (needs cargo), type-checks shelf + proof; the stored local-node record shows the kernel
#                           contract accepted exactly these bytes; NEAR AI's attestation report and response
#                           signatures are re-verified from the stored bytes (tools/verify_nearai.py), and thirteen
#                           tampered copies of that evidence must fail; and, when elan and lean4export are
#                           already installed, Lean re-elaborates Solution.lean and re-exports the same proof bytes.
#                           Then the refund case (evidence/nearai-refund/, written by agent/nearai_patch.py), where the
#                           model proposed the patch and wrote its proof. For each accepted attempt
#                           tools/verify_nearai.py checks the attestation and signatures, that prompt.md,
#                           candidate.rs and Solution.lean are the signed texts, that nanoda natively type-checks
#                           the sealed environment plus proof.ndjson and the proof states the claim of that
#                           candidate, and that the recorded local job (certificate, payout, installed wasm) is
#                           for these bytes; up to twenty-two tampered copies must fail; and, with Lean, the claim is
#                           derived again from candidate.rs, the same environment and proof bytes come out, and
#                           `#print axioms` gives the recorded axioms of the model's proof.
if [ "$MODE" = "--nearai" ]; then
  export PATH="$HOME/.elan/bin:$PATH"
  sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
  E=evidence/nearai; OUT=run-output/nearai; rm -rf "$OUT"; mkdir -p "$OUT"
  SHELF=$(python3 -S -c "import json;print(json.load(open('demo/bounties.json'))['shelf'])")
  (cd tools/native && cargo build --release --quiet)
  python3 -S - "$E" "$(sha artifacts/kernel.wasm)" "$(cat "$SHELF/base.sha256")" > "$OUT/accepted.txt" <<'EOF'
import json, sys
e, kernel, shelf = sys.argv[1:]
local = json.load(open(e + "/local-node.json"))
assert local["code_sha256"]["kernel"] == kernel and local["shelf_sha256"] == shelf, "the local-node record is for another kernel or shelf"
sums = {l.split()[1].removesuffix(".wasm"): l.split()[0] for l in open("artifacts/SHA256SUMS") if l.strip()}
assert all(sums[k] == v for k, v in local["code_sha256"].items()), "the local-node record is for other contract binaries than artifacts/"
chain = {r["delta_sha256"]: r for r in local["results"]}
for a in json.load(open(e + "/attempts.json"))["attempts"]:
    if a["lean_accepts"]:
        r = chain.get(a["delta_sha256"])
        on_chain = bool(r and r["accepted_by_kernel_contract"] and r["bounty"]["certificate"]["proved"] == a["claim"])
        print(a["attempt"], a["claim"], a["delta_sha256"], "yes" if on_chain else "no", round(r["reveal"]["kernel_tgas"]) if on_chain else 0)
EOF
  n=0
  while read -r attempt claim want on_chain tgas; do
    printf '\n\033[1m== %s, written by the model in %s\033[0m\n' "$claim" "$attempt"
    [ "$(sha "$E/$attempt/delta.ndjson")" = "$want" ] || { echo "FAIL the proof file is not the recorded one"; exit 1; }
    cat "$SHELF/base.ndjson" "$E/$attempt/delta.ndjson" > "$OUT/full.ndjson"
    tools/native/target/release/proof-courier-native "$OUT/full.ndjson" >/dev/null 2>&1 || { echo "FAIL the kernel rejects shelf + proof"; exit 1; }
    echo "ok   nanoda (this repository's kernel, native) type-checks shelf + proof (${want:0:16}…)"
    [ "$on_chain" = yes ] || { echo "FAIL no record of the kernel contract accepting these bytes"; exit 1; }
    echo "ok   recorded: the kernel contract (artifacts/kernel.wasm) accepted these bytes as a proof of $claim on a local node, $tgas TGas; the board paid"
    if command -v lake >/dev/null && [ -x .tools/lean4export/.lake/build/bin/lean4export ]; then
      mkdir -p "$OUT/$attempt" && cp "$E/$attempt/Solution.lean" "$OUT/$attempt/"
      python3 -I agent/solve.py "$claim" "$OUT/$attempt" --reuse </dev/null >/dev/null || { echo "FAIL Lean does not accept Solution.lean as a proof of $claim"; exit 1; }
      [ "$(sha "$OUT/$attempt/delta.ndjson")" = "$want" ] || { echo "FAIL the re-exported proof differs from the recorded one"; exit 1; }
      echo "ok   Lean re-elaborates Solution.lean: its type is the claim, only allowed axioms, and the export is the same bytes"
    else echo "skip Lean re-elaboration of Solution.lean (needs elan and lean4export: ./verify.sh --lean builds it once)"; fi
    python3 -S tools/verify_nearai.py "$E/$attempt" | grep -v '^ok   response ' || { echo "FAIL NEAR AI attestation"; exit 1; }
    python3 -S tools/verify_nearai.py --tamper "$E/$attempt" | tail -1 | sed 's/^/     the checker itself: /' || { echo "FAIL a tampered copy of the evidence passes the checks"; exit 1; }
    n=$((n + 1))
  done < "$OUT/accepted.txt"
  [ "$n" -gt 0 ] || { echo "FAIL no accepted proof in $E"; exit 1; }
  echo; echo "$n proof(s) by a NEAR AI Cloud model re-checked. To take them through the kernel contract again (a local node, about a minute per chain):"
  echo "  NEAR_SANDBOX_BIN_PATH=\$PWD/.sandbox/2.14.0/near-sandbox NEAR_SANDBOX_BINARY_PATH=\$PWD/.sandbox/2.14.0 node agent/nearai_local.cjs run-output/nearai-local.json $(sed "s|^\([^ ]*\) .*|$E/\1|" "$OUT/accepted.txt" | tr '\n' ' ')"
  T=evidence/nearai-testnet
  if [ -f "$T/claim.json" ]; then
    set -- $(python3 -S -c "import json,sys;m=json.load(open(sys.argv[1]));print(m['attempt'],m['claim'],m['proof']['sha256'],m['model'],m['bounty'])" "$T/claim.json")
    attempt=$1; claim=$2; want=$3; model=$4; bounty=$5
    printf '\n\033[1m== Testnet: %s wrote the counterexample that bounty %s paid for, in %s\033[0m\n' "$model" "$bounty" "$attempt"
    [ "$(sha "$T/$attempt/delta.ndjson")" = "$want" ] || { echo "FAIL the proof file is not the one the testnet certificate names"; exit 1; }
    cat cases/intents-refund/shelf/base.ndjson "$T/$attempt/delta.ndjson" > "$OUT/full-testnet.ndjson"
    tools/native/target/release/proof-courier-native "$OUT/full-testnet.ndjson" >/dev/null 2>&1 || { echo "FAIL the kernel rejects the sealed environment + proof"; exit 1; }
    echo "ok   nanoda (this repository's kernel, native) type-checks the sealed environment + proof (${want:0:16}…): the bytes the testnet certificate names"
    if command -v lake >/dev/null && [ -x .tools/lean4export/.lake/build/bin/lean4export ]; then
      mkdir -p "$OUT/testnet-$attempt" && cp "$T/$attempt/Solution.lean" "$OUT/testnet-$attempt/"
      python3 -I agent/solve.py "$claim" "$OUT/testnet-$attempt" --shelf cases/intents-refund/shelf --reuse </dev/null >/dev/null || { echo "FAIL Lean does not accept Solution.lean as a proof of $claim"; exit 1; }
      [ "$(sha "$OUT/testnet-$attempt/delta.ndjson")" = "$want" ] || { echo "FAIL the re-exported proof differs from the recorded one"; exit 1; }
      echo "ok   Lean re-elaborates Solution.lean: its type is the claim, no axiom, and the export is the same bytes"
    else echo "skip Lean re-elaboration of Solution.lean (needs elan and lean4export: ./verify.sh --lean builds it once)"; fi
    python3 -S tools/verify_nearai.py "$T/$attempt" | grep -v '^ok   response ' || { echo "FAIL NEAR AI attestation"; exit 1; }
    python3 -S tools/verify_nearai.py --tamper "$T/$attempt" | tail -1 | sed 's/^/     the checker itself: /' || { echo "FAIL a tampered copy of the evidence passes the checks"; exit 1; }
    echo "     that the testnet board paid for these bytes is in $T/claim.json; ./verify.sh --live asks the chain"
  fi
  R=evidence/nearai-refund
  [ -f "$R/attempts.json" ] || exit 0
  python3 -S - "$R" > "$OUT/refund.txt" <<'EOF'
import json, sys
for a in json.load(open(sys.argv[1] + "/attempts.json"))["attempts"]:
    if a["accepted"]:
        print(a["attempt"], a["model"], round((a["local_node"] or {}).get("kernel_tgas", 0)), " ".join(a["expression"].split()))
EOF
  m=0
  while read -r attempt model tgas expression; do
    printf '\n\033[1m== Refund case: %s proposed %s and proved it, in %s\033[0m\n' "$model" "$expression" "$attempt"
    [ -f "$R/$attempt/result.json" ] || { echo "FAIL no recorded local job for this attempt"; exit 1; }
    python3 -S tools/verify_nearai.py "$R/$attempt" | grep -v '^ok   response ' || { echo "FAIL the evidence of this attempt"; exit 1; }
    echo "     recorded: the kernel contract burnt $tgas TGas on this proof"
    python3 -S tools/verify_nearai.py --tamper "$R/$attempt" | tail -1 | sed 's/^/     the checker itself: /' || { echo "FAIL a tampered copy of the evidence passes the checks"; exit 1; }
    if command -v lake >/dev/null && [ -x .tools/lean4export/.lake/build/bin/lean4export ]; then
      W="$OUT/refund-$attempt"
      python3 cases/intents-refund/propose.py --candidate "$R/$attempt/candidate.rs" --proof "$R/$attempt/Solution.lean" --side proof --out "$W" --prepare-only >/dev/null \
        && (cd "$W/workspace" && bash cases/intents-refund/export.sh >/dev/null 2>&1) || { echo "FAIL Lean does not accept Solution.lean as a proof of the claim generated for candidate.rs"; exit 1; }
      gzip -dc "$R/$attempt/base.ndjson.gz" | cmp -s - "$W/workspace/cases/intents-refund/shelf/base.ndjson" \
        && cmp -s "$R/$attempt/proof.ndjson" "$W/workspace/cases/intents-refund/proofs/user_patch.ndjson" \
        || { echo "FAIL the re-derived environment or proof differs from the recorded one"; exit 1; }
      echo "ok   Lean derives the claim again from candidate.rs and re-elaborates Solution.lean: the same sealed environment, the same proof bytes"
      if [ -f "$R/$attempt/RefundCase.lean" ]; then
        same=$(python3 -S tools/verify_nearai.py --statement "$R/$attempt/RefundCase.lean" "$W/workspace/cases/intents-refund/RefundCase.lean") || { echo "FAIL the statement the model was shown is not the one generated for candidate.rs"; exit 1; }
        echo "ok   RefundCase.lean as the model saw it, against the one generated now: $same"
      fi
      said=$(python3 -S -c "import json,sys;print(json.load(open(sys.argv[1])).get('axioms_line',''))" "$R/$attempt/report.json")
      if [ -n "$said" ]; then
        (cd "$W/workspace/cases/intents-refund" && printf 'import CandidateProof\n#print axioms Solution.proof\n' > Axioms.lean && lake env lean Axioms.lean 2>&1) | grep -qxF "$said" \
          || { echo "FAIL Lean does not report the recorded axioms for Solution.proof"; exit 1; }
        echo "ok   Lean again: $said"
      fi
    else echo "skip deriving the claim again with Lean (needs elan and lean4export: ./verify.sh --lean builds it once)"; fi
    m=$((m + 1))
  done < "$OUT/refund.txt"
  echo; echo "$m accepted refund attempt(s) of a NEAR AI Cloud model re-checked (all attempts: $R/attempts.json, facts: $R/FACTS.md). To run one through a fresh local node again (about 3 minutes; it fetches and builds the pinned upstream revision):"
  echo "  python3 cases/intents-refund/propose.py --candidate $R/<attempt>/candidate.rs --proof $R/<attempt>/Solution.lean --side proof --out run-output/my-refund"
  exit 0
fi
# ---- --nearai: end -----------------------------------------------------------------------------------------
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "Offline: binaries, shelf, provenance, proofs, recorded run (Python standard library)"
python3 -S tools/check_offline.py
python3 -S tools/check_hostile.py
# --refund records that evidence again and checks it at its end; checked first, a changed case could never be re-recorded.
[ "$MODE" = "--refund" ] || python3 -S cases/intents-refund/check.py
if [ "$MODE" = "--lean" ]; then
  step "Lean: rebuild from source, compare byte for byte, re-check with nanoda"
  tools/check_lean.sh
  step "Contracts: rebuild the wasm binaries from source and compare byte for byte"
  tools/build_wasm.sh
fi
case "$MODE" in --offline|--lean) echo; echo "Done. Run ./verify.sh --rehearse for the refund case on a local NEAR node (3 to 4 min); ./verify.sh without options lists the other modes."; exit 0 ;; esac
if [ "$MODE" = "--live" ] || [ -z "$MODE" ]; then
  step "The deployed contracts, asked now (tools/check_live.py; read-only)"
  [ -z "$MODE" ] || exec python3 tools/check_live.py "${@:2}"
  live=0; python3 tools/check_live.py || live=$?
  echo
  if [ "$live" = 0 ]; then echo "Done: the offline checks and the read-only checks of the testnet deployment passed. Neither ran a contract on this machine."
  else echo "The offline checks passed; the checks of the testnet deployment did not (exit $live, see above). They need to reach a NEAR testnet RPC node (./verify.sh --live --rpc <url> asks another one); ./verify.sh --offline needs no network."; fi
  cat <<'MODES'
The modes that run contracts, each on a fresh local NEAR node (Node 20+; the script downloads the node binary once):
  ./verify.sh --rehearse   the refund case as real transactions, 18 checks: 3 to 4 min
  ./verify.sh --serve      the page, with a local proof checker behind its button: ready in under a minute
  ./verify.sh --wallet     the wallet scenario end to end, 19 claims: about 11 min
  ./verify.sh --faults     the wallet's failure paths, 12 checks: about 11 min
  ./verify.sh --hostile    98 invalid proofs through the proof checker contract: about 5 min
From source (Rust, cargo-near, Lean): ./verify.sh --refund (4 to 6 min), --lean (2 to 5 min), --nearai (2 to 6 min). The table is in AGENTS.md.
MODES
  exit "$live"
fi

if [ "$MODE" = "--refund" ]; then step "Real upstream refund case and proof-gated patch (local sandbox)"; elif [ "$MODE" = "--hostile" ]; then step "Hostile corpus through the local kernel contract"; elif [ "$MODE" = "--serve" ]; then step "Local interactive proof checker (view calls on a fresh sandbox)"; elif [ "$MODE" = "--faults" ]; then step "Failure paths on a local NEAR node: transfers and a wallet setup that fail, and two bugs found in review"; elif [ "$MODE" = "--rehearse" ]; then step "Rehearse the public deployment of the refund case on a local NEAR node (deploy/live-refund.cjs --claim-open)"; else
step "End to end on a local NEAR node: wallet factory, shelf, board, 5 bounties, 8 cheats, two agents racing, a front-runner, a refutation and the live bypass, an escrowed top-up, a second wallet covered by the same proof"; fi
"$sandbox_dir/near-sandbox" --version | head -1
export NEAR_SANDBOX_BIN_PATH="$sandbox_dir/near-sandbox" NEAR_SANDBOX_BINARY_PATH="$sandbox_dir"
[ -d node_modules/near-workspaces ] || npm ci --no-audit --no-fund --loglevel=error
mkdir -p run-output
if [ "$MODE" = "--refund" ]; then
  export PATH="$HOME/.elan/bin:$PATH"
  step "Pinned NEAR Intents source, rejected candidate patches, Lean proof and source binding"
  (cd tools/native && cargo +1.98.0 build --release --locked --quiet)
  bash cases/intents-refund/export.sh
  python3 cases/intents-refund/test_prepare.py
  python3 cases/intents-refund/test_propose.py
  step "Build the real upstream contract and its one-expression repair from clean source archives"
  python3 cases/intents-refund/build.py
  step "Build the immutable artifact gate"
  (cd contracts/patch-gate && cargo test --release --locked)
  tools/near_build.sh contracts/patch-gate
  if cmp -s contracts/patch-gate/target/near/emet_patch_gate.wasm artifacts/refund/gate.wasm; then echo "ok   gate.wasm built from source is artifacts/refund/gate.wasm, byte for byte"; else echo "DIFF gate.wasm built from source differs from artifacts/refund/gate.wasm"; fi
  step "Real NEP-245 transfers: unbacked credits before and after the repair"
  node cases/intents-refund/replay.cjs
  step "Pay the proof bounty and install that exact candidate in the same keyless contract"
  node cases/intents-refund/upgrade.cjs
  python3 cases/intents-refund/record.py
  python3 cases/intents-refund/check.py
  exit $?
fi
if [ "$MODE" = "--hostile" ]; then
  node demo/hostile.cjs run-output/hostile/results.json
  exit $?
fi
if [ "$MODE" = "--rehearse" ]; then
  node deploy/live-refund.cjs --claim-open
  exit $?
fi
if [ "$MODE" = "--serve" ]; then
  exec node demo/serve.cjs
fi
if [ "$MODE" = "--faults" ]; then
  node demo/faults.cjs run-output/faults.json 2>&1 | grep --line-buffered -v -E '^(Receipts?:|\s+(Failure|Log) \[|Retrying transaction)'
  test "${PIPESTATUS[0]}" -eq 0
  exit 0
fi
node demo/scenario.cjs run-output/scenario.json 2>&1 | grep --line-buffered -v -E '^(Receipts?:|\s+(Failure|Log) \[|Retrying transaction)'
test "${PIPESTATUS[0]}" -eq 0
echo; echo "Records are in run-output/. To view this run: python3 -m http.server, then open http://localhost:8000/demo/web/wallet.html?run=../../run-output/scenario.json"
