/**
 * The model proxy, which `evorca evaluate` runs on the host for an agent that
 * calls a model. It listens on 127.0.0.1 and forwards one kind of request,
 * `POST /v1/messages` without streaming, to the Anthropic API. Each task gets
 * its own token. The proxy maps the token to the task and sends the real API
 * key upstream instead, so no container ever holds the key. It denies a request
 * that breaks the contract or that a spent budget forbids, and it appends each
 * request of a task to the task's `requests.jsonl`.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import {
  addEntry,
  budgetExhaustedError,
  costUsd,
  isRecord,
  models,
  noUsage,
  tokensOf,
  type Effort,
  type ModelId,
  type ModelUsage,
  type Prices,
  type RequestEntry,
} from "./models.js";

/**
 * What the proxy forwards to and how much it lets the run spend. `spent` is the
 * usage of the run before this session, which counts toward `budgetUsd`.
 */
export type ProxyOptions = {
  readonly upstreamUrl: string;
  readonly apiKey: string;
  readonly model: ModelId;
  readonly effort: Effort;
  readonly budgetUsd: number;
  readonly spent: ModelUsage;
};

/** A running model proxy. */
export type ModelProxy = {
  /** The port on 127.0.0.1 that the proxy listens on. */
  readonly port: number;
  /**
   * Starts accepting requests for a task. It returns the task's token, which
   * the task sends as its API key. The task may spend `budgetUsd`, and its
   * requests go to the file at `logPath`.
   */
  openTask(task: { readonly budgetUsd: number; readonly logPath: string }): string;
  /**
   * Stops accepting the token, waits for the task's requests in flight, and
   * returns the task's usage.
   */
  closeTask(token: string): Promise<ModelUsage>;
  /** Returns the usage of the run so far, `spent` included. */
  usage(): ModelUsage;
  /** Stops the proxy. */
  close(): Promise<void>;
};

type Task = {
  readonly budgetUsd: number;
  readonly logPath: string;
  usage: ModelUsage;
  open: boolean;
  readonly inFlight: Set<Promise<void>>;
  logging: Promise<void>;
};

type Denial = { readonly status: number; readonly type: string; readonly message: string };

type Policy = { readonly model: ModelId; readonly effort: Effort };

const maxBodyBytes = 32 * 2 ** 20;
const upstreamTimeoutMs = 15 * 60_000;
const forwardedResponseHeaders = [
  "content-type",
  "request-id",
  "retry-after",
  "retry-after-ms",
  "x-should-retry",
];
const clientTools = /^(bash|text_editor|memory)_\d+$/;

/**
 * The rules that a request body must meet, in the order the proxy checks them.
 * Each returns the reason it denies `body`, or undefined.
 */
const bodyRules: readonly ((
  body: Record<string, unknown>,
  policy: Policy,
) => string | undefined)[] = [
  (body) =>
    body.stream === undefined || body.stream === false
      ? undefined
      : "The model proxy does not forward streaming. Leave out stream or set it to false.",
  (body, { model }) =>
    body.model === model
      ? undefined
      : `This run calls ${model}, not ${JSON.stringify(body.model)}.`,
  (body, { model, effort }) => {
    const config = isRecord(body.output_config) ? body.output_config : {};
    const asked = config.effort ?? models[model].defaultEffort;
    return asked === effort
      ? undefined
      : `This run uses effort ${effort}, not ${JSON.stringify(asked)}. Set output_config.effort.`;
  },
  (body) =>
    !Array.isArray(body.tools) || body.tools.every(runsInContainer)
      ? undefined
      : "The model proxy forwards only tools that the agent runs itself: custom tools and the bash, text editor, and memory tools.",
  (body) =>
    body.mcp_servers === undefined
      ? undefined
      : "The model proxy does not forward mcp_servers, because the API would reach them.",
  (body) =>
    hasUrlSource([body.system, body.messages])
      ? "The model proxy does not forward URL sources, because the API would fetch them."
      : undefined,
  (body) =>
    body.inference_geo === undefined || body.inference_geo === "global"
      ? undefined
      : "The model proxy forwards only global inference, which the price table covers.",
];

/**
 * Starts the model proxy on an unused port of 127.0.0.1.
 *
 * @throws Error if the proxy cannot listen.
 */
export async function startModelProxy(options: ProxyOptions): Promise<ModelProxy> {
  const prices: Prices = models[options.model].usdPerMTok;
  const tasks = new Map<string, Task>();
  let runUsage = options.spent;

  const record = (task: Task, entry: RequestEntry) => {
    task.usage = addEntry(task.usage, entry, prices);
    runUsage = addEntry(runUsage, entry, prices);
    task.logging = task.logging.then(() => appendFile(task.logPath, `${JSON.stringify(entry)}\n`));
  };

  const server = createServer((req, res) => {
    res.on("error", () => {});
    const token = tokenOf(req.headers);
    const task = token === undefined ? undefined : tasks.get(token);
    if (task === undefined || !task.open) {
      req.resume();
      reply(res, {
        status: 401,
        type: "authentication_error",
        message: "The model proxy does not know this API key.",
      });
      return;
    }
    const handled = handle(req, res, task).catch(() => {
      reply(res, { status: 500, type: "api_error", message: "The model proxy failed." });
    });
    task.inFlight.add(handled);
    void handled.finally(() => task.inFlight.delete(handled));
  });

  const deny = (res: ServerResponse, task: Task, denial: Denial) => {
    record(task, {
      kind: "denied",
      at: new Date().toISOString(),
      status: denial.status,
      error: denial.type,
    });
    reply(res, denial);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, task: Task) => {
    if (req.method !== "POST" || req.url !== "/v1/messages") {
      req.resume();
      return deny(res, task, {
        status: 404,
        type: "not_found_error",
        message: "The model proxy forwards only POST /v1/messages.",
      });
    }
    if (task.usage.costUsd >= task.budgetUsd || runUsage.costUsd >= options.budgetUsd) {
      req.resume();
      const spent = task.usage.costUsd >= task.budgetUsd ? "task's" : "run's";
      return deny(res, task, {
        status: 403,
        type: budgetExhaustedError,
        message: `The ${spent} budget is spent. Answer with what you have.`,
      });
    }
    const body = await readBody(req);
    if (body === undefined) {
      return deny(res, task, {
        status: 413,
        type: "request_too_large",
        message: `The request is larger than ${maxBodyBytes} bytes.`,
      });
    }
    const denial = check(req.headers, body, options);
    if (denial !== undefined) return deny(res, task, denial);

    const started = performance.now();
    const at = new Date().toISOString();
    const upstream = await forward(options, req.headers, body).catch(() => undefined);
    const seconds = Math.round(performance.now() - started) / 1000;
    if (upstream === undefined) {
      record(task, {
        kind: "forwarded",
        at,
        status: 502,
        seconds,
        requestId: null,
        error: "upstream_unreachable",
        tokens: null,
        costUsd: 0,
      });
      return reply(res, {
        status: 502,
        type: "api_error",
        message: "The model proxy could not reach the Anthropic API.",
      });
    }
    const parsed = parseJson(upstream.body.toString("utf8"));
    const succeeded = upstream.status === 200;
    const tokens = succeeded && isRecord(parsed) ? (tokensOf(parsed.usage) ?? null) : null;
    const error = succeeded
      ? null
      : isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.type === "string"
        ? parsed.error.type
        : `http_${upstream.status}`;
    record(task, {
      kind: "forwarded",
      at,
      status: upstream.status,
      seconds,
      requestId: upstream.headers["request-id"] ?? null,
      error,
      tokens,
      costUsd: tokens === null ? 0 : costUsd(tokens, prices),
    });
    res.writeHead(upstream.status, { ...upstream.headers, "content-length": upstream.body.length });
    res.end(upstream.body);
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No proxy port.");

  return {
    port: address.port,
    openTask({ budgetUsd, logPath }) {
      const token = `evorca-${randomBytes(24).toString("base64url")}`;
      tasks.set(token, {
        budgetUsd,
        logPath,
        usage: noUsage,
        open: true,
        inFlight: new Set(),
        logging: Promise.resolve(),
      });
      return token;
    },
    async closeTask(token) {
      const task = tasks.get(token);
      if (task === undefined) return noUsage;
      task.open = false;
      await Promise.all(task.inFlight);
      await task.logging;
      tasks.delete(token);
      return task.usage;
    },
    usage: () => runUsage,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function check(headers: IncomingHttpHeaders, text: Buffer, policy: Policy): Denial | undefined {
  const invalid = (message: string): Denial => ({
    status: 400,
    type: "invalid_request_error",
    message,
  });
  if (headers["anthropic-beta"] !== undefined) {
    return invalid("The model proxy does not forward beta features. Leave out anthropic-beta.");
  }
  const body = parseJson(text.toString("utf8"));
  if (!isRecord(body)) return invalid("The request body must be a JSON object.");
  for (const rule of bodyRules) {
    const reason = rule(body, policy);
    if (reason !== undefined) return invalid(reason);
  }
  return undefined;
}

async function forward(
  { upstreamUrl, apiKey }: ProxyOptions,
  headers: IncomingHttpHeaders,
  body: Buffer,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const url = new URL(`${upstreamUrl.replace(/\/$/, "")}/v1/messages`);
  const version = header(headers, "anthropic-version");
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const upstream = send(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          "x-api-key": apiKey,
          ...(version === undefined ? {} : { "anthropic-version": version }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          const kept = forwardedResponseHeaders.flatMap((name) => {
            const value = header(response.headers, name);
            return value === undefined ? [] : [[name, value] as const];
          });
          resolve({
            status: response.statusCode ?? 502,
            headers: Object.fromEntries(kept),
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    upstream.once("error", reject);
    // Longer than the 10 minutes that the SDKs wait for a response without streaming.
    upstream.setTimeout(upstreamTimeoutMs, () => upstream.destroy(new Error("Timed out.")));
    upstream.end(body);
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) continue;
    bytes += chunk.length;
    if (bytes <= maxBodyBytes) chunks.push(chunk);
  }
  return bytes > maxBodyBytes ? undefined : Buffer.concat(chunks);
}

function reply(res: ServerResponse, { status, type, message }: Denial) {
  const body = JSON.stringify({ type: "error", error: { type, message } });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "x-should-retry": String(status >= 500),
  });
  res.end(body);
}

function runsInContainer(tool: unknown): boolean {
  if (!isRecord(tool)) return false;
  const { type } = tool;
  return (
    type === undefined || type === "custom" || (typeof type === "string" && clientTools.test(type))
  );
}

function hasUrlSource(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUrlSource);
  if (!isRecord(value)) return false;
  if (isRecord(value.source) && value.source.type === "url") return true;
  return Object.values(value).some(hasUrlSource);
}

/** The task's token, which the SDK sends as `Authorization: Bearer` and curl as `x-api-key`. */
function tokenOf(headers: IncomingHttpHeaders): string | undefined {
  const bearer = /^Bearer (\S+)$/.exec(header(headers, "authorization") ?? "")?.[1];
  return bearer ?? header(headers, "x-api-key");
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
