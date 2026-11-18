# @evorca/cli

The `evorca` command. From the repository root, `pnpm evorca` runs it without a build or a publish step.

## Scope

- An interactive shell in the terminal, built with [OpenTUI](https://github.com/anomalyco/opentui), which `evorca` opens when it runs without arguments. It opens on a home screen with the evorca wordmark and an input line, then shows a transcript of the session above the input line. A footer shows the working directory and the version.
- The slash commands `/help` and `/exit`.
- `evorca fetch`, which downloads the answer keys and the telemetry of a benchmark's scenarios into `data/benchmarks/<benchmark>/<scenario>/` at the repository root, or reads them from dataset archives on disk.
- `evorca reproduce`, which downloads only the answer keys and checks that evorca reproduces the scores that a benchmark publishes. It keeps the scorer's checkout and environment in `.cache/` at the repository root.
- `evorca evaluate`, which runs an agent from `agents/` on a benchmark's scenarios, one Docker container per task and several tasks at a time, scores the answers, and keeps each run in `data/runs/<benchmark>/<scenario>/` at the repository root. A run that stops can resume from its last finished task. `--runs` repeats a run with the same settings. An agent that calls a model reaches the Anthropic API only through a proxy that holds the API key and the budgets.
- One benchmark, `openrca`, through [`@evorca/openrca`](../openrca/README.md).

## Non-goals

- An agent in the shell. Every message in the shell gets the same reply until one is connected.
- Benchmark logic. Each benchmark package owns its scenarios, its files, how to download them, and how to score them. The command only parses the command line and prints results.
- Configuration, themes, and mouse input.
- Publishing to npm. The package is private, and `pnpm evorca` runs its TypeScript source through tsx.

## Public API

The package exports no modules. Its interface is the command:

```sh
evorca
evorca fetch --benchmark=<benchmark> [--scenario=<scenario>...] [--archive=<path>...]
evorca reproduce --benchmark=<benchmark> [--scenario=<scenario>...] [--archive=<path>...]
evorca evaluate --benchmark=<benchmark> --agent=<agent> [--scenario=<scenario>...]
                [--runs=<count>] [--rows=<row>,...] [--jobs=<count>] [--model=<model>]
                [--effort=<effort>] [--budget-usd=<dollars>] [--task-budget-usd=<dollars>]
evorca evaluate --benchmark=<benchmark> --resume=<run ID> [--scenario=<scenario>...]
                [--jobs=<count>] [--budget-usd=<dollars>]
```

- Without arguments, `evorca` opens the [interactive shell](#use-the-shell).
- `--benchmark` is required. The only benchmark is `openrca`.
- `--scenario` names one scenario and can repeat. Without it, the command uses every scenario of the benchmark. The `openrca` scenarios are `bank`, `telecom`, `market-cloudbed-1`, and `market-cloudbed-2`.
- `--agent` is required by `evorca evaluate`, unless it resumes a run. The agents are `random` and [`react`](../../agents/react/README.md).
- `--archive` names a dataset archive on disk and can repeat. `evorca fetch` and `evorca reproduce` read the files of that archive from disk instead of downloading them, and check them in the same way. See [Fetch a scenario](#fetch-a-scenario).
- `--runs` sets how many complete runs `evorca evaluate` makes, one after another, with the same settings. Without it, the command makes one run. See [Repeat a run](#repeat-a-run).
- `--rows` limits `evorca evaluate` to some rows of each scenario's `query.csv`, counted from 0, such as `--rows=0,7,21` for a pilot. Without it, the command runs every task.
- `--jobs` sets how many tasks `evorca evaluate` runs at once. Without it, the command uses the `jobs` of the run it resumes, or else the agent's `jobs`.
- `--model` and `--effort` set the model that the agent calls and its effort. The only model is `claude-sonnet-5`, and its default effort is `high`. The efforts are `low`, `medium`, `high`, `xhigh`, and `max`.
- `--budget-usd` caps what the run spends on the model, in US dollars, and defaults to 50. `--task-budget-usd` caps what each task spends and defaults to 2.
- The four model flags apply only to an agent that calls a model.
- `--resume` continues the run with that ID. The run keeps its agent, seed, rows, and model settings. `--jobs` and `--budget-usd` can change. With `--scenario`, the command resumes only those scenarios of the run. Resuming one run of a `--runs` series finishes the whole series.
- `EVORCA_SEED`, a non-negative integer in the environment, sets the seed of `evorca evaluate`. Without it, the command picks a seed and prints it, or uses the seed of the run it resumes.
- `ANTHROPIC_API_KEY` in the environment is the API key for an agent that calls a model. `pnpm evorca` reads it from `.env` at the repository root if the file exists. The command removes it from its environment before it starts any process.
- `EVORCA_UPSTREAM_URL` replaces `https://api.anthropic.com` as the API that the model proxy calls, such as with a mock in a test.

`evorca fetch` prints one line for each file that is already present, and two lines for each file that it downloads: one when the download starts and one when it is done. A line has the status, the path, and the size in bytes. A `present` or `fetched` line also has the SHA-256:

```text
present  data/benchmarks/openrca/telecom/query.csv  20356 bytes  sha256 c2726ea18183a05c83dfb22796d20cb7a371ce4db51ce3da3fda3f6e793735b5
fetching  data/benchmarks/openrca/telecom/telemetry/2020_04_11/trace/trace_span.csv  1165827254 bytes
fetched  data/benchmarks/openrca/telecom/telemetry/2020_04_11/trace/trace_span.csv  1165827254 bytes  sha256 4a75e1ac9430d7b19b14f77dd985bef9e3252c46b59c8b2afa5dae9bcda788dd
```

`evorca reproduce` prints the same lines for the answer keys, then a report. It exits with code 1 if a score differs from the published score.

Both commands exit with code 1 and list the valid choices if the command, the benchmark, or a scenario is unknown. They also exit with code 1, and print the reason, if an `--archive` matches no archive of the benchmark, if a file on disk does not match its pinned hash, if the missing files need more than the free disk space, or if a download fails. The free-space message gives both sizes in GB. When Google Drive refuses a download because the file's quota is used up, the message names the archive, its link for a browser, and the command to run with `--archive` once you have downloaded it.

`evorca evaluate` prints one line per task, then the outcomes and the accuracy of each scenario. It exits with code 1 and lists the agents if `--agent` is missing or unknown. Before it runs any task, it exits with code 1 if a model flag is given for an agent that calls no model, if an agent that calls a model has no API key, if a scenario's data is missing, with the `evorca fetch` command that downloads it, if a row in `--rows` does not exist, if Docker does not answer, if a container cannot reach the model proxy, or if the run to resume is missing or has other settings. It names each setting that differs. It exits with code 1 for `--runs` together with `--resume`, because a resumed series keeps its number of runs.

## Use the shell

You need Node 26.4 or later, because OpenTUI calls its native library through `node:ffi`. Node 26.4 to 26.8 load `node:ffi` only with `--experimental-ffi`, and every Node 26 release prints an `ExperimentalWarning` when `node:ffi` loads. The `evorca` script passes the flag and hides the warning. Only the shell loads OpenTUI, so `evorca fetch` and `evorca reproduce` never load `node:ffi`. From the repository root, run:

```sh
pnpm evorca
```

The shell opens on the home screen. The wordmark is a panel of dots, like an LED display. Its dots switch on one at a time, and every few seconds a few of them dim for a moment. While the input line is empty, its placeholder types out example questions. Type a message and press Enter. After the first message, the transcript replaces the home screen. The transcript is a log. Each line you send appears in it, followed by the reply, and each entry starts with the local time and `you` or `evorca`. These commands are available:

- `/help` lists the commands.
- `/exit` closes evorca. ctrl+c does the same.

The shell paints the whole screen in grays on a near-black background, so it looks the same in light and dark terminals. When the terminal is narrower than 73 columns, the plain name replaces the wordmark. In the transcript view, nothing moves while the input line holds text, and the shell does no work until you type or resize the terminal. The shell needs an interactive terminal. When stdin or stdout is not one, as in `echo hi | pnpm evorca`, it prints `evorca needs an interactive terminal.` and exits with code 1.

## Fetch a scenario

You need network access to drive.usercontent.google.com. From the repository root, run:

```sh
pnpm evorca fetch --benchmark=openrca --scenario=bank
```

The command writes the answer keys, `query.csv` and `record.csv`, to `data/benchmarks/openrca/bank/` and the telemetry to `data/benchmarks/openrca/bank/telemetry/`. The telemetry of `bank` is 26.40 GB, and the telemetry of all four scenarios is 68.65 GB. A file that is already present and matches its pinned hash stays as it is, so a second run downloads nothing. To fetch all four scenarios, leave out `--scenario`.

Google Drive limits how often people can download a shared file. When Drive refuses a download, the command prints the archive to download in a browser and the command to run next. To read an archive that you downloaded, pass its path:

```sh
pnpm evorca fetch --benchmark=openrca --scenario=bank --archive=$HOME/Downloads/Bank.zip
```

The command needs no network then, and it checks each file as it does for a download. The [`@evorca/openrca` README](../openrca/README.md#download-an-archive-yourself) lists the archives, their sizes, and their links, and explains what to do when the browser also shows the "Quota exceeded" page.

## Reproduce the archive scores

OpenRCA publishes the predictions of its RCA-Agent and their scores in `rca/archive/`. `evorca reproduce --benchmark=openrca` scores those predictions with OpenRCA's own evaluator and checks that every score matches. The [`@evorca/openrca` README](../openrca/README.md#reproduce-the-archive-scores) explains the two stages of the check.

You need:

- Node 26.4 or later. `.nvmrc` pins Node 26.
- pnpm, through `npm install -g corepack` and `corepack enable`.
- [uv](https://docs.astral.sh/uv/). uv downloads Python 3.11 and the packages locked in `packages/openrca/evaluator/uv.lock`.
- git.
- Network access to github.com and drive.usercontent.google.com.

From a fresh clone, run:

```sh
pnpm install
pnpm evorca reproduce --benchmark=openrca
```

`evorca reproduce` first downloads the answer keys, `query.csv` and `record.csv`, of each scenario to `data/benchmarks/openrca/`, about 170 KB in all. It reads no telemetry, so it does not need the 68.65 GB that `evorca fetch` downloads. Then it checks out OpenRCA and creates the Python environment in `.cache/openrca/`. A second run skips the work that a previous run finished.

After the lines for the answer keys, `evorca reproduce` prints the pinned inputs and the Node, uv, and Python versions. Then it prints one block per scenario with the matches in each stage, the accuracy per difficulty, and each mismatch. The last block, `All scenarios`, gives the accuracy over the scenarios that the command checked. To check only some scenarios, name each one with `--scenario`. The [`@evorca/openrca` README](../openrca/README.md#reproduce-the-archive-scores) lists the expected result.

## Evaluate an agent

`evorca evaluate` runs an agent on every task of a scenario and scores its answers with OpenRCA's own evaluator. The `random` agent draws its answers from the candidates at random, so its accuracy is the chance level that another agent must beat.

You need what [`evorca reproduce`](#reproduce-the-archive-scores) needs, the answer keys in `data/benchmarks/openrca/`, and a running Docker daemon. On macOS, start Docker Desktop. From the repository root, run:

```sh
EVORCA_SEED=7 pnpm evorca evaluate --benchmark=openrca --scenario=telecom --agent=random
```

The first run builds the agent's image from `agents/random/`. The command prints the image, the seed, the git commit, and the Node and Docker versions. Then it runs each task in its own container, prints one line per task with the outcome and the time, and prints the accuracy:

```text
Agent random, image evorca-agent-random:<folder hash>, sha256:<image ID>
Seed 7. Set EVORCA_SEED=7 to repeat this run.
git <commit>
node v26.13.1, docker 28.2.2, daemon 28.2.2
Run 20261117T121537Z-random, 1 task at a time.

telecom: 51 tasks, run folder data/runs/openrca/telecom/20261117T121537Z-random
telecom 1/51 task_2 answered 0.22 s
telecom 2/51 task_4 answered 0.21 s

telecom: 51 answered
  easy      24 tasks  strict  12.50%  partial  12.50%
  middle    18 tasks  strict   0.00%  partial   2.78%
  hard       9 tasks  strict   0.00%  partial  11.00%
  total     51 tasks  strict   5.88%  partial   8.80%
```

A run with the same seed writes the same predictions, byte for byte, whatever its `--jobs`. Without `EVORCA_SEED`, the command picks a seed and prints it. One seed is one sample of the agent's accuracy, so compare agents over several runs with [`--runs`](#repeat-a-run).

With `--jobs=4`, four containers run at once, and the lines come in the order that the tasks finish. If the agent's tasks together ask for more memory than Docker has, the command prints a warning before the first task. On Docker Desktop, set the memory under **Settings** > **Resources**.

For a pilot, run a few rows with `--rows=0,7,21`. The command still writes a `predictions.csv` row for every task, because the evaluator matches predictions to tasks by position, and gives the other rows the empty prediction `{}`. The accuracy and `scores.json` cover only the rows of the run.

### Evaluate an agent that calls a model

An agent with `needsModel` calls Claude through the [model proxy](#reach-the-model). Put the API key in `.env` at the repository root. Git ignores the file.

```sh
ANTHROPIC_API_KEY=<key>
```

Then run a pilot with a small budget:

```sh
pnpm evorca evaluate --benchmark=openrca --scenario=telecom --agent=<agent> --rows=0,7,21 --budget-usd=5
```

The command prints the model, the effort, and the budgets. Each task line adds what the task spent and what the run has spent so far. The last line gives the run's total:

```text
Model claude-sonnet-5, effort high, $5 for the run, $2 per task, via https://api.anthropic.com
Run 20261117T121537Z-<agent>, 2 tasks at a time.

telecom: 3 tasks, run folder data/runs/openrca/telecom/20261117T121537Z-<agent>
telecom 1/3 task_1 answered 84.12 s, $0.4120, run $0.4120

The run has spent $1.2345 of the $5 budget on 57 model requests.
```

The proxy prices each response from its `usage`, with the price table in `src/models.ts`. The table records its source and the date it was checked. Cache writes of five minutes and of one hour have their own prices.

The proxy checks both budgets before it forwards a request. Once the task has spent `--task-budget-usd`, or the run has spent `--budget-usd`, the proxy answers each request of the task with HTTP 403 and the error type `evorca_budget_exhausted`. The agent should then write its best answer. The run's budget covers every scenario of the run, even on a resume of only some of them.

The proxy forwards a task's requests one at a time, so each check counts the cost of every earlier response. The cost of a response is known only after it arrives, so a task can pass its budget by one request, and the run by one request per running task.

Once the run's budget is spent, each task that has not started gets the outcome `budget-exhausted`. So does a running task that the run's budget denies a request. Which running tasks the run's budget cuts short depends on timing, so their answers are not scored. A resume with a larger `--budget-usd` runs them again. A task that spends its own `--task-budget-usd` keeps its answer, because that budget is the same for every task.

### Resume a run

To stop a run, press ctrl+c. The command starts no more tasks and removes the run's containers. It waits for the model requests in flight, so the run records their cost. It records each task that was running with the outcome `stopped` and what its `requests.jsonl` says it spent, so the totals in `run.json` match the request logs at once. Then it removes the run's networks and prints the command that resumes the run. Press ctrl+c again to stop at once.

```sh
pnpm evorca evaluate --benchmark=openrca --resume=20261117T121537Z-random
```

The resumed run skips each task that has an outcome in `run.json`, except `budget-exhausted` and `stopped`. It runs the other tasks again from the start, so it first deletes their folders. What a deleted task spent on the model stays in `run.json` under `abandoned` and counts toward the budget. The proxy records a request's cost when the response arrives. So a run that is killed, or stopped with a second ctrl+c, has no recorded cost for its requests in flight. A killed run also records no `stopped` tasks, so its `run.json` lacks what its running tasks spent until the resume reads their `requests.jsonl`. The command removes containers and networks that a killed run left behind.

It refuses to resume if the agent's folder, its entry in the `agents` table, `EVORCA_SEED`, `--rows`, or the model settings differ from the run's. The model settings are `--model`, `--effort`, `--task-budget-usd`, `EVORCA_UPSTREAM_URL`, and the price table. To finish a run that spent its budget, resume it with a larger `--budget-usd`.

### Repeat a run

Claude Sonnet 5 has no temperature setting, so one run of a model agent is one sample of its accuracy. To report a mean and a spread, make several runs with `--runs`:

```sh
pnpm evorca evaluate --benchmark=openrca --scenario=telecom --agent=react --runs=5
```

The command makes five complete runs, one after another, with the same settings. `--jobs` still sets how many tasks of a run go at once, and each run has its own `--budget-usd`. The runs form a series. Run `k` of series `<id>` has the run ID `<id>-<k>` and the seed of run 1 plus `k - 1`. So `EVORCA_SEED=7` gives the seeds 7 to 11, and the same command with the same seed repeats every run. Without `EVORCA_SEED`, the command picks the first seed and prints it. Each `run.json` records its `seed` and its place in the `series`. Each task line starts with the run, such as `run 2/5 telecom 3/51 task_2 answered 84.12 s`.

Each run must keep the settings of the other runs of its series. If the agent's folder changes while a series runs, the next run does not start, and the command names the setting that differs.

To finish a series that stopped, resume any of its runs. The command prints the command to use when the series starts, and again when ctrl+c stops it:

```sh
pnpm evorca evaluate --benchmark=openrca --resume=20261118T062557Z-react-1
```

The resume skips each finished run. It resumes the unfinished run from its last finished task, as for a single run, and then starts each run that has not started. It works the same after ctrl+c, a crash, or a killed process. If you set `EVORCA_SEED` for the resume, set it to the first seed of the series, as when the series started.

### Read a run

Each run of a scenario lands in `data/runs/<benchmark>/<scenario>/<run ID>/`. The run ID is the start time in UTC and the agent's name, such as `20261117T121537Z-random`. A run of several scenarios uses one run ID for all of them:

```text
<run ID>/
  run.json         what ran, and the outcome and time of each task
  predictions.csv  the answers, in the file that the evaluator scores
  scores.json      the evaluator's score of each task and the accuracy per difficulty
  tasks/<row>/
    task.json      the task as the agent read it
    out/           what the agent wrote, such as prediction.json
    log.txt        the container's stdout and stderr
    requests.jsonl each model request of the task, if the agent calls a model
```

The command writes `run.json` before the first task and again after each task. It writes a new file and renames it into place, so `run.json` is always whole. `run.json` holds:

- `runId`, `benchmark`, and `scenario`.
- `series`, only for a run of a `--runs` series: the series `id`, the number of this `run`, and the number of `runs`.
- `agent`: the `name`, `seesCandidates`, `needsTelemetry`, `needsModel`, `timeoutSeconds`, `resources`, the `image` tag, and the `imageId`.
- `seed`.
- `rows`: the rows of the run, or `null` for every row.
- `model`: the model `id`, the `effort`, the `taskBudgetUsd`, the `upstreamUrl`, and the `prices`, or `null` for an agent that calls no model. `prices` names the price `table`, its `source`, and the date it was `checkedAt`, and gives `usdPerMTok` for each kind of token.
- `budgetUsd`: the run's budget, or `null`.
- `jobs`: how many tasks ran at once.
- `git`: the `commit` and whether the checkout was `dirty`, with uncommitted changes.
- `versions`: Node, and the Docker client and daemon.
- `pinnedInputs`: the OpenRCA commit, the Drive archives, and the SHA-256 of each answer key.
- `startedAt`, in UTC.
- `resumes`: the `startedAt`, `git`, and `versions` of each later session of the run.
- `endedAt`, in UTC, or `null` until the run is scored.
- `tasks`: the `row`, `taskIndex`, `outcome`, `exitCode`, `seconds`, and `usage` of each task, in row order.
- `abandoned`: the `row` and `usage` of each task that a stopped session started and a resumed session deleted.
- `usage`: the usage of the whole run, `abandoned` included.

A `usage` is `null` for an agent that calls no model. Otherwise it counts the `requests` that the proxy forwarded, the `upstreamErrors` among them, and the `deniedRequests`. It says whether a budget denied a request, in `budgetExhausted`, and how long the API took, in `modelSeconds`. It sums the `inputTokens`, `outputTokens`, `cacheCreation5mInputTokens`, `cacheCreation1hInputTokens`, and `cacheReadInputTokens`, and gives the `costUsd`.

Each line of `requests.jsonl` is one request. A forwarded request has the time `at`, the HTTP `status`, the `seconds` it took, the API's `requestId`, the `error` type or `null`, the `tokens`, and the `costUsd`. A denied request has `at`, `status`, and `error`. The file holds no prompt, no response, and no key.

## Run an agent in a container

Each agent has a folder, `agents/<name>/` at the repository root, with a `Dockerfile`, and an entry in the `agents` table in `src/agents.ts`:

| Field            | Meaning                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `seesCandidates` | `/task.json` lists the candidate components and reasons of the scenario.         |
| `needsTelemetry` | The container gets the scenario's telemetry at `/data`.                          |
| `needsModel`     | The container calls Claude through the [model proxy](#reach-the-model).          |
| `timeoutSeconds` | `evorca evaluate` kills the container of a task that runs longer than this time. |
| `resources`      | The container's `memoryMiB`, `tmpMiB` for `/tmp`, `cpus`, and `pids`.            |
| `jobs`           | How many tasks run at once without `--jobs`.                                     |

RCA-Agent sees the candidates, so an agent with `seesCandidates` answers under the same conditions. The [`@evorca/openrca` README](../openrca/README.md#show-an-agent-the-candidates) explains the choice.

`evorca evaluate` tags the agent's image `evorca-agent-<name>:<folder hash>`. The hash covers every file in the folder outside `node_modules`, so a change to a file builds a new image. The containers run the image by its ID, which `run.json` records.

The container of a task sees:

- `/task.json`, read-only, with the `scenario`, the `row`, the `taskIndex`, the `instruction`, and, if the agent sees candidates, the `candidates` with their `components` and `reasons`. It never holds the scoring points.
- `/out`, writable. The agent writes its answer to `/out/prediction.json` as OpenRCA prediction JSON, such as `{"1": {"root cause occurrence datetime": "2020-04-11 00:05:00", "root cause component": "docker_003", "root cause reason": "CPU fault"}}`.
- `/data`, read-only, only if the agent needs telemetry. It is `data/benchmarks/openrca/<scenario>/telemetry/`. The container never sees `query.csv` or `record.csv`, which hold the answers.
- `/tmp`, a folder in memory of `tmpMiB`. Its files count toward the container's memory.
- `EVORCA_SEED`, the seed of the run, and `EVORCA_TASK_TIMEOUT_SECONDS`, the agent's `timeoutSeconds`.
- If the agent needs a model, `ANTHROPIC_BASE_URL`, the URL of the model proxy, and `ANTHROPIC_API_KEY`, a token that the proxy accepts only while the task runs. The token is never the real API key. `EVORCA_MODEL` and `EVORCA_EFFORT` name the run's model and effort, and `EVORCA_TASK_BUDGET_USD` gives the task's budget.

An agent without `needsModel` gets no network. Every container has a read-only root file system. It runs as user `65534:65534` with no Linux capabilities and `no-new-privileges`, and it gets the memory, CPUs, and processes of the agent's `resources`. The `random` agent gets 1024 MiB of memory, a 64 MiB `/tmp`, one CPU, and at most 128 processes, and it runs one task at a time. The `react` agent gets 3072 MiB, a 1024 MiB `/tmp`, two CPUs, and 256 processes for an hour, and it runs two tasks at a time, so their 6 GiB fit in a Docker machine of 8 GB. Each container carries the label `evorca.run=<run ID>`.

Each task ends with one outcome. Only `answered` scores the agent's answer. Every other outcome scores the empty prediction `{}`, which scores 0.

| Outcome              | When                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `answered`           | The container exits with code 0, and `/out/prediction.json` is a prediction. |
| `no-prediction`      | The container exits with code 0, and `/out/prediction.json` does not exist.  |
| `invalid-prediction` | The container exits with code 0, and `/out/prediction.json` is not valid.    |
| `nonzero-exit`       | The container exits with another code.                                       |
| `timeout`            | `evorca evaluate` kills the container at the agent's timeout.                |
| `budget-exhausted`   | The run's model budget ran out before the task started or while it ran.      |
| `stopped`            | ctrl+c or SIGTERM stopped the run while the task ran.                        |

If Docker cannot start a container, `docker run` exits with code 125, and `evorca evaluate` stops and prints the container's log.

### Reach the model

An agent with `needsModel` reaches one endpoint, the model proxy at `ANTHROPIC_BASE_URL`. The proxy runs inside `evorca evaluate` and listens on the host's 127.0.0.1. One relay container per run, `evorca-<run ID>-relay`, forwards TCP from its port 8080 to the proxy through `host.docker.internal`. Each task gets its own internal Docker network, which holds only the task's container and the relay, by the name `evorca-proxy`. The network has no gateway address. The task's container resolves no other name and reaches no other address, so it cannot reach the internet, the host, or Docker's virtual machine.

The command checks this. It refuses a task network that Docker gave a gateway address. Before the first task, a container on such a network must get an answer from the proxy, find no default route, fail to resolve `api.anthropic.com`, and fail to reach `1.1.1.1:443`. After each task, the relay must still run. Otherwise the run stops, and a resume runs the task again.

This needs Docker Desktop, where `host.docker.internal` reaches the host's 127.0.0.1. On Linux, the check fails before any task.

The proxy forwards only `POST /v1/messages` without streaming, and only with the token of a running task. It takes the token from `x-api-key` or `Authorization: Bearer`. It sends the real API key upstream in place of the token, with the body that it checked, serialized again. It denies any other request with an error in the API's shape, `{"type":"error","error":{"type":"...","message":"..."}}`:

| Status | Type                      | When                                                                                                                                                    |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `authentication_error`    | The token is not the token of a running task.                                                                                                           |
| 404    | `not_found_error`         | The request is not `POST /v1/messages`.                                                                                                                 |
| 403    | `evorca_budget_exhausted` | The task or the run has spent its budget.                                                                                                               |
| 413    | `request_too_large`       | The body is larger than 32 MiB.                                                                                                                         |
| 429    | `rate_limit_error`        | The task already has 4 requests in flight.                                                                                                              |
| 400    | `invalid_request_error`   | The request asks for streaming, another model, another effort, a beta feature, a server tool, MCP servers, a URL source, or inference outside `global`. |

A request sets its effort in `output_config.effort`. Without it, the request uses the model's default effort, which must then be the run's effort. Server tools, MCP servers, and URL sources would let the API reach the internet for the agent. So the proxy forwards only custom tools and the bash, text editor, and memory tools, which the agent runs itself. The proxy passes the API's own errors through, such as 429 and 529, with their `retry-after` headers, so the SDK retries them. The proxy's own errors carry `x-should-retry: false` for a 4xx and `true` for a 5xx, so the SDK retries only a 5xx. The exception is a response that takes longer than 15 minutes. The proxy answers it with 504 `timeout_error` and no retry, because a retry would take as long. Ask for fewer `max_tokens`.
