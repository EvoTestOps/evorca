/**
 * Checks that this package reproduces the scores in OpenRCA's archive of
 * RCA-Agent predictions.
 *
 * The OpenRCA checkout holds the predictions of its RCA-Agent and their scores
 * in `rca/archive/agent-<system>.csv`, with the `/` in a system name replaced
 * by `-`. The check scores each archive file twice with the official
 * evaluator. Stage 1 scores the predictions as published. Stage 2 scores them
 * after a round trip through `parsePrediction`, `formatPrediction`, and
 * `writePredictions`. A score matches when it equals the archived score rounded
 * to two decimals, because the evaluator rounds its scores and the archive does
 * not.
 *
 * @module
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv } from "../csv.js";
import { formatPrediction, parsePrediction, writePredictions } from "../prediction.js";
import { readTasks, type OpenRcaSystem } from "../tasks.js";
import { ensureOpenRca, scoreWithOfficialEvaluator, type ScoredRow } from "./evaluator.js";

/** A score that differs from the archived score. */
export type Mismatch = ScoredRow & {
  /** The archived prediction and its unrounded score, or undefined if the archive has no such row. */
  readonly archived: { readonly prediction: string; readonly score: number } | undefined;
  /** The prediction that the evaluator scored. */
  readonly prediction: string | undefined;
};

type Stage = {
  readonly scores: readonly ScoredRow[];
  readonly mismatches: readonly Mismatch[];
};

/**
 * Scores the archived predictions of one system in both stages.
 *
 * @param system - The system to check.
 * @param dataDir - The directory that holds `<system>/query.csv`.
 * @param cacheDir - The cache directory.
 * @returns The number of tasks in `query.csv`, and for each stage one score per
 *   task and the mismatches, both in row order.
 * @throws Error if the checkout, `query.csv`, or the evaluator fails.
 */
export async function reproduceArchive(
  system: OpenRcaSystem,
  dataDir: string,
  cacheDir: string,
): Promise<{ readonly tasks: number; readonly published: Stage; readonly roundTripped: Stage }> {
  const checkout = await ensureOpenRca(cacheDir);
  const name = system.replace("/", "-");
  const archivePath = join(checkout, "rca", "archive", `agent-${name}.csv`);
  const archiveCsv = await readFile(archivePath, "utf8");
  const archive = new Map(
    parseCsv(archiveCsv, ["row_id", "prediction", "score"]).map((record) => [
      Number(record.row_id),
      { prediction: record.prediction, score: Number(record.score) },
    ]),
  );
  const diagnoses = new Map(
    [...archive].map(([row, { prediction }]) => [row, parsePrediction(prediction)]),
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
    await writeFile(roundTripPath, writePredictions(tasks.length, diagnoses));
    const published = await scoreWithOfficialEvaluator(archivePath, system, dataDir, cacheDir);
    const roundTripped = await scoreWithOfficialEvaluator(roundTripPath, system, dataDir, cacheDir);
    return {
      tasks: tasks.length,
      published: stage(published, (row) => archive.get(row)?.prediction),
      roundTripped: stage(roundTripped, (row) => formatPrediction(diagnoses.get(row) ?? [])),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
