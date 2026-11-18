---
"@evorca/cli": minor
---

`evorca evaluate` runs several tasks at once with `--jobs`, runs a subset of rows with `--rows`, and resumes a stopped run with `--resume=<run ID>`. It rewrites `run.json` after every task, and each agent in the `agents` table sets its container's memory, `/tmp`, CPUs, processes, and default `jobs`.
