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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv } from "../csv.js";
import { formatPrediction, parsePrediction, writePredictions } from "../prediction.js";
import { readTasks, type OpenRcaSystem } from "../tasks.js";
import {
  ensureOpenRca,
  parseScore,
  scoreWithOfficialEvaluator,
  type ScoredRow,
} from "./evaluator.js";

/** One row of an archive file. Unlike the evaluator's scores, `score` is not rounded. */
export type ArchiveRow = { readonly prediction: string; readonly score: number };

/**
 * A score that differs from the archived score. `archived` is undefined if the
 * archive has no such row. `prediction` is the prediction that the evaluator scored.
 */
export type Mismatch = ScoredRow & {
  readonly archived: ArchiveRow | undefined;
  readonly prediction: string | undefined;
};

type Stage = {
  readonly scores: readonly ScoredRow[];
  readonly mismatches: readonly Mismatch[];
};

/**
 * Scores the archived predictions of `system` in both stages against the tasks
 * in `<dataDir>/<system>/query.csv`. Returns the number of tasks and, for each
 * stage, one score per task and the mismatches, both in row order.
 *
 * @throws Error if the checkout, `query.csv`, the archive file, or the evaluator fails.
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
  const diagnoses = new Map(
    [...archive].map(([row, { prediction }]) => [row, parsePrediction(prediction) ?? []]),
  );
  const tasks = await readTasks(system, dataDir);
  const stage = (
    scores: readonly ScoredRow[],
    scoredPrediction: (row: number) => string | undefined,
  ): Stage => ({
    scores,
    mismatches: scores
      .filter(({ row, score }) => {
        const archived = archive.get(row)?.score;
        return archived === undefined || Math.round(archived * 100) / 100 !== score;
      })
      .map((scored) => ({
        ...scored,
        archived: archive.get(scored.row),
        prediction: scoredPrediction(scored.row),
      })),
  });

  const work = await mkdtemp(join(tmpdir(), "evorca-reproduce-"));
  try {
    const roundTripPath = join(work, `${name}.csv`);
    await writeFile(roundTripPath, writePredictions(tasks, diagnoses));
    const published = await scoreWithOfficialEvaluator({
      predictionsPath: archivePath,
      system,
      dataDir,
      cacheDir,
    });
    const roundTripped = await scoreWithOfficialEvaluator({
      predictionsPath: roundTripPath,
      system,
      dataDir,
      cacheDir,
    });
    return {
      tasks: tasks.length,
      published: stage(published, (row) => archive.get(row)?.prediction),
      roundTripped: stage(roundTripped, (row) => formatPrediction(diagnoses.get(row) ?? [])),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
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
