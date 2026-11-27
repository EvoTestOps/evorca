/**
 * What happens when the user submits a line: the transcript entries it adds,
 * the benchmark picker, or an exit. The module owns the table of slash
 * commands.
 *
 * @module
 */

/** One message in the transcript, with the local time when it was added. */
export type Entry = { readonly role: "you" | "evorca"; readonly text: string; readonly at: Date };

/**
 * The result of submitting a line: entries to append to the transcript, those
 * entries and a request to open the benchmark picker, or an exit.
 */
export type Outcome =
  | { readonly kind: "append" | "benchmark"; readonly entries: readonly Entry[] }
  | { readonly kind: "exit" };

type Response =
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "benchmark" }
  | { readonly kind: "exit" };

type Command = { readonly description: string; readonly run: () => Response };

const commands: Readonly<Record<string, Command>> = {
  "/help": { description: "List the commands", run: () => reply(help()) },
  "/benchmark": {
    description: "Pick scenarios, tasks, and an agent, and run them",
    run: () => ({ kind: "benchmark" }),
  },
  "/exit": { description: "Exit evorca", run: () => ({ kind: "exit" }) },
};

/**
 * Returns the outcome of submitting `line` at the time `at`. A line that
 * starts with `/` runs the command of that name. Any other line is a message
 * for the agent, which is not connected yet. The appended entries are the
 * trimmed line and the reply, both at `at`. `/benchmark` has no reply, so it
 * appends only the line. A blank line appends nothing.
 */
export function submit(line: string, at: Date): Outcome {
  const text = line.trim();
  if (text === "") return { kind: "append", entries: [] };
  const response = text.startsWith("/")
    ? (commands[text]?.run() ?? reply(`Unknown command ${text}. Type /help for commands.`))
    : reply("No agent is connected yet.");
  if (response.kind === "exit") return response;
  if (response.kind === "benchmark")
    return { kind: "benchmark", entries: [{ role: "you", text, at }] };
  return {
    kind: "append",
    entries: [
      { role: "you", text, at },
      { role: "evorca", text: response.text, at },
    ],
  };
}

function reply(text: string): Response {
  return { kind: "reply", text };
}

function help(): string {
  const width = Math.max(...Object.keys(commands).map((name) => name.length));
  return Object.entries(commands)
    .map(([name, { description }]) => `${name.padEnd(width)}  ${description}`)
    .join("\n");
}
