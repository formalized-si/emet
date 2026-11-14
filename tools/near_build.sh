#!/usr/bin/env bash
# tools/near_build.sh <crate dir> [cargo-near options]: build one contract into <crate dir>/target/near/.
# The build does not depend on the host: source paths are remapped and tools/rustc_stable_metadata.sh keeps
# the build host out of the symbol hashes, so macOS arm64 and Linux x86_64 give the same bytes
# (docs/REPRODUCIBLE-BUILDS.md). The binaries in artifacts/ are built this way.
# EMET_REPRO=0 passes the caller's options instead: the earlier build, whose output depends on the host.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$1"; shift
if [ "${EMET_REPRO:-1}" = 1 ]; then
  CH=${CARGO_HOME:-$HOME/.cargo}
  export RUSTC_WRAPPER="$ROOT/tools/rustc_stable_metadata.sh"
  set -- --env "RUSTFLAGS=-C link-arg=-s --remap-path-prefix=$ROOT=/build --remap-path-prefix=$CH/git/checkouts=/cargo-git --remap-path-prefix=$CH/registry/src=/cargo-registry"
fi
exec cargo near build non-reproducible-wasm --locked "$@"
