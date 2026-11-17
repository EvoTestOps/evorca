import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startMockAnthropic, type MockAnthropic } from "./mock-anthropic.js";
import { noUsage, type RequestEntry } from "./models.js";
import { startModelProxy, type ModelProxy, type ProxyOptions } from "./proxy.js";

const realKey = "sk-ant-real-key-sentinel";
const model = "claude-sonnet-5";

let mock: MockAnthropic;
let proxy: ModelProxy;
let dir: string;

async function start(options: Partial<ProxyOptions> = {}) {
  proxy = await startModelProxy({
    upstreamUrl: mock.url,
    apiKey: realKey,
    model,
    effort: "high",
    budgetUsd: 10,
    spent: noUsage,
    ...options,
  });
}

function open(budgetUsd = 2, name = "task") {
  const logPath = join(dir, `${name}.jsonl`);
  return { token: proxy.openTask({ budgetUsd, logPath }), logPath };
}

function client(token: string, maxRetries = 0) {
  return new Anthropic({ baseURL: `http://127.0.0.1:${proxy.port}`, apiKey: token, maxRetries });
}

function ask(text: object | string) {
  const content = typeof text === "string" ? text : JSON.stringify(text);
  return { model, max_tokens: 100, messages: [{ role: "user" as const, content }] };
}

async function post(token: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": token, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function entries(logPath: string): Promise<RequestEntry[]> {
  const text = await readFile(logPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evorca-proxy-"));
  mock = await startMockAnthropic();
  await start();
});

afterEach(async () => {
  await proxy.close();
  await mock.close();
});

describe("the model proxy", () => {
  it("forwards a request with the real key in place of the task's token", async () => {
    const { token, logPath } = open();
    const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 };

    const message = await client(token).messages.create(ask({ usage }));

    expect(message.usage.input_tokens).toBe(1000);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.headers["x-api-key"]).toBe(realKey);
    expect(JSON.stringify(mock.requests[0])).not.toContain(token);
    expect(await proxy.closeTask(token)).toMatchObject({
      requests: 1,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 5000,
      costUsd: 0.005,
    });
    expect(await entries(logPath)).toMatchObject([
      { kind: "forwarded", status: 200, error: null, costUsd: 0.005 },
    ]);
    expect(await readFile(logPath, "utf8")).not.toContain(realKey);
  });

  it.each<[string, unknown, Record<string, string>]>([
    ["streaming", { ...ask("hi"), stream: true }, {}],
    ["another model", { ...ask("hi"), model: "claude-opus-5-5" }, {}],
    ["another effort", { ...ask("hi"), output_config: { effort: "max" } }, {}],
    ["a server tool", { ...ask("hi"), tools: [{ type: "web_fetch_20250910", name: "f" }] }, {}],
    [
      "a URL source",
      {
        ...ask("hi"),
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "url", url: "https://example.com/a" } }],
          },
        ],
      },
      {},
    ],
    ["MCP servers", { ...ask("hi"), mcp_servers: [] }, {}],
    ["US inference", { ...ask("hi"), inference_geo: "us" }, {}],
    ["a beta header", ask("hi"), { "anthropic-beta": "compact-2026-01-12" }],
    ["a body that is not JSON", "{", {}],
  ])("denies %s with 400 and forwards nothing", async (_, body, headers) => {
    const { token, logPath } = open();

    const response = await post(token, body, headers);

    expect(response).toMatchObject({
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error" } },
    });
    expect(mock.requests).toHaveLength(0);
    expect(await proxy.closeTask(token)).toMatchObject({ requests: 0, deniedRequests: 1 });
    expect(await entries(logPath)).toMatchObject([
      { kind: "denied", status: 400, error: "invalid_request_error" },
    ]);
  });

  it("forwards custom tools, the client tools, and the run's effort", async () => {
    const { token } = open();
    const tools = [
      { name: "sql", input_schema: { type: "object" } },
      { type: "custom", name: "python", input_schema: { type: "object" } },
      { type: "bash_20250124", name: "bash" },
    ];

    const response = await post(token, { ...ask("hi"), tools, output_config: { effort: "high" } });

    expect(response.status).toBe(200);
    expect(mock.requests).toHaveLength(1);
  });

  it("denies an unknown token with 401 and another path with 404", async () => {
    const { token } = open();

    const unknown = client("evorca-unknown").messages.create(ask("hi"));
    await expect(unknown).rejects.toBeInstanceOf(Anthropic.AuthenticationError);
    const models = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`, {
      headers: { "x-api-key": token },
    });
    expect(models.status).toBe(404);
    expect(mock.requests).toHaveLength(0);
  });

  it("denies with 403 evorca_budget_exhausted once the task's budget is spent, and the SDK does not retry", async () => {
    const { token } = open(0.01);
    const sdk = client(token, 2);
    const usage = { input_tokens: 3000 };
    const sixMillicents = { usage: { ...usage, output_tokens: 0 } };

    await sdk.messages.create(ask(sixMillicents));
    await sdk.messages.create(ask(sixMillicents));
    const third = await sdk.messages.create(ask(sixMillicents)).catch((error: unknown) => error);

    expect(third).toBeInstanceOf(Anthropic.PermissionDeniedError);
    expect(third).toMatchObject({ status: 403, type: "evorca_budget_exhausted" });
    expect(mock.requests).toHaveLength(2);
    expect(await proxy.closeTask(token)).toMatchObject({
      requests: 2,
      deniedRequests: 1,
      budgetExhausted: true,
      costUsd: 0.012,
    });
  });

  it("denies every task once the run's budget is spent, counting what the run spent before", async () => {
    await proxy.close();
    await start({ budgetUsd: 1, spent: { ...noUsage, inputTokens: 497_500, costUsd: 0.995 } });
    const first = open(2, "first");
    const second = open(2, "second");
    const costly = { usage: { input_tokens: 5000, output_tokens: 0 } };

    await client(first.token).messages.create(ask(costly));
    const denied = await post(second.token, ask(costly));

    expect(denied).toMatchObject({
      status: 403,
      body: {
        error: {
          type: "evorca_budget_exhausted",
          message: expect.stringContaining("run's budget"),
        },
      },
    });
    expect(proxy.usage().costUsd).toBe(1.005);
  });

  it("passes an upstream error through, counts it, and lets the SDK retry it", async () => {
    const { token } = open();

    const failed = client(token, 1)
      .messages.create(ask({ status: 529, type: "overloaded_error" }))
      .catch((error: unknown) => error);

    expect(await failed).toMatchObject({ status: 529, type: "overloaded_error" });
    expect(mock.requests).toHaveLength(2);
    expect(await proxy.closeTask(token)).toMatchObject({
      requests: 2,
      upstreamErrors: 2,
      costUsd: 0,
    });
  });

  it("answers 502 when the API cannot be reached", async () => {
    await proxy.close();
    await start({ upstreamUrl: "http://127.0.0.1:9" });
    const { token, logPath } = open();

    const response = await post(token, ask("hi"));

    expect(response).toMatchObject({ status: 502, body: { error: { type: "api_error" } } });
    expect(await proxy.closeTask(token)).toMatchObject({ requests: 1, upstreamErrors: 1 });
    expect(await entries(logPath)).toMatchObject([
      { kind: "forwarded", status: 502, error: "upstream_unreachable", tokens: null },
    ]);
  });

  it("closes a task after its requests in flight, then denies its token", async () => {
    const { token } = open();
    const slow = { delayMs: 200, usage: { input_tokens: 10, output_tokens: 1 } };

    const inFlight = post(token, ask(slow));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const usage = await proxy.closeTask(token);

    expect(usage).toMatchObject({ requests: 1, inputTokens: 10 });
    expect((await inFlight).status).toBe(200);
    expect((await post(token, ask("hi"))).status).toBe(401);
  });
});
