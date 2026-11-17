import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openRcaCandidates } from "./candidates.js";
import { parseCsv } from "./csv.js";

const dataDir = fileURLToPath(new URL("../../../data/benchmarks/openrca/", import.meta.url));

describe.each(Object.entries(openRcaCandidates))("the candidates of %s", (scenario, candidates) => {
  it.each(Object.entries(candidates))("list each of the %s once, trimmed", (_, names) => {
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name !== name.trim())).toEqual([]);
  });

  const record = join(dataDir, scenario, "record.csv");
  it.skipIf(!existsSync(record))("include every component and reason in record.csv", async () => {
    const failures = parseCsv(await readFile(record, "utf8"), ["component", "reason"]);

    const components = failures.map((failure) => failure.component);
    const reasons = failures.map((failure) => failure.reason);
    expect(components.filter((name) => !candidates.components.includes(name))).toEqual([]);
    expect(reasons.filter((name) => !candidates.reasons.includes(name))).toEqual([]);
  });
});
