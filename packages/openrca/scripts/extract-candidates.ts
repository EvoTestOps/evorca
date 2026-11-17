/**
 * `pnpm --filter @evorca/openrca extract-candidates` writes the candidate root
 * cause components and reasons of each scenario to `src/candidates.json`. It
 * reads them from the `cand` string of RCA-Agent's prompt for the scenario's
 * system, `rca/baseline/rca_agent/prompt/basic_prompt_<System>.py`, at the
 * pinned OpenRCA commit, which it checks out in `.cache/` at the repository
 * root. Both Market scenarios read `basic_prompt_Market.py`.
 *
 * The prompts end some entries with spaces. The evaluator compares names
 * exactly, so the script trims each entry.
 *
 * @module
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import type { Candidates } from "../src/candidates.js";
import { openRcaScenarios } from "../src/scenarios.js";
import { ensureOpenRca } from "../src/scoring/evaluator.js";

const cacheDir = fileURLToPath(new URL("../../../.cache/", import.meta.url));
const outPath = fileURLToPath(new URL("../src/candidates.json", import.meta.url));
const promptDir = join(await ensureOpenRca(cacheDir), "rca", "baseline", "rca_agent", "prompt");

const candidates = await Array.fromAsync(
  Object.entries(openRcaScenarios),
  async ([scenario, system]): Promise<[string, Candidates]> => {
    const prompt = `basic_prompt_${system.split("/")[0]}.py`;
    return [scenario, readCandidates(await readFile(join(promptDir, prompt), "utf8"), prompt)];
  },
);
const json = JSON.stringify(Object.fromEntries(candidates));
await writeFile(
  outPath,
  await format(json, { ...(await resolveConfig(outPath)), filepath: outPath }),
);
for (const [scenario, { components, reasons }] of candidates) {
  console.log(`${scenario}: ${components.length} components, ${reasons.length} reasons`);
}
console.log(`Wrote ${outPath}`);

function readCandidates(source: string, prompt: string): Candidates {
  const block = /^cand = """(.*?)"""/ms.exec(source)?.[1];
  if (block === undefined) throw new Error(`${prompt} has no cand string`);
  const sections = new Map<string, string[]>();
  let section: string[] = [];
  for (const line of block.split("\n")) {
    const heading = /^## POSSIBLE ROOT CAUSE (COMPONENTS|REASONS):/.exec(line)?.[1];
    if (heading !== undefined) {
      section = [];
      sections.set(heading, section);
    } else if (line.startsWith("- ")) {
      section.push(line.slice(2).trim());
    }
  }
  const components = sections.get("COMPONENTS") ?? [];
  const reasons = sections.get("REASONS") ?? [];
  if (components.length === 0 || reasons.length === 0) {
    throw new Error(`${prompt} lists no candidate components or no candidate reasons`);
  }
  return { components, reasons };
}
