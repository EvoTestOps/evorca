/**
 * Parses the CSV files that OpenRCA and its evaluator write.
 *
 * Fields in these files often span several lines, because instructions,
 * scoring points, and predictions contain newlines.
 *
 * @module
 */
import { parse } from "csv-parse/sync";

/**
 * Parses CSV text into one record per data row, in file order, keyed by the column
 * names in its first row, which must include every name in `columns`.
 *
 * @throws Error if the header lacks one of `columns` or the text is not valid CSV.
 */
export function parseCsv<const C extends string>(
  text: string,
  columns: readonly C[],
): Record<C, string>[] {
  const records = parse<Record<string, string>>(text, {
    columns: (header: string[]) => {
      const missing = columns.filter((column) => !header.includes(column));
      if (missing.length > 0) throw new Error(`CSV is missing columns: ${missing.join(", ")}`);
      return header;
    },
  });
  return records as Record<C, string>[];
}
