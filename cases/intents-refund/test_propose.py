"""Report a failed observation after an upgrade attempt as unknown, not uninstalled."""

import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import propose


class ProposalReporting(unittest.TestCase):
    def test_post_upgrade_process_failure_does_not_claim_unchanged_code(self):
        real_run = subprocess.run
        with tempfile.TemporaryDirectory(prefix="emet-proposal-report-") as folder:
            folder = Path(folder)
            candidate = folder / "candidate.rs"
            out = folder / "job"
            original = (propose.HERE / "upstream/tokens.rs").read_text()
            candidate.write_text(
                original.replace(
                    "balance_left.min(requested_refund)", "requested_refund.min(*deposited).min(balance_left)"
                )
            )
            calls = []

            def run(command, **kwargs):
                calls.append(command[0])
                if command[0] == "bash":
                    # Exercise the actual caller-source binding; only expensive
                    # compiler/chain work is replaced for this report regression.
                    return real_run([sys.executable, "cases/intents-refund/prepare.py"], **kwargs)
                return subprocess.CompletedProcess(command, 1 if command[0] == "node" else 0)

            with (
                patch.object(sys, "argv", ["propose", "--candidate", str(candidate), "--out", str(out)]),
                patch.object(propose.subprocess, "run", side_effect=run),
                contextlib.redirect_stdout(io.StringIO()),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                code = propose.main()
            result = json.loads((out / "result.json").read_text())
            self.assertEqual(calls, ["bash", "python3", "node"])
            self.assertEqual(code, 1)
            self.assertEqual(result["state"], "failed")
            self.assertIsNone(result["installed"])
            self.assertTrue(result["implementation_unchanged"])

    def test_outside_edit_never_reaches_build_or_chain(self):
        with tempfile.TemporaryDirectory(prefix="emet-proposal-refuse-") as folder:
            folder = Path(folder)
            candidate = folder / "candidate.rs"
            out = folder / "job"
            candidate.write_bytes(
                (propose.HERE / "upstream/tokens.rs")
                .read_bytes()
                .replace(b"*deposited = refund_amount;", b"*deposited = 0;")
            )
            with (
                patch.object(sys, "argv", ["propose", "--candidate", str(candidate), "--out", str(out)]),
                patch.object(propose.subprocess, "run") as run,
                contextlib.redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(propose.main(), 1)
            run.assert_not_called()
            result = json.loads((out / "result.json").read_text())
            self.assertEqual(result["state"], "refused")
            self.assertFalse(result["installed"])


if __name__ == "__main__":
    unittest.main()
