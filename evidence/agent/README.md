# Agent sessions on the wallet's bounties

Each claim and model has one directory. It holds:

- `Solution.lean`: the proof that the agent wrote.
- `delta.ndjson`: the exported proof bytes.
- `report.json`: the agent's own report.
- `transcript.jsonl`: the session as Claude Code wrote it with `--output-format stream-json`.

`agent/solve.py` produced them.

In the transcripts, `/Users/agent` replaces the home directory of the machine. We changed nothing else.
