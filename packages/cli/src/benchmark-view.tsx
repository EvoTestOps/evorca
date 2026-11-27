/**
 * The `/benchmark` picker in the shell. It draws the step that `benchmark.ts`
 * models, with a dot for each line like the board of `evorca watch`: lit when
 * chosen, dark when not, and `×` when it cannot be chosen. It turns keys into
 * the picker's actions, and shows a window of the lines around the cursor.
 *
 * @module
 */
// @jsxRuntime automatic
// @jsxImportSource @opentui/react
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useState } from "react";
import {
  blockerOf,
  commandOf,
  estimateOf,
  itemsOf,
  openPicker,
  planOf,
  tasksOf,
  update,
  type Action,
  type Catalog,
  type Item,
  type Plan,
  type Step,
} from "./benchmark.js";
import { gutter, Hints, palette } from "./parts.js";

/**
 * The props of {@link BenchmarkPicker}. `seed` is the seed of the run that it
 * picks. It calls `onCancel` when the user leaves its first step, and
 * `onStart` when the user confirms the run.
 */
export type BenchmarkPickerProps = {
  readonly catalog: Catalog;
  readonly seed: number;
  readonly onCancel: () => void;
  readonly onStart: (plan: Plan) => void;
};

const actions: Readonly<Record<string, Action>> = {
  up: "up",
  down: "down",
  space: "toggle",
  left: "left",
  right: "right",
  return: "next",
  escape: "back",
  e: "easy",
  m: "middle",
  h: "hard",
};
const titles: Readonly<Record<Step, string>> = {
  scenarios: "Scenarios",
  tasks: "Tasks",
  agent: "Agent and runs",
  confirm: "Run",
};
const hints: Readonly<Record<Step, readonly (readonly [string, string])[]>> = {
  scenarios: [
    ["↑↓", "move"],
    ["space", "choose"],
    ["enter", "next"],
    ["esc", "close"],
  ],
  tasks: [
    ["↑↓", "move"],
    ["space", "choose"],
    ["e m h", "easy, middle, hard"],
    ["enter", "next"],
    ["esc", "back"],
  ],
  agent: [
    ["↑↓", "move"],
    ["←→", "change"],
    ["enter", "next"],
    ["esc", "back"],
  ],
  confirm: [
    ["enter", "run"],
    ["esc", "back"],
  ],
};
const chrome = 8;
const labelWidth = 8;
const labelGap = 2;

/** The picker, from its first step to the confirmed run. */
export function BenchmarkPicker({ catalog, seed, onCancel, onStart }: BenchmarkPickerProps) {
  const { width, height } = useTerminalDimensions();
  const [picker, setPicker] = useState(() => openPicker(catalog, seed));

  useKeyboard((key) => {
    const action = actions[key.name];
    if (key.ctrl || key.meta || action === undefined) return;
    const next = update(picker, action, catalog);
    if (next === "cancel") onCancel();
    else if (next === "start") onStart(planOf(picker, catalog));
    else setPicker(next);
  });

  const items = itemsOf(picker, catalog);
  const blocker = blockerOf(picker, catalog);
  const size = Math.max(1, height - chrome - (blocker === undefined ? 0 : 1));
  const start = Math.max(0, Math.min(items.length - size, picker.cursor - Math.floor(size / 2)));
  const step = Object.keys(titles).indexOf(picker.step) + 1;
  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <text flexShrink={0}>
        <span fg={palette.bright}>{titles[picker.step]}</span>
        <span fg={palette.muted}>{`   openrca, step ${step} of 4`}</span>
      </text>
      <box flexDirection="column" flexGrow={1} marginTop={1}>
        {picker.step === "confirm" ? (
          <Confirm plan={planOf(picker, catalog)} catalog={catalog} width={width - 2 * gutter} />
        ) : (
          items
            .slice(start, start + size)
            .map((item, index) => (
              <Line key={start + index} item={item} cursor={start + index === picker.cursor} />
            ))
        )}
      </box>
      <text fg={palette.muted} flexShrink={0}>
        {blocker ?? ""}
      </text>
      <box border={["top"]} borderColor={palette.border} flexShrink={0}>
        <Hints hints={hints[picker.step]} width={width - 2 * gutter} />
      </box>
    </box>
  );
}

function Line({ item, cursor }: { readonly item: Item; readonly cursor: boolean }) {
  const [dot, text, note] = partsOf(item);
  return (
    <box flexDirection="row" flexShrink={0}>
      <text flexShrink={0}>
        <span fg={palette.bright}>{cursor ? "› " : "  "}</span>
        <span fg={dot}>{item.kind === "scenario" && item.problem !== undefined ? "×" : "•"}</span>
        <span fg={cursor ? palette.bright : palette.text}>{` ${text}`}</span>
      </text>
      <text fg={palette.muted} wrapMode={item.kind === "task" ? "none" : "word"} flexShrink={1}>
        {note === "" ? "" : `   ${note}`}
      </text>
    </box>
  );
}

function partsOf(item: Item): readonly [dot: string, text: string, note: string] {
  const ink = (chosen: boolean) => (chosen ? palette.bright : palette.border);
  switch (item.kind) {
    case "scenario": {
      const { scenario, tasks, telemetry } = item.data;
      const facts = `${tasks.length} tasks, ${telemetry ? "with" : "no"} telemetry`;
      return [ink(item.chosen), scenario.padEnd(17), item.problem ?? facts];
    }
    case "group":
      return [ink(item.chosen > 0), item.scenario, `${item.chosen} of ${item.tasks} tasks`];
    case "task": {
      const { row, taskIndex, instruction } = item.task;
      const label = `  ${String(row).padStart(3, "0")}  ${taskIndex}  ${item.difficulty.padEnd(6)}`;
      return [ink(item.chosen), label, instruction.replaceAll(/\s+/g, " ")];
    }
    case "setting":
      return [palette.muted, `${item.label.padEnd(12)} ${item.value}`, ""];
  }
}

function Confirm({
  plan,
  catalog,
  width,
}: {
  readonly plan: Plan;
  readonly catalog: Catalog;
  readonly width: number;
}) {
  const estimate = estimateOf(plan, catalog);
  const scenarios = plan.scenarios.map((scenario) => {
    const whole = catalog.scenarios.find((data) => data.scenario === scenario)?.tasks.length;
    const rows = plan.rows.get(scenario)?.length ?? whole;
    return `${scenario} ${rows} of ${whole}`;
  });
  const facts: (readonly [string, string])[] = [
    ["tasks", `${tasksOf(plan, catalog)} per run: ${scenarios.join(", ")}`],
    ["agent", `${plan.agent}, ${plan.runs} ${plan.runs === 1 ? "run" : "runs"}, seed ${plan.seed}`],
    ...(plan.model === undefined
      ? []
      : ([
          ["model", `${plan.model} ${plan.effort}`],
          ["budget", `$${plan.budgetUsd} per run, $${plan.taskBudgetUsd} per task`],
          [
            "estimate",
            estimate === undefined
              ? "none, no finished run of this agent and model"
              : `about $${estimate.usd.toFixed(2)}, at $${estimate.perTaskUsd.toFixed(4)} per task over ${estimate.from} tasks of finished runs`,
          ],
        ] as const)),
    ["command", commandOf(plan, width - labelWidth - labelGap)],
  ];
  return (
    <box flexDirection="column">
      {facts.map(([label, value]) => (
        <box key={label} flexDirection="row" gap={labelGap}>
          <text fg={palette.muted} flexShrink={0}>
            {label.padEnd(labelWidth)}
          </text>
          <text fg={label === "command" ? palette.bright : palette.text}>{value}</text>
        </box>
      ))}
    </box>
  );
}
