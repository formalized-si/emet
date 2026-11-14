#!/bin/sh
# RUSTC_WRAPPER for the wasm builds (tools/near_build.sh, cases/intents-refund/build.py): with it the same
# source gives the same bytes on macOS arm64 and on Linux x86_64. EMET_REPRO=0 builds without it.
# Cargo passes each crate a `-C metadata` hash, which rustc mixes into symbol hashes and so into the order
# of functions in the binary. For a wasm32 crate that hash includes the hashes of its proc-macro and
# build-script dependencies, and theirs include the host triple (the `host:` line of `rustc -vV`).
# For wasm32 crates only, this replaces the value with the package name and version, the crate name and
# type, and the enabled cfgs. Everything else, and every host crate, goes to rustc unchanged.
# Measurements on both hosts: docs/REPRODUCIBLE-BUILDS.md.
rustc=$1; shift
# macOS removes DYLD_* variables when /bin/sh starts, and rustc's own linker (rust-lld) needs this one.
case "$(uname -s):$rustc" in Darwin:*/bin/*) export DYLD_FALLBACK_LIBRARY_PATH="${rustc%/bin/*}/lib" ;; esac
case " $* " in *" --target wasm32-unknown-unknown "*) ;; *) exec "$rustc" "$@" ;; esac
id="$CARGO_PKG_NAME=$CARGO_PKG_VERSION"; prev=
for a in "$@"; do
  case "$prev" in --crate-name|--crate-type|--cfg) id="$id,$a" ;; esac
  prev=$a
done
for a in "$@"; do
  shift
  case "$a" in metadata=*) a="metadata=$id" ;; esac
  set -- "$@" "$a"
done
exec "$rustc" "$@"
