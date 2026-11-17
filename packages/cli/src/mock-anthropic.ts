/**
 * A stand-in for the Messages API, so the model proxy runs in tests and pilot
 * runs without an API key or a network. `EVORCA_UPSTREAM_URL` points the proxy
 * at it. It answers `POST /v1/messages` with a message or an error that the
 * last user message asks for, and it keeps every request it receives.
 *
 * @module
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "./models.js";

/** A request that the mock received. */
export type MockRequest = { readonly headers: IncomingHttpHeaders; readonly body: unknown };

/** A running mock of the Messages API at `url`. */
export type MockAnthropic = {
  readonly url: string;
  readonly requests: MockRequest[];
  close(): Promise<void>;
};

/**
 * What the text of the last user message asks the mock for, as JSON: the
 * `usage` of its answer, an error `status` with an error `type`, and a
 * `delayMs` before it answers. Any other text gets 10 input and 5 output tokens.
 */
export type MockAsk = {
  readonly usage?: Record<string, unknown>;
  readonly status?: number;
  readonly type?: string;
  readonly delayMs?: number;
};

/**
 * Starts the mock on an unused port of 127.0.0.1, or on `port`.
 *
 * @throws Error if the mock cannot listen.
 */
export async function startMockAnthropic(port = 0): Promise<MockAnthropic> {
  const requests: MockRequest[] = [];
  let count = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
    requests.push({ headers: req.headers, body });
    const ask = askOf(body);
    if (ask.delayMs !== undefined) await sleep(ask.delayMs);
    const id = `req_mock_${(count += 1)}`;
    const status = ask.status ?? 200;
    const answer =
      status === 200
        ? {
            id: `msg_mock_${count}`,
            type: "message",
            role: "assistant",
            model: isRecord(body) ? body.model : null,
            content: [{ type: "text", text: "mock answer" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: ask.usage ?? { input_tokens: 10, output_tokens: 5 },
          }
        : {
            type: "error",
            error: { type: ask.type ?? "api_error", message: "mock error" },
            request_id: id,
          };
    res.writeHead(status, { "content-type": "application/json", "request-id": id });
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No mock port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function askOf(body: unknown): MockAsk {
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  const last: unknown = messages.at(-1);
  const content = isRecord(last) ? last.content : undefined;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.find((block) => isRecord(block) && block.type === "text")?.text
        : undefined;
  let ask: unknown;
  try {
    ask = JSON.parse(typeof text === "string" ? text : "");
  } catch {
    return {};
  }
  if (!isRecord(ask)) return {};
  const number = (value: unknown) => (typeof value === "number" ? value : undefined);
  return {
    usage: isRecord(ask.usage) ? ask.usage : undefined,
    status: number(ask.status),
    type: typeof ask.type === "string" ? ask.type : undefined,
    delayMs: number(ask.delayMs),
  };
}
