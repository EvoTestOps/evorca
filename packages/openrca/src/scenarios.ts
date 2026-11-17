/**
 * The OpenRCA scenarios and where each scenario's files live. A scenario is one
 * OpenRCA system under a slug that works in a path and on a command line, such
 * as `market-cloudbed-1` for `Market/cloudbed-1`.
 *
 * @module
 */
import { join } from "node:path";

/** The four OpenRCA scenarios, keyed by slug, with the OpenRCA system of each. */
export const openRcaScenarios = {
  bank: "Bank",
  telecom: "Telecom",
  "market-cloudbed-1": "Market/cloudbed-1",
  "market-cloudbed-2": "Market/cloudbed-2",
} as const;

/** The slug of one OpenRCA scenario, such as `market-cloudbed-1`. */
export type OpenRcaScenario = keyof typeof openRcaScenarios;

/** The name of one OpenRCA system, such as `Market/cloudbed-1`. */
export type OpenRcaSystem = (typeof openRcaScenarios)[OpenRcaScenario];

/**
 * A file that every scenario has. `query.csv` holds the tasks and their scoring
 * points, and `record.csv` lists the failures behind them.
 */
export type ScenarioFile = "query.csv" | "record.csv";

/** The path of a scenario's file in `dataDir`, which holds one directory per scenario. */
export function scenarioPath(
  dataDir: string,
  scenario: OpenRcaScenario,
  file: ScenarioFile,
): string {
  return join(dataDir, scenario, file);
}
