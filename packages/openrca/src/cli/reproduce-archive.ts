/**
 * `pnpm --filter @evorca/openrca reproduce-archive` checks that this package,
 * with the official evaluator, reproduces every score in OpenRCA's archive of
 * RCA-Agent predictions.
 *
 * It prints the pinned inputs and the tool versions, then one block per
 * system and a summary over all systems. It exits with code 1 if any score
 * differs.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataFileSha256, driveArchives, openRcaCommit, openRcaRepository } from "../pinned.js";
import { reproduceArchive, type Mismatch } from "../scoring/archive.js";
import { evaluatorPython, type ScoredRow } from "../scoring/evaluator.js";
import { summarize, type Summary } from "../scoring/summary.js";
import { openRcaSystems } from "../tasks.js";
import { cacheDir, dataDir } from "./paths.js";

const uv = (await promisify(execFile)("uv", ["--version"])).stdout.trim();
console.log(`OpenRCA ${openRcaRepository} at ${openRcaCommit}`);
for (const [name, archive] of Object.entries(driveArchives)) {
  console.log(`Drive ${name} archive ${archive.driveId}, ${archive.bytes} bytes`);
}
for (const [file, sha256] of Object.entries(dataFileSha256)) {
  console.log(`sha256 ${sha256}  ${file}`);
}
console.log(`node ${process.version}, ${uv}, ${await evaluatorPython(cacheDir)}`);

const allRows: ScoredRow[] = [];
let mismatches = 0;

for (const system of openRcaSystems) {
  const { tasks, published, roundTripped } = await reproduceArchive({ system, dataDir, cacheDir });
  console.log(
    `\n${system}: ${tasks} rows, stage 1 ${published.scores.length - published.mismatches.length}/${tasks} match, stage 2 ${roundTripped.scores.length - roundTripped.mismatches.length}/${tasks} match`,
  );
  print(summarize(roundTripped.scores));
  for (const mismatch of published.mismatches) printMismatch(1, mismatch);
  for (const mismatch of roundTripped.mismatches) printMismatch(2, mismatch);
  mismatches += published.mismatches.length + roundTripped.mismatches.length;
  allRows.push(...roundTripped.scores);
}

console.log("\nAll systems:");
print(summarize(allRows));
console.log(mismatches === 0 ? "\nAll scores match the archive." : `\n${mismatches} mismatches.`);
process.exitCode = mismatches === 0 ? 0 : 1;

function print(summary: Summary) {
  for (const [level, { tasks, strict, partial }] of Object.entries(summary)) {
    const percent = (fraction: number) => `${(fraction * 100).toFixed(2)}%`;
    console.log(
      `  ${level.padEnd(7)} ${String(tasks).padStart(4)} tasks  strict ${percent(strict).padStart(7)}  partial ${percent(partial).padStart(7)}`,
    );
  }
}

function printMismatch(stage: number, { row, taskIndex, score, archived, prediction }: Mismatch) {
  console.log(
    `  mismatch stage ${stage} row ${row} ${taskIndex}: archive ${archived?.score}, ours ${score}`,
  );
  console.log(`    archive prediction: ${JSON.stringify(archived?.prediction)}`);
  console.log(`    our prediction:     ${JSON.stringify(prediction)}`);
}
