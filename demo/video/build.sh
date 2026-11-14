#!/usr/bin/env bash
# Build docs/assets/demo.mp4 and docs/assets/hero.png from the page, and a sheet of frames to look at
# (run-output/video/contact-sheet.png, not kept in the repository).
#
#   demo/video/build.sh                     serve this checkout on a free local port and record its page
#   demo/video/build.sh --url <page url>    record the page as it is served elsewhere (the hosted one, say)
#   options, passed on to record.cjs:  --audio-dir <dir>  --skip <scene,scene>  --only hero  --draft
#
# Needs Node 20+, Python 3, ffmpeg with libx264, and Playwright with its Chromium (`npx playwright install
# chromium`). While it records, the page asks NEAR testnet (read-only), and one scene runs ./verify.sh --live.
# The scenes, their captions and their actions are data: demo/video/script.json.
set -euo pipefail
cd "$(dirname "$0")/../.."
case " $* " in *" --url "*) ;; *)
  PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  python3 -m http.server "$PORT" --bind 127.0.0.1 > /dev/null 2>&1 & SERVER=$!
  trap 'kill $SERVER 2>/dev/null' EXIT
  sleep 1
  set -- --url "http://127.0.0.1:$PORT/demo/web/patches.html" "$@" ;;
esac
node demo/video/record.cjs "$@"
