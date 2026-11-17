# @evorca/openrca

OpenRCA benchmark support for evorca. It reads [OpenRCA](https://github.com/microsoft/OpenRCA) tasks, writes predictions in OpenRCA's format, fetches each scenario's answer keys and telemetry, and scores predictions with the official OpenRCA evaluator.

## Scope

- Naming the four OpenRCA scenarios, `bank`, `telecom`, `market-cloudbed-1`, and `market-cloudbed-2`, after the Bank, Telecom, Market/cloudbed-1, and Market/cloudbed-2 systems, and reading the tasks in each scenario's `query.csv`.
- Converting a `Diagnosis` from `@evorca/core` to and from OpenRCA's prediction JSON. OpenRCA datetimes are wall-clock times at UTC+8.
- Fetching each scenario's answer keys, `query.csv` and `record.csv`, and its telemetry, the logs, metrics, and traces, from the published dataset archives. Each file must match its size and SHA-256 in `src/pinned.ts` or `src/pinned-telemetry.json`.
- Scoring a prediction CSV with OpenRCA's own `main/evaluate.py` at a pinned commit, in the Python environment locked in `evaluator/uv.lock`.

## Non-goals

- Parsing the telemetry. `fetchOpenRcaData` writes the CSV files as OpenRCA publishes them, and the agent reads them.
- A command line. `pnpm evorca fetch` from [`@evorca/cli`](../cli/README.md) downloads the data.
- Running an agent.
- A second implementation of the evaluator. Every score comes from OpenRCA's own code.

## Public API

### `@evorca/openrca`

`src/index.ts` is the entry for an agent runner. It exposes no scoring points.

- `openRcaScenarios` maps each scenario slug, such as `market-cloudbed-1`, to its OpenRCA system, such as `Market/cloudbed-1`. `OpenRcaScenario` is one slug. Each scenario's files live in `<dataDir>/<scenario>/`, where `dataDir` is the benchmark's data directory, `data/benchmarks/openrca` in this repository.
- `readTasks(scenario, dataDir)` returns the tasks in `<dataDir>/<scenario>/query.csv` as `OpenRcaTask` values, in file order. A task's `TaskIndex`, `task_1` to `task_7`, decides which root cause fields the answer needs.
- `formatPrediction(diagnosis)` and `parsePrediction(raw)` convert between a `Diagnosis` and OpenRCA's prediction JSON. `parsePrediction` returns `undefined` for text that is not a valid prediction, so only `{}` parses as no causes.
- `writePredictions(tasks, diagnoses)` returns the prediction CSV for one scenario, with one row per task in the order of `tasks`.

### `@evorca/openrca/dataset`

`src/dataset/index.ts` is the entry for a tool that downloads the dataset, such as `evorca fetch`.

- `fetchOpenRcaData({ scenarios, dataDir })` makes sure that the answer keys and the telemetry of each scenario exist in `<dataDir>/<scenario>/` and match their pinned size and SHA-256. It is an async generator that yields a `FileProgress` for each file: `present` for a file that is already there, `fetching` when a download starts, and `fetched` when the download matches and has its final name. Each `FileProgress` has the file's `path` and its pinned `bytes` and `sha256`. It throws before any download if a file on disk does not match, or if the missing files need more than the free space in `dataDir`.

### `@evorca/openrca/scoring`

`src/scoring/index.ts` is the entry for a scorer. An agent runner never imports it.

- `scoreWithOfficialEvaluator({ predictionsPath, scenario, dataDir, cacheDir })` scores a prediction CSV and returns one `ScoredRow` per task.
- `summarize(rows)` returns a `Summary` with the strict and partial `Accuracy` for each `Difficulty` and in total.

## Lay out a scenario's data

`fetchOpenRcaData` writes each scenario to its own directory. The answer keys sit beside the telemetry:

```text
<dataDir>/<scenario>/
  query.csv
  record.csv
  telemetry/<YYYY_MM_DD>/<log|metric|trace>/<file>.csv
```

Mount only `<scenario>/telemetry/` into an agent's container. `query.csv` and `record.csv` hold the answers, so they stay on the host.

## Write predictions

OpenRCA's evaluator scores one CSV file per scenario, with one prediction per row of `query.csv`. In this example, `investigate` stands for your agent and returns a `Diagnosis`:

```ts
import { writeFile } from "node:fs/promises";
import type { Diagnosis } from "@evorca/core";
import { readTasks, writePredictions } from "@evorca/openrca";

const tasks = await readTasks("telecom", "data/benchmarks/openrca");
const diagnoses = new Map<number, Diagnosis>();
for (const task of tasks) {
  diagnoses.set(task.row, await investigate(task.instruction));
}
await writeFile("predictions.csv", writePredictions(tasks, diagnoses));
```

A task with no entry in `diagnoses` gets the empty prediction `{}`, which scores 0.

## Fetch the data

OpenRCA publishes its dataset on Google Drive as three zip archives of about 3 GB each. `fetchOpenRcaData` reads only the files it needs out of the archives, through HTTP Range requests, and checks each file against its pinned size and SHA-256 before it keeps the file. `query.csv` holds the tasks and their scoring points. `record.csv` lists the failures behind them. The telemetry is much larger once unpacked:

| Scenario          | Telemetry files | Telemetry size | Kinds              |
| ----------------- | --------------: | -------------: | ------------------ |
| bank              |              40 |       26.40 GB | log, metric, trace |
| telecom           |              90 |       17.66 GB | metric, trace      |
| market-cloudbed-1 |              16 |       11.94 GB | log, metric, trace |
| market-cloudbed-2 |              16 |       12.66 GB | log, metric, trace |
| All scenarios     |             162 |       68.65 GB |                    |

You need network access to drive.usercontent.google.com. From the repository root, run:

```sh
pnpm evorca fetch --benchmark=openrca --scenario=telecom
```

The command writes the answer keys and the telemetry of `telecom` to `data/benchmarks/openrca/telecom/`. To fetch more scenarios, repeat `--scenario`. To fetch all four, leave it out. The command prints a line when a download starts and a line when it is done, and one line for each file that is already present.

Before it downloads anything, the command checks the files that are present and compares the size of the missing files with the free space in `data/benchmarks/openrca/`. If a file on disk does not match, the command fails and names the file to delete. If the missing files do not fit, it fails and prints both sizes in GB. A file that is present and matches stays as it is, so a second run downloads nothing.

The archives also hold `.DS_Store` files, which the command skips. `pnpm --filter @evorca/openrca pin-telemetry` reads every telemetry file in the archives once and writes its size and SHA-256 to `src/pinned-telemetry.json`. Like the other pins in `src/pinned.ts`, change that file only together with the expected results below.

## Score predictions

`scoreWithOfficialEvaluator` runs OpenRCA's `main/evaluate.py` at the commit in `src/pinned.ts`. The first call clones that commit into `<cacheDir>/openrca/` and creates the Python environment that `evaluator/uv.lock` pins, so you need git, [uv](https://docs.astral.sh/uv/), and network access to github.com. uv downloads Python 3.11 if you do not have it.

```ts
import { scoreWithOfficialEvaluator, summarize } from "@evorca/openrca/scoring";

const rows = await scoreWithOfficialEvaluator({
  predictionsPath: "predictions.csv",
  scenario: "telecom",
  dataDir: "data/benchmarks/openrca",
  cacheDir: ".cache",
});
const { total } = summarize(rows);
console.log(`strict ${total.strict}, partial ${total.partial}`);
```

Strict accuracy is the share of tasks with a score of 1. Partial accuracy is the mean score.

## Reproduce the archive scores

OpenRCA publishes the predictions of its RCA-Agent in `rca/archive/`. `reproduce-archive` scores the archived predictions of each scenario twice with the official evaluator. Stage 1 scores the predictions as published. Stage 2 scores them after a round trip through `parsePrediction`, `formatPrediction`, and `writePredictions`. In both stages, each row's score must equal the archived score rounded to two decimals, because the evaluator rounds its scores to two decimals. The command lists every mismatch and exits with code 1 if it finds one.

You need:

- Node 22.12 or later. `.nvmrc` pins Node 22.
- pnpm, through `corepack enable`.
- [uv](https://docs.astral.sh/uv/). uv downloads Python 3.11 and the packages locked in `evaluator/uv.lock`.
- git.
- Network access to github.com and drive.usercontent.google.com.
- 68.65 GB of free disk space. `evorca fetch` downloads the telemetry of all four scenarios, although `reproduce-archive` reads only `query.csv` and `record.csv`.

From a fresh clone, run:

```sh
pnpm install
pnpm evorca fetch --benchmark=openrca
pnpm --filter @evorca/openrca reproduce-archive
```

`evorca fetch` writes to `data/benchmarks/openrca/`. `reproduce-archive` checks out OpenRCA and creates the Python environment in `.cache/openrca/`. Both commands skip work that a previous run finished. `reproduce-archive` prints the pinned inputs and the Node, uv, and Python versions first, then one block per scenario. The expected result is:

| Scenario          | Rows | Stage 1 matches | Stage 2 matches | Strict accuracy | Partial accuracy |
| ----------------- | ---: | --------------: | --------------: | --------------: | ---------------: |
| bank              |  136 |             136 |             136 |          14.71% |           22.55% |
| telecom           |   51 |              51 |              51 |          23.53% |           28.08% |
| market-cloudbed-1 |   70 |              70 |              70 |           4.29% |           12.49% |
| market-cloudbed-2 |   78 |              78 |              78 |           3.85% |           12.82% |
| All scenarios     |  335 |             335 |             335 |          11.34% |           19.02% |
