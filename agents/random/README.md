# @evorca/agent-random

The `random` agent, the chance-level floor of an evorca evaluation. `pnpm evorca evaluate --agent=random` runs it in a Docker container, one task at a time.

## Scope

- Answering an OpenRCA task without telemetry. For each failure that the instruction counts, the agent draws a minute uniformly from the instruction's time window, and a component and a reason uniformly from the candidates in `/task.json`.
- Repeating a run exactly. Each draw depends only on `EVORCA_SEED`, the scenario, and the row.

## Non-goals

- Reading the telemetry or the answer keys. The agent sees only `/task.json`.
- Answering only the fields that a task asks for. The evaluator ignores the other fields.

## Public API

The image runs `node random.ts`, which reads `/task.json` and writes `/out/prediction.json`, as the [container contract](../../packages/cli/README.md#run-an-agent-in-a-container) describes. Node 26 runs the TypeScript file as it is, so the image has no build step. `random.ts` also exports two functions for its tests:

- `readWindow(instruction)` returns the time window of an instruction and the number of failures in it. It reads the first date, such as `March 6, 2021`, and the first two times, such as `23:30` and `00:00`. When the second time is not later than the first, the window ends on the next day.
- `answer(task, seed)` returns the agent's answer to a task as OpenRCA prediction JSON.
