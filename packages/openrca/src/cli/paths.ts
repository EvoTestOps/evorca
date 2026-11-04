/**
 * The directories that the command-line tools use, at the repository root.
 *
 * @module
 */
import { fileURLToPath } from "node:url";

/** `data/openrca/`, which holds `<system>/query.csv` and `<system>/record.csv`. */
export const dataDir = fileURLToPath(new URL("../../../../data/openrca/", import.meta.url));

/** `.cache/`, which holds the OpenRCA checkout and the evaluator's Python environment. */
export const cacheDir = fileURLToPath(new URL("../../../../.cache/", import.meta.url));
