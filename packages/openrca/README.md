# @evorca/openrca

OpenRCA benchmark support for evorca. It reads [OpenRCA](https://github.com/microsoft/OpenRCA) tasks and writes predictions in OpenRCA's format.

## Scope

- Reading the tasks in `query.csv` for the Bank, Telecom, Market/cloudbed-1, and Market/cloudbed-2 systems.
- Converting a `Diagnosis` from `@evorca/core` to and from OpenRCA's prediction JSON. OpenRCA datetimes are wall-clock times at UTC+8.

## Non-goals

- The logs, metrics, and traces in the OpenRCA dataset.
- Running an agent.

## Public API

### `@evorca/openrca`

`src/index.ts` is the entry for an agent runner. It exposes no scoring points.

- `openRcaSystems` lists the four systems, and `OpenRcaSystem` is the name of one.
- `readTasks(system, dataDir)` returns the tasks in `<dataDir>/<system>/query.csv` as `OpenRcaTask` values, in file order. A task's `TaskIndex`, `task_1` to `task_7`, decides which root cause fields the answer needs.
- `formatPrediction(diagnosis)` and `parsePrediction(raw)` convert between a `Diagnosis` and OpenRCA's prediction JSON.
- `writePredictions(taskCount, diagnoses)` returns the prediction CSV for one system, with one row per task.
- `toOpenRcaDatetime(t)` and `fromOpenRcaDatetime(s)` convert between `UnixSeconds` and OpenRCA datetimes.

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
await writeFile("predictions.csv", writePredictions(tasks.length, diagnoses));
```

A task with no entry in `diagnoses` gets the empty prediction `{}`, which scores 0.
