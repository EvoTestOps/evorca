/**
 * What happens when the user submits a line: the transcript entries it adds,
 * or an exit. The module owns the table of slash commands.
 *
 * @module
 */

/** One message in the transcript. */
export type Entry = { readonly role: "you" | "evorca"; readonly text: string };

/** The result of submitting a line: entries to append to the transcript, or an exit. */
export type Outcome =
  { readonly kind: "append"; readonly entries: readonly Entry[] } | { readonly kind: "exit" };

type Command = { readonly description: string; readonly run: () => Outcome };

const commands: Readonly<Record<string, Command>> = {
  "/help": { description: "List the commands", run: () => reply(help()) },
  "/exit": { description: "Exit evorca", run: () => ({ kind: "exit" }) },
};

/**
 * Returns the outcome of submitting `line`. A line that starts with `/` runs
 * the command of that name. Any other line is a message for the agent, which
 * is not connected yet. The trimmed line comes first in the appended entries,
 * and a blank line appends nothing.
 */
export function submit(line: string): Outcome {
  const text = line.trim();
  if (text === "") return { kind: "append", entries: [] };
  const outcome = text.startsWith("/")
    ? (commands[text]?.run() ?? reply(`Unknown command ${text}. Type /help for commands.`))
    : reply("No agent is connected yet.");
  if (outcome.kind === "exit") return outcome;
  return { kind: "append", entries: [{ role: "you", text }, ...outcome.entries] };
}

function reply(text: string): Outcome {
  return { kind: "append", entries: [{ role: "evorca", text }] };
}

function help(): string {
  const width = Math.max(...Object.keys(commands).map((name) => name.length));
  return Object.entries(commands)
    .map(([name, { description }]) => `${name.padEnd(width)}  ${description}`)
    .join("\n");
}
