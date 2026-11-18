---
"@evorca/cli": minor
"@evorca/agent-react": patch
---

`evorca evaluate --agent=react` runs the ReAct baseline through the model proxy, with 3 GiB of memory, a 1 GiB `/tmp`, two CPUs, and two tasks at a time. Every container now gets its timeout in `EVORCA_TASK_TIMEOUT_SECONDS`, so the agent wraps up before the runner kills it. The agent asks for at most 32,000 output tokens and waits 16 minutes for a response, so the proxy's 15-minute limit always ends a slow request first, with a logged 504 instead of a silent client retry.
