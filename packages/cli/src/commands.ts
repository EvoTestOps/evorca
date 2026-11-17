/**
 * What happens when the user submits a line: the transcript entries it adds,
 * or an exit. The module owns the table of slash commands.
 *
 * @module
 */

/** One message in the transcript, with the local time when it was added. */
export type Entry = { readonly role: "you" | "evorca"; readonly text: string; readonly at: Date };

/** The result of submitting a line: entries to append to the transcript, or an exit. */
export type Outcome =
  { readonly kind: "append"; readonly entries: readonly Entry[] } | { readonly kind: "exit" };

type Response = { readonly kind: "reply"; readonly text: string } | { readonly kind: "exit" };

type Command = { readonly description: string; readonly run: () => Response };

const commands: Readonly<Record<string, Command>> = {
  "/help": { description: "List the commands", run: () => reply(help()) },
  "/exit": { description: "Exit evorca", run: () => ({ kind: "exit" }) },
};

/**
 * Returns the outcome of submitting `line` at the time `at`. A line that
 * starts with `/` runs the command of that name. Any other line is a message
 * for the agent, which is not connected yet. The appended entries are the
 * trimmed line and the reply, both at `at`. A blank line appends nothing.
 */
export function submit(line: string, at: Date): Outcome {
  const text = line.trim();
  if (text === "") return { kind: "append", entries: [] };
  const response = text.startsWith("/")
    ? (commands[text]?.run() ?? reply(`Unknown command ${text}. Type /help for commands.`))
    : reply("No agent is connected yet.");
  if (response.kind === "exit") return response;
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
