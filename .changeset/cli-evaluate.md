---
"@evorca/cli": minor
"@evorca/agent-random": minor
---

`pnpm evorca evaluate --benchmark=openrca --agent=random` runs an agent on each OpenRCA task in its own Docker container, scores the answers with the official evaluator, and keeps the run in `data/runs/openrca/<scenario>/<run ID>/`. The `random` agent answers at chance level, and `EVORCA_SEED` repeats its answers exactly.
