---
name: A check fails or a statement is wrong
about: A command of this repository does not end as AGENTS.md says, or the README says something the repository does not support
labels: bug
---

**The command, and where you ran it** (operating system, CPU, versions of Python and Node, with Docker or without)

**The result that AGENTS.md or the README states**

**The result that you got** (the last 30 lines of output)

**Is it about the deployment on testnet?** If yes, add the output of `python3 tools/check_live.py`.

A way to make the proof checker accept a false statement is a security report. Do not open an issue for it: see SECURITY.md.
