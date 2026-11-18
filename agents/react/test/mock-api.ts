/**
 * A scripted stand-in for the Messages API. It answers each `POST /v1/messages`
 * with the next scripted reply and records the raw request bodies and headers, so a test
 * can point the real SDK at it and check what the agent sent.
 *
 * It uses only Node's built-in modules, so `node test/mock-api.ts <replies>
 * <port>` also serves the replies in a JSON file from a container.
 *
 * @module
 */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted reply: an HTTP status and a JSON body. */
export type Reply = { readonly status: number; readonly body: unknown };

/** A running mock. `requests` holds the raw body of each request, in order, and `headers` its headers. */
export type MockApi = {
  readonly url: string;
  readonly requests: string[];
  readonly headers: IncomingHttpHeaders[];
  close(): Promise<void>;
};

/** Starts a mock that serves `replies` in order, and a 500 once they run out. */
export async function startMockApi(
  replies: readonly Reply[],
  { host = "127.0.0.1", port = 0 } = {},
): Promise<MockApi> {
  const requests: string[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method !== "POST" || request.url !== "/v1/messages") {
      response.writeHead(404).end();
      return;
    }
    requests.push(body);
    headers.push(request.headers);
    const reply = replies[requests.length - 1] ?? {
      status: 500,
      body: { type: "error", error: { type: "api_error", message: "No scripted reply left" } },
    };
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("The mock has no port");
  return {
    url: `http://${host}:${address.port}`,
    requests,
    headers,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

type Usage = {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
};

let counter = 0;

/** A 200 reply with a model message of `content`. */
export function message(
  content: readonly unknown[],
  options: {
    readonly stopReason?: string;
    readonly usage?: Usage;
    readonly stopDetails?: unknown;
  } = {},
): Reply {
  const { stopReason = "tool_use", usage = {}, stopDetails = null } = options;
  counter += 1;
  return {
    status: 200,
    body: {
      id: `msg_${counter}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: stopDetails,
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    },
  };
}

/** A tool call. */
export function toolUse(name: string, input: unknown): unknown {
  counter += 1;
  return { type: "tool_use", id: `toolu_${counter}`, name, input };
}

/** A call of the bash tool. */
export function bashCall(command: string): unknown {
  return toolUse("bash", { command });
}

/** A call of `submit_answer` with one root cause per entry. */
export function submitCall(
  rootCauses: readonly {
    readonly occurrence_datetime: string | null;
    readonly component: string | null;
    readonly reason: string | null;
  }[],
): unknown {
  return toolUse("submit_answer", { root_causes: rootCauses });
}

/** A summarized thinking block and a text block. */
export function thought(text: string): unknown[] {
  return [
    { type: "thinking", thinking: text, signature: "c2lnbmF0dXJl" },
    { type: "text", text },
  ];
}

/** An API error reply. */
export function apiError(status: number, type: string, text = type): Reply {
  return { status, body: { type: "error", error: { type, message: text } } };
}

if (import.meta.main) {
  const [path, port] = process.argv.slice(2);
  if (path === undefined || port === undefined)
    throw new Error("Usage: mock-api.ts <replies.json> <port>");
  const replies: Reply[] = JSON.parse(await readFile(path, "utf8"));
  const mock = await startMockApi(replies, { host: "0.0.0.0", port: Number(port) });
  console.log(`Mock Messages API on ${mock.url} with ${replies.length} replies`);
}
