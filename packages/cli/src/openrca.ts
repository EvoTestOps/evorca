/**
 * The report that `evorca reproduce --benchmark=openrca` prints. It reads the
 * answer keys that `evorca fetch --benchmark=openrca` writes.
 *
 * @module
 */
import type { OpenRcaScenario } from "@evorca/openrca";
import {
  evaluatorVersions,
  pinnedInputs,
  reproduceArchive,
  summarize,
  type Mismatch,
  type Stage,
  type Summary,
} from "@evorca/openrca/scoring";

/**
 * Reproduces the archive scores of `scenarios`, prints the report, and returns
 * whether every score matches.
 *
 * @throws Error if `evaluatorVersions` or `reproduceArchive` fails.
 */
export async function reproduceOpenRca({
  scenarios,
  dataDir,
  cacheDir,
}: {
  readonly scenarios: readonly OpenRcaScenario[];
  readonly dataDir: string;
  readonly cacheDir: string;
}): Promise<boolean> {
  const { uv, python } = await evaluatorVersions(cacheDir);
  const results = await Array.fromAsync(scenarios, async (scenario) => ({
    scenario,
    ...(await reproduceArchive({ scenario, dataDir, cacheDir })),
  }));
  const mismatches = results.flatMap((result) => [
    ...result.published.mismatches,
    ...result.roundTripped.mismatches,
  ]);

  console.log(`OpenRCA ${pinnedInputs.repository} at ${pinnedInputs.commit}`);
  for (const [name, archive] of Object.entries(pinnedInputs.driveArchives)) {
    console.log(`Drive ${name} archive ${archive.driveId}, ${archive.bytes} bytes`);
  }
  for (const [file, sha256] of Object.entries(pinnedInputs.answerKeySha256)) {
    console.log(`sha256 ${sha256}  ${file}`);
  }
  console.log(`node ${process.version}, ${uv}, ${python}`);
  for (const { scenario, tasks, published, roundTripped } of results) {
    const stages = `stage 1 ${matched(published, tasks)}, stage 2 ${matched(roundTripped, tasks)}`;
    console.log(`\n${scenario}: ${tasks} rows, ${stages}`);
    printSummary(summarize(roundTripped.scores));
    for (const mismatch of [...published.mismatches, ...roundTripped.mismatches]) {
      printMismatch(mismatch);
    }
  }
  console.log("\nAll scenarios:");
  printSummary(summarize(results.flatMap((result) => result.roundTripped.scores)));
  console.log(
    mismatches.length === 0
      ? "\nAll scores match the archive."
      : `\n${mismatches.length} mismatches.`,
  );
  return mismatches.length === 0;
}

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
