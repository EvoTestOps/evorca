/**
 * Summarizes evaluator scores as the two accuracies per difficulty that
 * OpenRCA's `main/evaluate.py` reports.
 *
 * @module
 */
import { difficultyOf, type Difficulty } from "../tasks.js";
import type { ScoredRow } from "./evaluator.js";

/**
 * The accuracy over a set of tasks. `strict` is the share of tasks with a score
 * of 1, and `partial` is the mean score. Both are 0 for an empty set.
 */
export type Accuracy = {
  readonly tasks: number;
  readonly strict: number;
  readonly partial: number;
};

/** The accuracy per difficulty and over all tasks, in the key order easy, middle, hard, total. */
export type Summary = Readonly<Record<Difficulty | "total", Accuracy>>;

/** Computes the accuracy per difficulty and over all rows, which may come in any order. */
export function summarize(rows: readonly ScoredRow[]): Summary {
  const byLevel = Object.groupBy(rows, (row) => difficultyOf[row.taskIndex]);
  return {
    easy: accuracy(byLevel.easy ?? []),
    middle: accuracy(byLevel.middle ?? []),
    hard: accuracy(byLevel.hard ?? []),
    total: accuracy(rows),
  };
}

function accuracy(rows: readonly ScoredRow[]): Accuracy {
  if (rows.length === 0) return { tasks: 0, strict: 0, partial: 0 };
  const perfect = rows.reduce((count, row) => (row.score === 1 ? count + 1 : count), 0);
  const sum = rows.reduce((total, row) => total + row.score, 0);
  return { tasks: rows.length, strict: perfect / rows.length, partial: sum / rows.length };
}
