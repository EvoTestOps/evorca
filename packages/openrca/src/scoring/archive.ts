/**
 * Checks that this package reproduces the scores in OpenRCA's archive of
 * RCA-Agent predictions, `rca/archive/agent-<system>.csv` with `/` replaced by
 * `-`. Stage 1 scores the archived predictions as published. Stage 2 scores them
 * after a round trip through `parsePrediction`, `formatPrediction`, and
 * `writePredictions`. A score matches when it equals the archived score rounded
 * to two decimals, because the evaluator rounds its scores and the archive does not.
 *
 * @module
 */
import type { Diagnosis } from "@evorca/core";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv } from "../csv.js";
import { formatPrediction, parsePrediction, writePredictions } from "../prediction.js";
import { readTasks, type OpenRcaSystem } from "../tasks.js";
import { removeOnDispose } from "../temp.js";
import {
  ensureOpenRca,
  parseScore,
  scoreWithOfficialEvaluator,
  type ScoredRow,
} from "./evaluator.js";

/** One row of an archive file. Unlike the evaluator's scores, `score` is not rounded. */
export type ArchiveRow = { readonly prediction: string; readonly score: number };

/**
 * A score that differs from the archived score. `prediction` is what the evaluator
 * scored, which is the archived prediction in stage 1 and its round trip in stage 2.
 */
export type Mismatch = ScoredRow & {
  readonly stage: 1 | 2;
  readonly archived: ArchiveRow;
  readonly prediction: string;
};

/** One score per task and the mismatches, both in row order. */
export type Stage = {
  readonly scores: readonly ScoredRow[];
  readonly mismatches: readonly Mismatch[];
};

/**
 * Scores the archived predictions of `system` in both stages against the tasks
 * in `<dataDir>/<system>/query.csv`, and returns the number of tasks with each
 * stage's result.
 *
 * @throws Error if the checkout, `query.csv`, the archive file, or the evaluator
 *   fails, or if the archive has no row for a task.
 */
export async function reproduceArchive({
  system,
  dataDir,
  cacheDir,
}: {
  readonly system: OpenRcaSystem;
  readonly dataDir: string;
  readonly cacheDir: string;
}): Promise<{ readonly tasks: number; readonly published: Stage; readonly roundTripped: Stage }> {
  const checkout = await ensureOpenRca(cacheDir);
  const name = system.replace("/", "-");
  const archivePath = join(checkout, "rca", "archive", `agent-${name}.csv`);
  const archive = await readArchive(archivePath);
  const tasks = await readTasks(system, dataDir);
  await using work = removeOnDispose(await mkdtemp(join(tmpdir(), "evorca-reproduce-")));
  const roundTripPath = join(work.path, `${name}.csv`);
  const diagnoses = new Map(
    [...archive].map(([row, { prediction }]) => [row, roundTrip(prediction)]),
  );
  await writeFile(roundTripPath, writePredictions(tasks, diagnoses));
  const score = (predictionsPath: string) =>
    scoreWithOfficialEvaluator({ predictionsPath, system, dataDir, cacheDir });
  const published = await score(archivePath);
  const roundTripped = await score(roundTripPath);
  return {
    tasks: tasks.length,
    published: { scores: published, mismatches: findMismatches(published, archive, 1) },
    roundTripped: { scores: roundTripped, mismatches: findMismatches(roundTripped, archive, 2) },
  };
}

/**
 * Reads an archive file into its rows, keyed by `row_id`. The archive writes
 * each `row_id` as a float, such as `3.0`.
 *
 * @throws Error naming the file and the zero-based data row if a `row_id` is
 *   not a non-negative integer or a `score` is not a number from 0 to 1.
 */
export async function readArchive(path: string): Promise<ReadonlyMap<number, ArchiveRow>> {
  const records = parseCsv(await readFile(path, "utf8"), ["row_id", "prediction", "score"]);
  return new Map(
    records.map((record, row) => [
      parseRowId(record, path, row),
      { prediction: record.prediction, score: parseScore(record, path, row) },
    ]),
  );
}

function parseRowId(record: { readonly row_id: string }, path: string, row: number): number {
  const id = Number(record.row_id);
  if (record.row_id.trim() === "" || !Number.isInteger(id) || id < 0) {
    throw new Error(
      `${path}, row ${row}: row_id ${JSON.stringify(record.row_id)} is not a non-negative integer`,
    );
  }
  return id;
}

function findMismatches(
  scores: readonly ScoredRow[],
  archive: ReadonlyMap<number, ArchiveRow>,
  stage: 1 | 2,
): Mismatch[] {
  return scores.flatMap((scored) => {
    const archived = archive.get(scored.row);
    if (archived === undefined) throw new Error(`The archive has no row_id ${scored.row}`);
    if (Math.round(archived.score * 100) / 100 === scored.score) return [];
    const prediction =
      stage === 1 ? archived.prediction : formatPrediction(roundTrip(archived.prediction));
    return [{ ...scored, stage, archived, prediction }];
  });
}

// Text that is not a prediction round-trips to no causes, which writePredictions writes as `{}`.
function roundTrip(prediction: string): Diagnosis {
  return parsePrediction(prediction) ?? [];
}
