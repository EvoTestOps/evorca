---
"@evorca/cli": minor
---

Let `evorca evaluate` run an agent that calls Claude. An agent with `needsModel` reaches only a model proxy on the host, through a relay container and an internal network per task. The proxy holds the API key, which it reads from `ANTHROPIC_API_KEY` or `.env`, and gives each task its own token. It forwards only `POST /v1/messages` for the run's model and effort, and it denies streaming, beta features, server tools, MCP servers, and URL sources. It records each task's requests, tokens, and cost in `requests.jsonl` and `run.json`, and it answers 403 `evorca_budget_exhausted` once the task or the run has spent its budget. The new flags are `--model`, `--effort`, `--budget-usd`, and `--task-budget-usd`. Tasks that the run's budget keeps from starting get the outcome `budget-exhausted` and run again on resume.
