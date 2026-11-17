/**
 * The interactive shell that `evorca` opens: a banner, the transcript, and an
 * input box pinned to the bottom of the screen. It applies the outcome that
 * `commands.ts` returns for each submitted line.
 *
 * The JSX pragmas below repeat `tsconfig.json`, because `pnpm evorca` runs tsx
 * from the repository root, where tsx finds no `tsconfig.json`.
 *
 * @module
 */
// @jsxRuntime automatic
// @jsxImportSource @opentui/react
import { RGBA, TextAttributes, type InputRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRef, useState } from "react";
import packageJson from "../package.json" with { type: "json" };
import { banner } from "./banner.js";
import { submit, type Entry } from "./commands.js";

const colors = {
  accent: "#2dd4bf",
  accentEnd: "#818cf8",
  dim: "#6b7280",
  text: RGBA.defaultForeground(),
} as const;

const prompt = "❯";
const paddingX = 2;
const bannerWidth = Math.max(...banner.map((row) => row.length));
const bannerColors = banner.map((_, row) =>
  mix(RGBA.fromHex(colors.accent), RGBA.fromHex(colors.accentEnd), row / (banner.length - 1)),
);

/** The props of {@link Shell}. `directory` is the working directory as the user should read it. */
export type ShellProps = { readonly directory: string; readonly onExit: () => void };

/** The whole screen. It calls `onExit` on `/exit` and on ctrl+c. */
export function Shell({ directory, onExit }: ShellProps) {
  const [transcript, setTranscript] = useState<readonly Entry[]>([]);
  const input = useRef<InputRenderable>(null);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") onExit();
  });

  function onSubmit(line: string) {
    if (input.current) input.current.value = "";
    const outcome = submit(line);
    if (outcome.kind === "exit") onExit();
    else setTranscript((entries) => [...entries, ...outcome.entries]);
  }

  return (
    <box flexDirection="column" width="100%" height="100%" paddingX={paddingX} paddingY={1}>
      <Header directory={directory} />
      <scrollbox
        stickyScroll
        stickyStart="bottom"
        scrollbarOptions={{ visible: false }}
        flexGrow={1}
        marginY={1}
        paddingLeft={2}
      >
        {transcript.map((entry, index) => (
          <box
            key={index}
            flexDirection="row"
            marginTop={entry.role === "you" && index > 0 ? 1 : 0}
          >
            <text fg={colors.accent} flexShrink={0}>
              {entry.role === "you" ? `${prompt} ` : "  "}
            </text>
            <text fg={colors.text}>{entry.text}</text>
          </box>
        ))}
      </scrollbox>
      <box
        border
        borderStyle="rounded"
        borderColor={colors.dim}
        paddingX={1}
        flexDirection="row"
        flexShrink={0}
      >
        <text fg={colors.accent} flexShrink={0}>{`${prompt} `}</text>
        <input
          ref={input}
          focused
          flexGrow={1}
          flexShrink={1}
          placeholder="Describe an incident to investigate"
          placeholderColor={colors.dim}
          textColor={colors.text}
          focusedTextColor={colors.text}
          cursorColor={colors.accent}
          onSubmit={onSubmit}
        />
      </box>
      <text fg={colors.dim} paddingLeft={2} flexShrink={0}>
        ctrl+c to exit
      </text>
    </box>
  );
}

function Header({ directory }: { readonly directory: string }) {
  const { width } = useTerminalDimensions();
  return (
    <box flexDirection="column" flexShrink={0}>
      {width >= bannerWidth + 2 * paddingX ? (
        banner.map((row, index) => (
          <text key={index} fg={bannerColors[index]}>
            {row}
          </text>
        ))
      ) : (
        <text fg={colors.accent} attributes={TextAttributes.BOLD}>
          evorca
        </text>
      )}
      <text fg={colors.dim} marginTop={1}>{`v${packageJson.version} · ${directory}`}</text>
      <text fg={colors.text}>Type a message, or /help for commands.</text>
    </box>
  );
}

function mix(from: RGBA, to: RGBA, t: number): RGBA {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return RGBA.fromValues(lerp(from.r, to.r), lerp(from.g, to.g), lerp(from.b, to.b));
}
