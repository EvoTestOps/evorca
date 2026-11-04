# @evorca/openrca

OpenRCA benchmark support for evorca. It reads [OpenRCA](https://github.com/microsoft/OpenRCA) tasks, writes predictions in OpenRCA's format, fetches the answer keys, and scores predictions with the official OpenRCA evaluator.

## Scope

- Reading the tasks in `query.csv` for the Bank, Telecom, Market/cloudbed-1, and Market/cloudbed-2 systems.
- Converting a `Diagnosis` from `@evorca/core` to and from OpenRCA's prediction JSON. OpenRCA datetimes are wall-clock times at UTC+8.
- Fetching `query.csv` and `record.csv` from the published dataset archives and checking each file against its SHA-256 in `src/pinned.ts`.
- Scoring a prediction CSV with OpenRCA's own `main/evaluate.py` at a pinned commit, in the Python environment locked in `evaluator/uv.lock`.

## Non-goals

- The logs, metrics, and traces in the OpenRCA dataset. `fetch-data` downloads only `query.csv` and `record.csv`.
- Running an agent.
- A second implementation of the evaluator. Every score comes from OpenRCA's own code.

## Public API

### `@evorca/openrca`

`src/index.ts` is the entry for an agent runner. It exposes no scoring points.

- `openRcaSystems` lists the four systems, and `OpenRcaSystem` is the name of one.
- `readTasks(system, dataDir)` returns the tasks in `<dataDir>/<system>/query.csv` as `OpenRcaTask` values, in file order. A task's `TaskIndex`, `task_1` to `task_7`, decides which root cause fields the answer needs.
- `formatPrediction(diagnosis)` and `parsePrediction(raw)` convert between a `Diagnosis` and OpenRCA's prediction JSON. `parsePrediction` returns `undefined` for text that is not a valid prediction, so only `{}` parses as no causes.
- `writePredictions(tasks, diagnoses)` returns the prediction CSV for one system, with one row per task in the order of `tasks`.

### `@evorca/openrca/scoring`

`src/scoring/index.ts` is the entry for a scorer. An agent runner never imports it.

- `scoreWithOfficialEvaluator({ predictionsPath, system, dataDir, cacheDir })` scores a prediction CSV and returns one `ScoredRow` per task.
- `summarize(rows)` returns a `Summary` with the strict and partial `Accuracy` for each `Difficulty` and in total.

## Write predictions

OpenRCA's evaluator scores one CSV file per system, with one prediction per row of `query.csv`. In this example, `investigate` stands for your agent and returns a `Diagnosis`:

```ts
import { writeFile } from "node:fs/promises";
import type { Diagnosis } from "@evorca/core";
import { readTasks, writePredictions } from "@evorca/openrca";

const tasks = await readTasks("Telecom", "data/openrca");
const diagnoses = new Map<number, Diagnosis>();
for (const task of tasks) {
  diagnoses.set(task.row, await investigate(task.instruction));
}
await writeFile("predictions.csv", writePredictions(tasks, diagnoses));
```

A task with no entry in `diagnoses` gets the empty prediction `{}`, which scores 0.

## Fetch the data

OpenRCA publishes its dataset on Google Drive as three zip archives of about 3 GB each. `fetch-data` reads only `query.csv` and `record.csv` out of the archives, through HTTP Range requests, and checks each file against its SHA-256 in `src/pinned.ts` before it keeps the file. `query.csv` holds the tasks and their scoring points. `record.csv` lists the failures behind them.

You need network access to drive.usercontent.google.com. From the repository root, run:

```sh
pnpm --filter @evorca/openrca fetch-data
```

The command writes `data/openrca/<system>/query.csv` and `data/openrca/<system>/record.csv` and prints one line per file. To fetch only some systems, name them, as in `pnpm --filter @evorca/openrca fetch-data Telecom`. A file that is already present and matches its hash stays as it is, so a second run downloads nothing. If a file on disk does not match, the command fails and names the file to delete.

## Score predictions

`scoreWithOfficialEvaluator` runs OpenRCA's `main/evaluate.py` at the commit in `src/pinned.ts`. The first call clones that commit into `<cacheDir>/openrca/` and creates the Python environment that `evaluator/uv.lock` pins, so you need git, [uv](https://docs.astral.sh/uv/), and network access to github.com. uv downloads Python 3.11 if you do not have it.

```ts
import { scoreWithOfficialEvaluator, summarize } from "@evorca/openrca/scoring";

const rows = await scoreWithOfficialEvaluator({
  predictionsPath: "predictions.csv",
  system: "Telecom",
  dataDir: "data/openrca",
  cacheDir: ".cache",
});
const { total } = summarize(rows);
console.log(`strict ${total.strict}, partial ${total.partial}`);
```

Strict accuracy is the share of tasks with a score of 1. Partial accuracy is the mean score.

## Reproduce the archive scores

OpenRCA publishes the predictions of its RCA-Agent in `rca/archive/`. `reproduce-archive` scores each system's archive file twice with the official evaluator. Stage 1 scores the predictions as published. Stage 2 scores them after a round trip through `parsePrediction`, `formatPrediction`, and `writePredictions`. In both stages, each row's score must equal the archived score rounded to two decimals, because the evaluator rounds its scores to two decimals. The command lists every mismatch and exits with code 1 if it finds one.

You need:

- Node 22.12 or later. `.nvmrc` pins Node 22.
- pnpm, through `corepack enable`.
- [uv](https://docs.astral.sh/uv/). uv downloads Python 3.11 and the packages locked in `evaluator/uv.lock`.
- git.
- Network access to github.com and drive.usercontent.google.com.

From a fresh clone, run:

```sh
pnpm install
pnpm --filter @evorca/openrca fetch-data
pnpm --filter @evorca/openrca reproduce-archive
```

`fetch-data` writes to `data/openrca/`. `reproduce-archive` checks out OpenRCA and creates the Python environment in `.cache/openrca/`. Both commands skip work that a previous run finished. `reproduce-archive` prints the pinned inputs and the Node, uv, and Python versions first, then one block per system. The expected result is:

| System            | Rows | Stage 1 matches | Stage 2 matches | Strict accuracy | Partial accuracy |
| ----------------- | ---: | --------------: | --------------: | --------------: | ---------------: |
| Bank              |  136 |             136 |             136 |          14.71% |           22.55% |
| Telecom           |   51 |              51 |              51 |          23.53% |           28.08% |
| Market/cloudbed-1 |   70 |              70 |              70 |           4.29% |           12.49% |
| Market/cloudbed-2 |   78 |              78 |              78 |           3.85% |           12.82% |
| All systems       |  335 |             335 |             335 |          11.34% |           19.02% |
