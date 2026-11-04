/**
 * Summarizes evaluator scores as OpenRCA's accuracy metrics.
 *
 * OpenRCA reports two accuracies per difficulty. Strict accuracy is the share
 * of tasks with a score of 1, and partial accuracy is the mean score. As in
 * OpenRCA's `main/evaluate.py`, `task_1` to `task_3` are easy, `task_4` to
 * `task_6` are middle, and `task_7` is hard.
 *
 * @module
 */
import type { TaskIndex } from "../tasks.js";
import type { ScoredRow } from "./evaluator.js";

/** An OpenRCA difficulty level. */
export type Difficulty = "easy" | "middle" | "hard";

/** The accuracy over a set of tasks. Both accuracies are 0 for an empty set. */
export type Accuracy = {
  /** The number of tasks. */
  readonly tasks: number;
  /** The share of tasks with a score of 1, from 0 to 1. */
  readonly strict: number;
  /** The mean score, from 0 to 1. */
  readonly partial: number;
};

/** The accuracy per difficulty and over all tasks, in the key order easy, middle, hard, total. */
export type Summary = Readonly<Record<Difficulty | "total", Accuracy>>;

const difficulty: Record<TaskIndex, Difficulty> = {
  task_1: "easy",
  task_2: "easy",
  task_3: "easy",
  task_4: "middle",
  task_5: "middle",
  task_6: "middle",
  task_7: "hard",
};

/**
 * Computes OpenRCA's accuracy metrics.
 *
 * @param rows - The scores, in any order.
 * @returns The accuracy per difficulty and over all rows.
 */
export function summarize(rows: readonly ScoredRow[]): Summary {
  const accuracy = (scores: readonly number[]): Accuracy => ({
    tasks: scores.length,
    strict: scores.length === 0 ? 0 : scores.filter((score) => score === 1).length / scores.length,
    partial:
      scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + score, 0) / scores.length,
  });
  const scoresOf = (level: Difficulty) =>
    rows.filter((row) => difficulty[row.taskIndex] === level).map((row) => row.score);
  return {
    easy: accuracy(scoresOf("easy")),
    middle: accuracy(scoresOf("middle")),
    hard: accuracy(scoresOf("hard")),
    total: accuracy(rows.map((row) => row.score)),
  };
}
