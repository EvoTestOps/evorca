/**
 * The full-screen view of `evorca watch`. A header gives the facts of the run,
 * and a board shows each of its tasks as a dot, like an LED: dark while the
 * task waits, blinking while it runs, lit once it has an answer, and `×` for
 * any other outcome. Below them, a feed shows the trajectory of one task as a
 * log with timestamps: the instruction, each response with its time and cost,
 * the thinking summaries, the agent's text, each command and the output that
 * the agent sees, and the answer. Long output folds to a few lines.
 *
 * It reads the run folder once a second through `watch-folder.ts` and never
 * changes the run. It draws only the grays of the shell.
 *
 * @module
 */
// @jsxRuntime automatic
// @jsxImportSource @opentui/react
import { relative } from "node:path";
import { createCliRenderer, type KeyEvent, type ScrollBoxRenderable } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Footer, gutter, Hints, Mark, palette } from "./parts.js";
import { readRunFolders, type Frame, type RunFolders } from "./watch-folder.js";
import {
  nextRow,
  nextRunning,
  outcomeCounts,
  secondsLeft,
  spentUsd,
  type BoardTask,
  type FeedEntry,
  type RunState,
  type Selection,
} from "./watch.js";

type Fact = readonly [value: string, label: string];

type Look = { readonly glyph: string; readonly ink: string };

const pollMs = 1000;
const live: Selection = { kind: "live" };
const foldLines = 6;
const dot = "•";
const hints = [
  ["↑↓", "scroll"],
  ["end", "tail"],
  ["o", "output"],
  ["←→", "task"],
  ["tab", "running"],
  ["f", "live"],
] as const;
const logLines = 4;
const looks = {
  pending: { glyph: dot, ink: palette.border },
  running: { glyph: dot, ink: palette.bright },
  blink: { glyph: dot, ink: palette.border },
  answered: { glyph: dot, ink: palette.text },
  other: { glyph: "×", ink: palette.muted },
} satisfies Record<string, Look>;
const voices: Readonly<
  Record<FeedEntry["kind"], { readonly label: string; readonly ink: string }>
> = {
  task: { label: "task", ink: palette.text },
  turn: { label: "turn", ink: palette.muted },
  think: { label: "think", ink: palette.muted },
  say: { label: "agent", ink: palette.text },
  run: { label: "$", ink: palette.bright },
  answer: { label: "answer", ink: palette.bright },
  note: { label: "note", ink: palette.muted },
};
const labelWidth = Math.max(...Object.values(voices).map((voice) => voice.label.length));

/**
 * Draws the run that `folders` names full screen, and follows it as it grows
 * until the user quits.
 */
export async function openWatch(folders: RunFolders): Promise<void> {
  const renderer = await createCliRenderer({
    useMouse: false,
    backgroundColor: palette.background,
  });
  createRoot(renderer).render(
    <Watch
      read={readRunFolders(folders)}
      wallTime={() => new Date()}
      onExit={() => renderer.destroy()}
    />,
  );
}

/**
 * The props of {@link Watch}. `read` reads the run and the trajectory of the
 * task that a selection picks, and `wallTime` returns the time to measure
 * the elapsed time against. `log` returns the lines that the runner has
 * printed, for a view that runs the run itself. The view shows the last of
 * them, and reads them again each time it draws, about once a second.
 * Without `onExit`, `q` does nothing and the hints name ctrl+c to stop the
 * run instead. `children` go above the hints, such as the input line of the
 * shell. While `keys` is false, the view leaves its keys to them.
 */
export type WatchProps = {
  readonly read: (selection: Selection) => Promise<Frame>;
  readonly wallTime: () => Date;
  readonly onExit?: (() => void) | undefined;
  readonly log?: (() => readonly string[]) | undefined;
  readonly keys?: boolean | undefined;
  readonly children?: ReactNode;
};

/**
 * The whole screen. It reads again a second after each read ends, and at
 * once when the selection changes, and it goes back to the live task when the
 * run on screen changes. It calls `onExit` on `q`.
 */
export function Watch({
  read,
  wallTime,
  onExit,
  log = () => [],
  keys = true,
  children,
}: WatchProps) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const [selection, setSelection] = useState<Selection>(live);
  const [frame, setFrame] = useState<Frame>({ kind: "waiting", message: "Reading the run…" });
  const [problem, setProblem] = useState<string | undefined>();
  const [tailing, setTailing] = useState(true);
  const [unfolded, setUnfolded] = useState(false);
  const scroll = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof renderer.clock.setTimeout> | undefined;
    const tick = () =>
      read(selection)
        .then(
          (next) => {
            if (stopped) return;
            setFrame(next);
            setProblem(undefined);
          },
          (error: unknown) => {
            if (!stopped) setProblem(error instanceof Error ? error.message : String(error));
          },
        )
        .finally(() => {
          if (!stopped) timer = renderer.clock.setTimeout(tick, pollMs);
        });
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) renderer.clock.clearTimeout(timer);
    };
  }, [read, renderer, selection]);

  const board = frame.kind === "run" ? frame.board : [];
  const row = frame.kind === "run" ? frame.row : undefined;
  const folder = frame.kind === "run" ? frame.state.folder : undefined;

  useEffect(() => scrollTo(() => Infinity), [row]);
  useEffect(() => setSelection((current) => (current.kind === "live" ? current : live)), [folder]);

  function pick(next: number | undefined) {
    if (next !== undefined) setSelection({ kind: "task", row: next });
  }

  function scrollTo(top: (box: ScrollBoxRenderable) => number) {
    const box = scroll.current;
    if (box === null) return;
    box.scrollTo(top(box));
    setTailing(box.scrollTop + box.viewport.height >= box.scrollHeight);
  }

  const actions: Readonly<Record<string, () => void>> = {
    ...(onExit === undefined ? {} : { q: onExit }),
    left: () => pick(nextRow(board, row, -1)),
    right: () => pick(nextRow(board, row, 1)),
    tab: () => pick(nextRunning(board, row)),
    f: () => setSelection(live),
    o: () => setUnfolded((unfolded) => !unfolded),
    up: () => scrollTo((box) => box.scrollTop - 1),
    down: () => scrollTo((box) => box.scrollTop + 1),
    pageup: () => scrollTo((box) => box.scrollTop - box.viewport.height),
    pagedown: () => scrollTo((box) => box.scrollTop + box.viewport.height),
    home: () => scrollTo(() => 0),
    end: () => scrollTo(() => Infinity),
  };

  useKeyboard((key: KeyEvent) => {
    if (!keys || key.ctrl || key.meta || !Object.hasOwn(actions, key.name)) return;
    key.preventDefault();
    actions[key.name]?.();
  });

  const now = wallTime().getTime();
  const task = board.find((task) => task.row === row);
  const running = task?.state.kind === "running";
  const logTail = log()
    .filter((line) => line.trim() !== "")
    .slice(-logLines);
  const lastTurn =
    frame.kind === "run" ? frame.feed.findLastIndex(({ kind }) => kind === "turn") : -1;
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={palette.background}>
      <box flexDirection="column" flexGrow={1} paddingX={gutter} paddingTop={1}>
        {frame.kind === "waiting" ? (
          <box flexDirection="column" flexGrow={1}>
            <Mark />
            <text fg={palette.muted} marginTop={1}>
              {frame.message}
            </text>
          </box>
        ) : (
          <>
            <Header state={frame.state} board={board} now={now} />
            <Board board={board} row={row} blink={Math.floor(now / pollMs) % 2 === 1} />
            <TaskLine
              task={task}
              feed={frame.feed}
              live={selection.kind === "live"}
              tailing={tailing}
              now={now}
            />
            <scrollbox
              ref={scroll}
              stickyScroll
              stickyStart="bottom"
              scrollbarOptions={{ visible: false }}
              flexGrow={1}
              width="100%"
              marginTop={1}
            >
              {frame.feed.map((entry, index) => (
                <Entry
                  key={index}
                  entry={entry}
                  unfolded={unfolded}
                  open={running && index > lastTurn}
                />
              ))}
            </scrollbox>
          </>
        )}
        {logTail.length === 0 ? null : (
          <box flexDirection="column" flexShrink={0} marginTop={1}>
            {logTail.map((line, index) => (
              <text key={index} fg={palette.muted} wrapMode="none">
                {line}
              </text>
            ))}
          </box>
        )}
        {problem === undefined ? null : (
          <text fg={palette.muted} flexShrink={0}>
            {problem}
          </text>
        )}
        {children}
        <box border={["top"]} borderColor={palette.border} flexShrink={0} marginTop={1}>
          <Hints
            hints={[...hints, onExit === undefined ? ["ctrl+c", "stop"] : ["q", "quit"]]}
            width={width - 2 * gutter}
          />
        </box>
      </box>
      <Footer
        directory={frame.kind === "run" ? relative(process.cwd(), frame.state.folder) : ""}
        width={width}
      />
    </box>
  );
}

function Header({
  state,
  board,
  now,
}: {
  readonly state: RunState;
  readonly board: readonly BoardTask[];
  readonly now: number;
}) {
  const { record, scores } = state;
  const { series, model, budgetUsd, jobs } = record;
  const done = board.filter((task) => task.state.kind === "done").length;
  const resumed = record.resumes.at(-1);
  const started = Date.parse(resumed?.startedAt ?? record.startedAt);
  const ended = record.endedAt === null ? now : Date.parse(record.endedAt);
  const left = record.endedAt === null ? secondsLeft(board, jobs) : undefined;
  const spent = spentUsd(state);
  const run: Fact[] = [
    [record.scenario, ""],
    ...(series === undefined ? [] : [[`run ${series.run}`, `of ${series.runs}`] as const]),
    [record.runId, ""],
    ...(model === null ? [] : [[model.id, model.effort] as const]),
  ];
  const progress: Fact[] = [
    [`${done}/${board.length}`, "tasks"],
    ...outcomeCounts(board).map(([outcome, count]): Fact => [String(count), outcome]),
    ...(spent === undefined
      ? []
      : [[usd(spent), budgetUsd === null ? "spent" : `of ${usd(budgetUsd)}`] as const]),
    [
      duration((ended - started) / 1000),
      resumed !== undefined ? "since resume" : record.endedAt === null ? "elapsed" : "in all",
    ],
    ...(left === undefined ? [] : [[`about ${duration(left)}`, "left, estimated"] as const]),
    ...(scores === undefined
      ? []
      : [
          [percent(scores.summary.total.strict), "strict"] as const,
          [percent(scores.summary.total.partial), "partial"] as const,
        ]),
  ];
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" gap={3}>
        <Mark />
        <Facts facts={run} />
      </box>
      <Facts facts={progress} />
    </box>
  );
}

function Facts({ facts }: { readonly facts: readonly Fact[] }) {
  return (
    <text flexShrink={0}>
      {facts.map(([value, label], index) => (
        <span key={index}>
          <span fg={palette.bright}>{value}</span>
          <span fg={palette.muted}>
            {`${label === "" ? "" : ` ${label}`}${index < facts.length - 1 ? "   " : ""}`}
          </span>
        </span>
      ))}
    </text>
  );
}

function Board({
  board,
  row,
  blink,
}: {
  readonly board: readonly BoardTask[];
  readonly row: number | undefined;
  readonly blink: boolean;
}) {
  return (
    <text flexShrink={0} marginTop={1}>
      {board.map((task, index) => {
        const look = lookOf(task, blink);
        return (
          <span key={task.row}>
            {index === 0 ? "" : index % 10 === 0 ? "   " : " "}
            <span fg={look.ink} bg={task.row === row ? palette.border : undefined}>
              {look.glyph}
            </span>
          </span>
        );
      })}
    </text>
  );
}

function TaskLine({
  task,
  feed,
  live,
  tailing,
  now,
}: {
  readonly task: BoardTask | undefined;
  readonly feed: readonly FeedEntry[];
  readonly live: boolean;
  readonly tailing: boolean;
  readonly now: number;
}) {
  const facts: Fact[] =
    task === undefined
      ? [["no task", "has started"]]
      : [
          [`task ${String(task.row).padStart(3, "0")}`, ""],
          ...(task.taskIndex === undefined ? [] : [[task.taskIndex, ""] as const]),
          ...stateFacts(task, feed, now),
        ];
  const mode: Fact[] = [
    [live ? "live" : "picked", ""],
    tailing ? ["tailing", ""] : ["paused", "end to tail"],
  ];
  return (
    <box flexDirection="row" flexShrink={0} marginTop={1}>
      <Facts facts={facts} />
      <box flexGrow={1} />
      <Facts facts={mode} />
    </box>
  );
}

const Entry = memo(function Entry({
  entry,
  unfolded,
  open,
}: {
  readonly entry: FeedEntry;
  readonly unfolded: boolean;
  readonly open: boolean;
}) {
  const voice = voices[entry.kind];
  const text =
    entry.kind === "turn"
      ? `${entry.turn}   ${entry.seconds.toFixed(2)} s   ${usd(entry.costUsd)}`
      : entry.text;
  const result = entry.kind === "run" || entry.kind === "answer" ? entry.result : null;
  return (
    <box flexDirection="column" marginTop={entry.kind === "turn" ? 1 : 0}>
      <Line at={entry.at} label={voice.label} ink={voice.ink} text={text} />
      {result === null ? null : result === undefined ? (
        <Line label="" ink={palette.muted} text={open ? "running…" : "no result"} />
      ) : (
        <Output output={result.output} isError={result.isError} unfolded={unfolded} />
      )}
    </box>
  );
});

function Output({
  output,
  isError,
  unfolded,
}: {
  readonly output: string;
  readonly isError: boolean;
  readonly unfolded: boolean;
}) {
  const lines = output.replace(/\n$/, "").split("\n");
  const shown = unfolded || lines.length <= foldLines + 1 ? lines : lines.slice(0, foldLines);
  const hidden = lines.length - shown.length;
  const label = isError ? "error" : "";
  return (
    <box flexDirection="column">
      <Line
        label={label}
        ink={palette.text}
        text={output === "" ? "(no output)" : shown.join("\n")}
        wrap={unfolded}
      />
      {hidden === 0 ? null : (
        <Line label="" ink={palette.muted} text={`… ${hidden} more lines, o to show all`} />
      )}
    </box>
  );
}

function Line({
  at,
  label,
  ink,
  text,
  wrap = true,
}: {
  readonly at?: number;
  readonly label: string;
  readonly ink: string;
  readonly text: string;
  readonly wrap?: boolean;
}) {
  return (
    <box flexDirection="row" gap={2}>
      <text fg={palette.muted} flexShrink={0}>
        {at === undefined || Number.isNaN(at)
          ? " ".repeat(8)
          : new Date(at).toTimeString().slice(0, 8)}
      </text>
      <text fg={palette.muted} flexShrink={0}>
        {label.padEnd(labelWidth)}
      </text>
      <text fg={ink} wrapMode={wrap ? "word" : "none"}>
        {text}
      </text>
    </box>
  );
}

function lookOf({ state }: BoardTask, blink: boolean): Look {
  if (state.kind === "pending") return looks.pending;
  if (state.kind === "running") return blink ? looks.blink : looks.running;
  return state.record.outcome === "answered" ? looks.answered : looks.other;
}

function stateFacts(task: BoardTask, feed: readonly FeedEntry[], now: number): Fact[] {
  const { state } = task;
  if (state.kind === "pending") return [["pending", ""]];
  if (state.kind === "running") {
    const started = feed[0]?.at;
    return [
      ["running", ""],
      ...(started === undefined ? [] : [[duration((now - started) / 1000), ""] as const]),
      ...(state.costUsd === undefined ? [] : [[usd(state.costUsd), ""] as const]),
    ];
  }
  const { outcome, seconds, usage } = state.record;
  return [
    [outcome, ""],
    [`${seconds.toFixed(2)} s`, ""],
    ...(usage === null ? [] : [[usd(usage.costUsd), ""] as const]),
  ];
}

function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function usd(value: number): string {
  return `$${value.toFixed(value < 10 ? 4 : 2)}`;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}
