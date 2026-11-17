/**
 * `pnpm --filter @evorca/agent-react extract-background` writes
 * `background.json`, the domain knowledge that RCA-Agent, OpenRCA's published
 * baseline, gives its model. It reads RCA-Agent's prompts at the pinned OpenRCA
 * commit, which it checks out in `.cache/` at the repository root.
 *
 * - From `prompt/basic_prompt_<System>.py`, each scenario's `schema`, which
 *   describes the telemetry, and `cand`, which lists the candidates. The schema
 *   keeps a `{cand}` placeholder, because `/task.json` decides whether the
 *   agent sees candidates. Its paths name `/data/`, where the container mounts
 *   the scenario's telemetry, instead of `dataset/<System>/telemetry/`. The
 *   Market schema names the one cloudbed whose telemetry the container holds.
 * - From `prompt/agent_prompt.py`, the `rules` of failure diagnosis, without
 *   four rules that only fit RCA-Agent's split into a controller that writes
 *   no code and an executor that runs it: no code in the controller's
 *   response, no timestamp conversion by the controller, no plots from the
 *   executor, and no files or bash. One rule names the executor, and here it
 *   does not.
 * - From `executor.py`, the two rules of the executor's code that concern the
 *   data rather than the IPython kernel: thresholds before filtering, and UTC+8.
 *
 * The script fails if any text it changes is not where it expects, and if a
 * scenario's candidates differ from `@evorca/openrca`'s `candidates.json`.
 *
 * @module
 */
import { isDeepStrictEqual } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { openRcaCandidates } from "../../../packages/openrca/src/candidates.ts";
import { openRcaCommit } from "../../../packages/openrca/src/pinned.ts";
import { openRcaScenarios } from "../../../packages/openrca/src/scenarios.ts";
import { ensureOpenRca } from "../../../packages/openrca/src/scoring/evaluator.ts";
import type { Background, ScenarioBackground } from "../src/prompt.ts";
import type { Candidates } from "../src/task.ts";

const cacheDir = fileURLToPath(new URL("../../../.cache/", import.meta.url));
const outPath = fileURLToPath(new URL("../background.json", import.meta.url));
const agentDir = join(await ensureOpenRca(cacheDir), "rca", "baseline", "rca_agent");
const source = (file: string) => readFile(join(agentDir, file), "utf8");

const knownCandidates: Readonly<Record<string, Candidates>> = openRcaCandidates;

const droppedRules: Readonly<Record<number, string>> = {
  1: "**DO NOT include any programming language (Python) in your response.**",
  2: "**DO NOT convert the timestamp to datetime or convert the datetime to timestamp by yourself.**",
  4: "**DO NOT visualize the data or draw pictures or graphs via Python.**",
  5: "**DO NOT save anything in the local file system.**",
};
const keptCodeRules = [9, 10];

const rules = [
  diagnosisRules(pythonString(await source("prompt/agent_prompt.py"), "rules")),
  codeRules(pythonString(await source("executor.py"), "rule")),
].join("\n\n");

const scenarios = Object.fromEntries(
  await Array.fromAsync(
    Object.entries(openRcaScenarios),
    async ([scenario, system]): Promise<[string, ScenarioBackground]> => {
      const prompt = await source(`prompt/basic_prompt_${system.split("/")[0]}.py`);
      const cand = pythonString(prompt, "cand");
      const candidates = readCandidates(cand);
      if (!isDeepStrictEqual(candidates, knownCandidates[scenario])) {
        throw new Error(`The candidates of ${scenario} differ from candidates.json`);
      }
      return [
        scenario,
        { schema: schemaFor(system, pythonString(prompt, "schema")), cand, candidates },
      ];
    },
  ),
);

const background: Background = {
  source: `OpenRCA ${openRcaCommit}: rca/baseline/rca_agent/prompt/ and rca/baseline/rca_agent/executor.py`,
  rules,
  scenarios,
};
const json = JSON.stringify(background);
await writeFile(
  outPath,
  await format(json, { ...(await resolveConfig(outPath)), filepath: outPath }),
);
console.log(`Wrote ${outPath}`);

function pythonString(source: string, name: string): string {
  const value = new RegExp(`^${name} = f?"""(.*?)"""`, "ms").exec(source)?.[1];
  if (value === undefined) throw new Error(`No string ${name}`);
  if (value.includes("\\")) throw new Error(`The string ${name} has an escape`);
  return value;
}

function schemaFor(system: string, schema: string): string {
  if ((schema.match(/[{}]/g) ?? []).join("") !== "{}" || !schema.includes("{cand}")) {
    throw new Error(`The schema of ${system} has braces other than {cand}`);
  }
  const cloudbed = /^Market\/(cloudbed-\d)$/.exec(system)?.[1];
  const named =
    cloudbed === undefined
      ? schema
      : replaceOnce(
          schema,
          "- You can access the telemetry directories of two cloudbed (i.e., `cloudbed-1` and `cloudbed-2`) in our microservices system: `dataset/Market/cloudbed-1/telemetry/` and `dataset/Market/cloudbed-2/telemetry/`.",
          `- You can access the telemetry directory of \`${cloudbed}\` in our microservices system: \`/data/\`.`,
        );
  const telemetry =
    cloudbed === undefined
      ? `dataset/${system}/telemetry/`
      : "dataset/Market/cloudbed-1/telemetry/";
  if (!named.includes(telemetry))
    throw new Error(`The schema of ${system} never names ${telemetry}`);
  const result = named.replaceAll(telemetry, "/data/");
  if (result.includes("dataset/")) throw new Error(`The schema of ${system} still names dataset/`);
  return result;
}

function diagnosisRules(rules: string): string {
  const [should, shouldNot] = splitOnce(rules, "\n\nWhat you SHOULD NOT do:\n\n");
  const items = shouldNot.split("\n").map((line, i) => {
    const prefix = `${i + 1}. `;
    if (!line.startsWith(prefix)) throw new Error(`Rule ${i + 1} does not start with "${prefix}"`);
    return line.slice(prefix.length);
  });
  for (const [number, start] of Object.entries(droppedRules)) {
    if (!items[Number(number) - 1]?.startsWith(start))
      throw new Error(`Rule ${number} is not "${start}"`);
  }
  const kept = items.filter((_, i) => droppedRules[i + 1] === undefined);
  return [
    replaceOnce(
      should,
      "when Executor's retrieval result is empty",
      "when a retrieval result is empty",
    ),
    "What you SHOULD NOT do:",
    kept.map((item, i) => `${i + 1}. ${item}`).join("\n"),
  ].join("\n\n");
}

function codeRules(rule: string): string {
  const [heading, list] = splitOnce(rule.trim(), "\n\n");
  const items = new Map(
    list.split("\n").map((line) => {
      const match = /^(\d+)\. (.*)$/.exec(line);
      if (match === null)
        throw new Error(`Executor rule line does not start with a number: ${line}`);
      return [Number(match[1]), match[2] ?? ""];
    }),
  );
  return [
    heading,
    keptCodeRules
      .map((number, i) => {
        const item = items.get(number);
        if (item === undefined) throw new Error(`No executor rule ${number}`);
        return `${i + 1}. ${item.trim()}`;
      })
      .join("\n"),
  ].join("\n\n");
}

function readCandidates(cand: string): Candidates {
  const sections = new Map<string, string[]>();
  let section: string[] = [];
  for (const line of cand.split("\n")) {
    const heading = /^## POSSIBLE ROOT CAUSE (COMPONENTS|REASONS):/.exec(line)?.[1];
    if (heading !== undefined) {
      section = [];
      sections.set(heading, section);
    } else if (line.startsWith("- ")) {
      section.push(line.slice(2).trim());
    }
  }
  return { components: sections.get("COMPONENTS") ?? [], reasons: sections.get("REASONS") ?? [] };
}

function replaceOnce(text: string, from: string, to: string): string {
  const [before, after] = splitOnce(text, from);
  return `${before}${to}${after}`;
}

function splitOnce(text: string, separator: string): [string, string] {
  const at = text.indexOf(separator);
  if (at < 0 || text.indexOf(separator, at + 1) >= 0) {
    throw new Error(`Expected exactly one ${JSON.stringify(separator.slice(0, 60))}`);
  }
  return [text.slice(0, at), text.slice(at + separator.length)];
}
