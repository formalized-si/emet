#!/usr/bin/env bash
# Build lean4export at the pinned commit into .tools/ (once). Needs elan and git.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.elan/bin:$PATH"
L4E_COMMIT=5a9a355dc6c5fd82b69058d433e2ae2e8dfbf8fe
L4E=.tools/lean4export/.lake/build/bin/lean4export
if [ ! -x "$L4E" ]; then
  command -v lake >/dev/null || { echo "needs elan (https://github.com/leanprover/elan)" >&2; exit 2; }
  echo "building lean4export @ ${L4E_COMMIT:0:7} (once)" >&2
  mkdir -p .tools && rm -rf .tools/lean4export
  git clone -q https://github.com/leanprover/lean4export.git .tools/lean4export
  (cd .tools/lean4export && git checkout -q "$L4E_COMMIT" && lake build >/dev/null)
fi
actual=$(git -C .tools/lean4export rev-parse HEAD)
[ "$actual" = "$L4E_COMMIT" ] || { echo "lean4export cache is at $actual, expected $L4E_COMMIT; use a fresh .tools/lean4export cache" >&2; exit 1; }
echo "$PWD/$L4E"
