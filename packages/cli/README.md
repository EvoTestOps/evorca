# @evorca/cli

The `evorca` command. From the repository root, `pnpm evorca` runs it without a build or a publish step.

## Scope

- An interactive shell in the terminal, built with [OpenTUI](https://github.com/anomalyco/opentui), which `evorca` opens when it runs without arguments. It shows the evorca banner, the version and the working directory, a transcript of the session, and an input box at the bottom of the screen.
- The slash commands `/help` and `/exit`.
- `evorca fetch`, which downloads the answer keys and the telemetry of a benchmark's scenarios into `data/benchmarks/<benchmark>/<scenario>/` at the repository root.
- `evorca reproduce`, which downloads only the answer keys and checks that evorca reproduces the scores that a benchmark publishes. It keeps the scorer's checkout and environment in `.cache/` at the repository root.
- `evorca evaluate`, which runs an agent from `agents/` on a benchmark's scenarios, one Docker container per task, scores the answers, and keeps each run in `data/runs/<benchmark>/<scenario>/` at the repository root.
- One benchmark, `openrca`, through [`@evorca/openrca`](../openrca/README.md).

## Non-goals

- An agent in the shell. Every message in the shell gets the same reply until one is connected.
- Parallel tasks and resumed runs. `evorca evaluate` runs one task at a time, and a run that stops starts again from the first task.
- Benchmark logic. Each benchmark package owns its scenarios, its files, how to download them, and how to score them. The command only parses the command line and prints results.
- Configuration, themes, and mouse input.
- Publishing to npm. The package is private, and `pnpm evorca` runs its TypeScript source through tsx.

## Public API

The package exports no modules. Its interface is the command:

```sh
evorca
evorca fetch --benchmark=<benchmark> [--scenario=<scenario>...]
evorca reproduce --benchmark=<benchmark> [--scenario=<scenario>...]
evorca evaluate --benchmark=<benchmark> --agent=<agent> [--scenario=<scenario>...]
```

- Without arguments, `evorca` opens the [interactive shell](#use-the-shell).
- `--benchmark` is required. The only benchmark is `openrca`.
- `--scenario` names one scenario and can repeat. Without it, the command uses every scenario of the benchmark. The `openrca` scenarios are `bank`, `telecom`, `market-cloudbed-1`, and `market-cloudbed-2`.
- `--agent` is required by `evorca evaluate`. The only agent is `random`.
- `EVORCA_SEED`, a non-negative integer in the environment, sets the seed of `evorca evaluate`. Without it, the command picks a seed and prints it.

`evorca fetch` prints one line for each file that is already present, and two lines for each file that it downloads: one when the download starts and one when it is done. A line has the status, the path, and the size in bytes. A `present` or `fetched` line also has the SHA-256:

```text
present  data/benchmarks/openrca/telecom/query.csv  20356 bytes  sha256 c2726ea18183a05c83dfb22796d20cb7a371ce4db51ce3da3fda3f6e793735b5
fetching  data/benchmarks/openrca/telecom/telemetry/2020_04_11/trace/trace_span.csv  1165827254 bytes
fetched  data/benchmarks/openrca/telecom/telemetry/2020_04_11/trace/trace_span.csv  1165827254 bytes  sha256 4a75e1ac9430d7b19b14f77dd985bef9e3252c46b59c8b2afa5dae9bcda788dd
```

`evorca reproduce` prints the same lines for the answer keys, then a report. It exits with code 1 if a score differs from the published score.

Both commands exit with code 1 and list the valid choices if the command, the benchmark, or a scenario is unknown. They also exit with code 1, and print the reason, if a file on disk does not match its pinned hash, if the missing files need more than the free disk space, or if a download fails. The free-space message gives both sizes in GB.

`evorca evaluate` prints one line per task, then the outcomes and the accuracy of each scenario. It exits with code 1 and lists the agents if `--agent` is missing or unknown. Before it runs any task, it exits with code 1 if a scenario's data is missing, with the `evorca fetch` command that downloads it, or if Docker does not answer.

## Use the shell

You need Node 26.4 or later, because OpenTUI calls its native library through `node:ffi`. Node 26.4 to 26.8 load `node:ffi` only with `--experimental-ffi`, and every Node 26 release prints an `ExperimentalWarning` when `node:ffi` loads. The `evorca` script passes the flag and hides the warning. Only the shell loads OpenTUI, so `evorca fetch` and `evorca reproduce` never load `node:ffi`. From the repository root, run:

```sh
pnpm evorca
```

Type a message and press Enter. Each line you send appears in the transcript, followed by the reply. These commands are available:

- `/help` lists the commands.
- `/exit` closes evorca. ctrl+c does the same.

When the terminal is narrower than the banner, the plain name replaces it. The shell needs an interactive terminal. When stdin or stdout is not one, as in `echo hi | pnpm evorca`, it prints `evorca needs an interactive terminal.` and exits with code 1.

## Fetch a scenario

You need network access to drive.usercontent.google.com. From the repository root, run:

```sh
pnpm evorca fetch --benchmark=openrca --scenario=bank
```

The command writes the answer keys, `query.csv` and `record.csv`, to `data/benchmarks/openrca/bank/` and the telemetry to `data/benchmarks/openrca/bank/telemetry/`. The telemetry of `bank` is 26.40 GB, and the telemetry of all four scenarios is 68.65 GB. A file that is already present and matches its pinned hash stays as it is, so a second run downloads nothing. To fetch all four scenarios, leave out `--scenario`.

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

telecom: 51 tasks, run folder data/runs/openrca/telecom/20261117T121537Z-random
telecom 1/51 task_2 answered 0.22 s
telecom 2/51 task_4 answered 0.21 s

telecom: 51 answered
  easy      24 tasks  strict  12.50%  partial  12.50%
  middle    18 tasks  strict   0.00%  partial   2.78%
  hard       9 tasks  strict   0.00%  partial  11.00%
  total     51 tasks  strict   5.88%  partial   8.80%
```

A run with the same seed writes the same predictions, byte for byte. Without `EVORCA_SEED`, the command picks a seed and prints it. One seed is one sample of the agent's accuracy, so compare agents over several seeds.

### Read a run

Each run of a scenario lands in `data/runs/<benchmark>/<scenario>/<run ID>/`. The run ID is the start time in UTC and the agent's name, such as `20261117T121537Z-random`:

```text
<run ID>/
  run.json         what ran, and the outcome and time of each task
  predictions.csv  the answers, in the file that the evaluator scores
  scores.json      the evaluator's score of each task and the accuracy per difficulty
  tasks/<row>/
    task.json      the task as the agent read it
    out/           what the agent wrote, such as prediction.json
    log.txt        the container's stdout and stderr
```

`run.json` holds:

- `runId`, `benchmark`, and `scenario`.
- `agent`: the `name`, `seesCandidates`, `needsTelemetry`, `timeoutSeconds`, the `image` tag, and the `imageId`.
- `seed`.
- `git`: the `commit` and whether the checkout was `dirty`, with uncommitted changes.
- `versions`: Node, and the Docker client and daemon.
- `pinnedInputs`: the OpenRCA commit, the Drive archives, and the SHA-256 of each answer key.
- `startedAt` and `endedAt`, in UTC.
- `tasks`: the `row`, `taskIndex`, `outcome`, `exitCode`, and `seconds` of each task.

## Run an agent in a container

Each agent has a folder, `agents/<name>/` at the repository root, with a `Dockerfile`, and an entry in the `agents` table in `src/agents.ts`:

| Field            | Meaning                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `seesCandidates` | `/task.json` lists the candidate components and reasons of the scenario.         |
| `needsTelemetry` | The container gets the scenario's telemetry at `/data`.                          |
| `timeoutSeconds` | `evorca evaluate` kills the container of a task that runs longer than this time. |

RCA-Agent sees the candidates, so an agent with `seesCandidates` answers under the same conditions. The [`@evorca/openrca` README](../openrca/README.md#show-an-agent-the-candidates) explains the choice.

`evorca evaluate` tags the agent's image `evorca-agent-<name>:<folder hash>`. The hash covers every file in the folder outside `node_modules`, so a change to a file builds a new image. The containers run the image by its ID, which `run.json` records.

The container of a task sees:

- `/task.json`, read-only, with the `scenario`, the `row`, the `taskIndex`, the `instruction`, and, if the agent sees candidates, the `candidates` with their `components` and `reasons`. It never holds the scoring points.
- `/out`, writable. The agent writes its answer to `/out/prediction.json` as OpenRCA prediction JSON, such as `{"1": {"root cause occurrence datetime": "2020-04-11 00:05:00", "root cause component": "docker_003", "root cause reason": "CPU fault"}}`.
- `/data`, read-only, only if the agent needs telemetry. It is `data/benchmarks/openrca/<scenario>/telemetry/`. The container never sees `query.csv` or `record.csv`, which hold the answers.
- `/tmp`, a 64 MB folder in memory.
- `EVORCA_SEED`, the seed of the run.

The container has no network and a read-only root file system. It runs as user `65534:65534` with no Linux capabilities and `no-new-privileges`, and it gets 1 GB of memory, one CPU, and at most 128 processes.

Each task ends with one outcome. Only `answered` scores the agent's answer. Every other outcome scores the empty prediction `{}`, which scores 0.

| Outcome              | When                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `answered`           | The container exits with code 0, and `/out/prediction.json` is a prediction. |
| `no-prediction`      | The container exits with code 0, and `/out/prediction.json` does not exist.  |
| `invalid-prediction` | The container exits with code 0, and `/out/prediction.json` is not valid.    |
| `nonzero-exit`       | The container exits with another code.                                       |
| `timeout`            | `evorca evaluate` kills the container at the agent's timeout.                |

If Docker cannot start a container, `docker run` exits with code 125, and `evorca evaluate` stops and prints the container's log.
