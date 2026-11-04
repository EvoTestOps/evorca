/**
 * Scores predictions with OpenRCA's own evaluator, `main/evaluate.py`, at the
 * pinned commit, in the Python environment that `evaluator/uv.lock` pins. The
 * first call clones OpenRCA into `<cacheDir>/openrca/<commit>/` and creates the
 * environment in `<cacheDir>/openrca/venv/`. Later calls reuse both.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseCsv } from "../csv.js";
import { openRcaCommit, openRcaRepository } from "../pinned.js";
import { parseTaskIndex, type OpenRcaSystem, type TaskIndex } from "../tasks.js";

const run = promisify(execFile);

const evaluatorProject = fileURLToPath(new URL("../../evaluator/", import.meta.url));

/**
 * One evaluator score. `row` is the zero-based row in `query.csv`, and `score`
 * is the share of scoring points met, from 0 to 1, rounded to two decimals.
 */
export type ScoredRow = {
  readonly row: number;
  readonly taskIndex: TaskIndex;
  readonly score: number;
};

/**
 * Checks out the pinned OpenRCA commit in the cache unless it is there, and
 * returns the absolute path of the checkout. It clones into a staging directory
 * and renames that into place, so an interrupted clone never passes for one.
 *
 * @throws Error if git fails, such as without network access.
 */
export async function ensureOpenRca(cacheDir: string): Promise<string> {
  const checkout = resolve(cacheDir, "openrca", openRcaCommit);
  const head = await run("git", ["-C", checkout, "rev-parse", "HEAD"]).catch(() => undefined);
  if (head?.stdout.trim() === openRcaCommit) return checkout;
  await rm(checkout, { recursive: true, force: true });
  await mkdir(dirname(checkout), { recursive: true });
  const staging = await mkdtemp(`${checkout}.staging-`);
  try {
    await run("git", ["-C", staging, "init", "-q"]);
    await run("git", [
      "-C",
      staging,
      "fetch",
      "-q",
      "--depth",
      "1",
      openRcaRepository,
      openRcaCommit,
    ]);
    await run("git", ["-C", staging, "checkout", "-q", "FETCH_HEAD"]);
    await rename(staging, checkout);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return checkout;
}

/**
 * Returns the evaluator's `python --version`, such as `Python 3.11.14`, and
 * creates the Python environment first if it does not exist.
 *
 * @throws Error if uv is not installed or cannot create the environment.
 */
export async function evaluatorPython(cacheDir: string): Promise<string> {
  const { stdout } = await runPython(cacheDir, ["--version"]);
  return stdout.trim();
}

/**
 * Scores the prediction file at `predictionsPath` with the official evaluator
 * and returns one score per task, in row order. The file needs a `prediction`
 * column and one row per task in `<dataDir>/<system>/query.csv`, as
 * `writePredictions` writes it. If it has a `row_id` column, the evaluator sorts
 * the rows by it.
 *
 * @throws Error with the evaluator's output if the evaluator fails, such as
 *   for a file with the wrong number of rows.
 */
export async function scoreWithOfficialEvaluator({
  predictionsPath,
  system,
  dataDir,
  cacheDir,
}: {
  readonly predictionsPath: string;
  readonly system: OpenRcaSystem;
  readonly dataDir: string;
  readonly cacheDir: string;
}): Promise<ScoredRow[]> {
  const checkout = await ensureOpenRca(cacheDir);
  // The evaluator appends to a report that already exists, so each run writes to a new directory.
  const work = await mkdtemp(join(tmpdir(), "evorca-openrca-"));
  try {
    const report = join(work, "report.csv");
    await runPython(
      cacheDir,
      [
        "-m",
        "main.evaluate",
        "-p",
        resolve(predictionsPath),
        "-q",
        resolve(dataDir, system, "query.csv"),
        "-r",
        report,
      ],
      checkout,
    ).catch((error: unknown) => {
      if (error instanceof Error && "stdout" in error && typeof error.stdout === "string") {
        throw new Error(`${error.message}${error.stdout}`);
      }
      throw error;
    });
    const scored = parseCsv(await readFile(report, "utf8"), ["task_index", "score"]);
    return scored.map((record, row) => ({
      row,
      taskIndex: parseTaskIndex(record.task_index),
      score: parseScore(record, `The evaluator's report on ${predictionsPath}`, row),
    }));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Parses the `score` field of `record`, the zero-based data `row` of the CSV
 * file that `source` names.
 *
 * @throws Error naming `source` and `row` if the score is not a number from 0 to 1.
 */
export function parseScore(
  record: { readonly score: string },
  source: string,
  row: number,
): number {
  const score = Number(record.score);
  if (record.score.trim() === "" || Number.isNaN(score) || score < 0 || score > 1) {
    throw new Error(
      `${source}, row ${row}: score ${JSON.stringify(record.score)} is not a number from 0 to 1`,
    );
  }
  return score;
}

function runPython(cacheDir: string, args: readonly string[], cwd?: string) {
  return run("uv", ["run", "--frozen", "--project", evaluatorProject, "python", ...args], {
    cwd,
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: resolve(cacheDir, "openrca", "venv") },
  });
}
