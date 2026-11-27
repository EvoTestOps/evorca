# @evorca/agent-react

The `react` agent, the baseline of an evorca evaluation. Claude investigates the telemetry in a ReAct loop with a bash tool, and reports the root causes with a `submit_answer` tool. The agent keeps no memory between tasks and does not improve itself, so it measures what the same model and tools do without evorca.

## Scope

- Answering an OpenRCA task from the telemetry. The model runs shell commands, Python, pandas, and DuckDB over `/data`, and submits one root cause for each failure.
- Giving the model the same domain knowledge that RCA-Agent, OpenRCA's published baseline, gives its model. `background.json` holds it, and a script makes it from RCA-Agent's prompts at the pinned OpenRCA commit.
- Recording each task for analysis. The agent writes every model response and every tool call as it happens, and a summary of the steps, the tokens, and the cost.

## Non-goals

- Domain hints beyond RCA-Agent's prompt. The prompt is not tuned on the answer keys, and the agent never reads `query.csv` or `record.csv`.
- Streaming, context compaction, or memory between tasks.
- Enforcing the budget. The model proxy refuses requests past the budget. The agent only wraps up before that point.

## Public API

The image runs `node src/main.ts`, as the [container contract](../../packages/cli/README.md#run-an-agent-in-a-container) describes. Node 26 runs the TypeScript files as they are, so the image has no build step.

The container needs:

- `/task.json`, read-only. The agent uses the `instruction`, the `taskIndex`, and, if present, the `candidates`.
- `/data`, read-only, the scenario's telemetry.
- `/out`, writable.
- `/tmp`, writable, where the bash session starts. Files there count toward the container's memory.
- A network that reaches the Messages API at `ANTHROPIC_BASE_URL`, with the key in `ANTHROPIC_API_KEY`.

The environment:

| Variable                      | Meaning                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `EVORCA_MODEL`                | The model, `claude-sonnet-5` by default. The agent knows the prices of this model.    |
| `EVORCA_EFFORT`               | `low`, `medium`, `high`, `xhigh`, or `max`. The default is `high`.                    |
| `EVORCA_TASK_BUDGET_USD`      | Optional. At 80% of this cost, the agent asks the model for its answer.               |
| `EVORCA_TASK_TIMEOUT_SECONDS` | Optional. At 80% of this time, the agent asks the model for its answer.               |
| `EVORCA_SEED`                 | Recorded in the summary. The model takes no seed, so two runs can answer differently. |

The bash session gets the same environment without the `ANTHROPIC_` and `EVORCA_` variables.

The agent writes three files to `/out`:

- `prediction.json`, the answer as OpenRCA prediction JSON. The agent writes it when the model submits a valid answer, or, when the task ends without one, the valid fields of the last answer that the agent rejected. Without either, the file does not exist.
- `trajectory.jsonl`, one JSON line per event: the task with the system prompt and the tools, each message to the model, each response with its usage and stop reason, each tool call with its input and output, and API errors.
- `summary.json`, how the task ended (`stopCause`), whether the answer was submitted, the steps, the token usage, the estimated cost, the model, the effort, and the SHA-256 of the system prompt and the tools.

The process exits with 0 whenever the loop ends, with or without an answer. It exits with 1 only if the agent itself fails.

## The loop

Each request sends the same system prompt and tools, and appends to the same history, so the prompt cache serves every earlier turn. Thinking is adaptive, and its summaries go to the trajectory.

| Limit                      | Value               | Reason                                                                                   |
| -------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| Tool calls                 | 50                  | RCA-Agent runs at most 25 controller steps, and each step can run code twice.            |
| Time per command           | 120 s               | RCA-Agent stops a cell after 60 s on two CPUs, as many as the container has.             |
| Output per command         | 16,000 characters   | Longer output keeps its start and its end.                                               |
| Output tokens per response | 16,000, then 32,000 | A response cut off at the limit is discarded and asked again once with the larger limit. |

After the last tool call, at 80% of the budget, or at 80% of the time, the agent refuses commands and asks for the answer. A model that ends its turn without an answer is asked once to submit. A refusal, a full context window, or an API error ends the task. The proxy's `evorca_budget_exhausted` 403 is one such error.

The model proxy ends a request after 15 minutes with a 504, which ends the task as an API error. The agent waits 16 minutes for each response, because the SDK retries a request that it times out, and the proxy may still serve that request. 32,000 output tokens is the most that the SDK, at its planning rate of 128,000 tokens an hour, expects to finish in 15 minutes.

## Results

On the 51 tasks of OpenRCA's `telecom` scenario, with `claude-sonnet-5` at effort `high`, the agent scores 42.81% strict accuracy and 56.72% partial accuracy, the mean of six runs. [`results/openrca/telecom/`](../../results/openrca/telecom/README.md) holds the runs, the spread, and the commands that print the tables and make the runs again.

## Update the background

```sh
pnpm --filter @evorca/agent-react extract-background
```

The script checks out OpenRCA at the pinned commit in `.cache/` and writes `background.json`. It fails if RCA-Agent's prompts changed where it edits them, or if their candidates differ from `@evorca/openrca`. Its module comment lists each edit.

## Dependencies

The image installs pinned versions from two lockfiles, because it builds without the workspace:

- `package-lock.json`, for `npm ci`. Make it again with `npm install --package-lock-only` in a copy of the folder outside the workspace.
- `requirements.txt`, Python packages with hashes. Make it again from `requirements.in` with the `uv pip compile` command at its top.

## Tests

`pnpm test` runs the loop against a local mock of the Messages API, through the real SDK.

`pnpm --filter @evorca/agent-react smoke` builds the image and runs one task in a container with the runner's restrictions, against the mock on an internal Docker network, over synthetic telemetry. It needs Docker.
