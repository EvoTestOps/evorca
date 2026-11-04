/**
 * `pnpm --filter @evorca/openrca reproduce-archive` checks that this package,
 * with the official evaluator, reproduces every score in OpenRCA's archive of
 * RCA-Agent predictions. It scores the systems one at a time, then prints the
 * pinned inputs, the tool versions, one block per system, and a summary over
 * all systems. It exits with code 1 if any score differs.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataFileSha256, driveArchives, openRcaCommit, openRcaRepository } from "../pinned.js";
import { reproduceArchive, type Mismatch, type Stage } from "../scoring/archive.js";
import { evaluatorPython } from "../scoring/evaluator.js";
import { summarize, type Summary } from "../scoring/summary.js";
import { openRcaSystems } from "../tasks.js";
import { cacheDir, dataDir } from "./paths.js";

const uv = (await promisify(execFile)("uv", ["--version"])).stdout.trim();
const python = await evaluatorPython(cacheDir);
const results = await Array.fromAsync(openRcaSystems, async (system) => ({
  system,
  ...(await reproduceArchive({ system, dataDir, cacheDir })),
}));
const mismatches = results.flatMap((result) => [
  ...result.published.mismatches,
  ...result.roundTripped.mismatches,
]);

console.log(`OpenRCA ${openRcaRepository} at ${openRcaCommit}`);
for (const [name, archive] of Object.entries(driveArchives)) {
  console.log(`Drive ${name} archive ${archive.driveId}, ${archive.bytes} bytes`);
}
for (const [file, sha256] of Object.entries(dataFileSha256)) {
  console.log(`sha256 ${sha256}  ${file}`);
}
console.log(`node ${process.version}, ${uv}, ${python}`);
for (const { system, tasks, published, roundTripped } of results) {
  const stages = `stage 1 ${matched(published, tasks)}, stage 2 ${matched(roundTripped, tasks)}`;
  console.log(`\n${system}: ${tasks} rows, ${stages}`);
  printSummary(summarize(roundTripped.scores));
  for (const mismatch of [...published.mismatches, ...roundTripped.mismatches]) {
    printMismatch(mismatch);
  }
}
console.log("\nAll systems:");
printSummary(summarize(results.flatMap((result) => result.roundTripped.scores)));
console.log(
  mismatches.length === 0
    ? "\nAll scores match the archive."
    : `\n${mismatches.length} mismatches.`,
);
process.exitCode = mismatches.length === 0 ? 0 : 1;

function matched(stage: Stage, tasks: number): string {
  return `${stage.scores.length - stage.mismatches.length}/${tasks} match`;
}

function printSummary(summary: Summary) {
  for (const [level, { tasks, strict, partial }] of Object.entries(summary)) {
    const counts = `${level.padEnd(7)} ${String(tasks).padStart(4)} tasks`;
    console.log(`  ${counts}  strict ${percent(strict)}  partial ${percent(partial)}`);
  }
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`.padStart(7);
}

function printMismatch({ stage, row, taskIndex, score, archived, prediction }: Mismatch) {
  const scores = `archive ${archived.score}, ours ${score}`;
  console.log(`  mismatch stage ${stage} row ${row} ${taskIndex}: ${scores}`);
  console.log(`    archive prediction: ${JSON.stringify(archived.prediction)}`);
  console.log(`    our prediction:     ${JSON.stringify(prediction)}`);
}
