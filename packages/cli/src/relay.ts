/**
 * The network path from a task's container to the model proxy. The proxy
 * listens on the host's 127.0.0.1. One relay container per run forwards TCP
 * from its port 8080 to the proxy through `host.docker.internal`. Each task gets
 * its own internal Docker network that holds only the task's container and the
 * relay, which the network names `evorca-proxy`. The network has no gateway
 * address, so the task's container reaches no other host, not even the host or
 * Docker's virtual machine. The relay's port 8080 is all it can reach.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { runLabel } from "./agents.js";
import { isRecord } from "./models.js";

const run = promisify(execFile);

/** The URL at which a task's container reaches the model proxy. */
export const proxyUrl = "http://evorca-proxy:8080";

const relayImage =
  "node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5";

const relayScript = `
const net = require("node:net");
const port = Number(process.env.EVORCA_PROXY_PORT);
net.createServer((client) => {
  const proxy = net.connect(port, "host.docker.internal");
  client.pipe(proxy).pipe(client);
  client.on("error", () => proxy.destroy()).on("close", () => proxy.destroy());
  proxy.on("error", () => client.destroy()).on("close", () => client.destroy());
}).listen(8080, () => console.log("ready"));
`;

const checkScript = `
const dns = require("node:dns/promises");
const fs = require("node:fs");
const net = require("node:net");
const reaches = (host, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
(async () => {
  const problems = [];
  const answer = await fetch("${proxyUrl}/v1/messages", { method: "POST" })
    .then((response) => response.json())
    .catch(() => undefined);
  if (answer?.error?.type !== "authentication_error") problems.push("no answer from the proxy");
  const routes = fs.readFileSync("/proc/net/route", "utf8").split("\\n").slice(1);
  if (routes.some((line) => line.split("\\t")[1] === "00000000")) problems.push("a default route");
  const resolver = new dns.Resolver({ timeout: 2000, tries: 1 });
  if (await resolver.resolve4("api.anthropic.com").then(() => true, () => false)) problems.push("DNS");
  if (await reaches("1.1.1.1", 443)) problems.push("a connection to 1.1.1.1:443");
  console.log(problems.join(", "));
  process.exit(problems.length === 0 ? 0 : 1);
})();
`;

const lockedDown = [
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--user",
  "65534:65534",
];

/**
 * Returns the arguments of `docker run` for the relay of run `runId` to the
 * proxy on the host's port `proxyPort`. The relay runs in the background as an
 * unprivileged user, with the run's label, on Docker's default bridge network.
 */
export function relayRunArgs(runId: string, proxyPort: number): string[] {
  return [
    "run",
    "--detach",
    "--rm",
    "--init",
    "--name",
    relayName(runId),
    "--label",
    `${runLabel}=${runId}`,
    "--add-host",
    "host.docker.internal:host-gateway",
    ...lockedDown,
    "--memory",
    "64m",
    "--pids-limit",
    "32",
    "--env",
    `EVORCA_PROXY_PORT=${proxyPort}`,
    relayImage,
    "node",
    "-e",
    relayScript,
  ];
}

/**
 * Returns the arguments of `docker network create` for a task's network: an
 * internal network without a gateway address, with the run's label.
 */
export function taskNetworkArgs(runId: string, network: string): string[] {
  return [
    "network",
    "create",
    "--internal",
    "--opt",
    "com.docker.network.bridge.inhibit_ipv4=true",
    "--label",
    `${runLabel}=${runId}`,
    network,
  ];
}

/** The relay of a run, which joins and leaves the networks of the run's tasks. */
export type Relay = {
  /**
   * Creates the task network `network` and connects the relay to it as
   * `evorca-proxy`.
   *
   * @throws Error if Docker gave the network a gateway address, through which
   *   a task could reach Docker's virtual machine.
   */
  openNetwork(network: string): Promise<void>;
  /** Disconnects the relay from the task network `network` and removes the network. */
  closeNetwork(network: string): Promise<void>;
  /**
   * Checks that the relay still runs.
   *
   * @throws Error if it has stopped, so the tasks that ran lost the model.
   */
  assertRunning(): Promise<void>;
};

/**
 * Starts the relay of run `runId` to the proxy on the host's port `proxyPort`.
 * Then it checks that a container on a task network gets the proxy's answer
 * through the relay, and that it has no default route, no DNS, and no route to
 * 1.1.1.1.
 *
 * @throws Error if the relay does not start, or if the check fails.
 */
export async function startRelay(runId: string, proxyPort: number): Promise<Relay> {
  const name = relayName(runId);
  await run("docker", relayRunArgs(runId, proxyPort));
  for (let attempt = 0; ; attempt += 1) {
    const logs = await run("docker", ["logs", name]);
    if (logs.stdout.includes("ready")) break;
    if (attempt === 100) throw new Error(`The model relay did not start: ${logs.stderr}`);
    await sleep(100);
  }
  const relay: Relay = {
    async openNetwork(network) {
      await run("docker", taskNetworkArgs(runId, network));
      const format = "{{range .IPAM.Config}}{{.Gateway}}{{end}}";
      const gateway = await run("docker", ["network", "inspect", "--format", format, network]);
      if (gateway.stdout.trim() !== "") {
        throw new Error(
          `Docker gave the network ${network} the gateway address ${gateway.stdout.trim()}, so a task could reach Docker's virtual machine.`,
        );
      }
      await run("docker", ["network", "connect", "--alias", "evorca-proxy", network, name]);
    },
    async closeNetwork(network) {
      await run("docker", ["network", "disconnect", "--force", network, name]);
      await run("docker", ["network", "rm", network]);
    },
    async assertRunning() {
      const state = await run("docker", ["inspect", "--format", "{{.State.Running}}", name]).then(
        (result) => result.stdout.trim(),
        () => "gone",
      );
      if (state !== "true") {
        throw new Error(`The model relay ${name} stopped, so the running tasks lost the model.`);
      }
    },
  };
  const network = `evorca-${runId}-check`;
  await relay.openNetwork(network);
  const problems = await run("docker", [
    "run",
    "--rm",
    "--network",
    network,
    "--label",
    `${runLabel}=${runId}`,
    ...lockedDown,
    relayImage,
    "node",
    "-e",
    checkScript,
  ]).then(
    () => undefined,
    (error: unknown) => (isRecord(error) && typeof error.stdout === "string" ? error.stdout : ""),
  );
  await relay.closeNetwork(network);
  if (problems !== undefined) {
    const found = problems.trim() || "no answer";
    throw new Error(`A container on a task network found ${found}. It must reach only the proxy.`);
  }
  return relay;
}

/**
 * Removes every network that carries the run's label. Call it after the run's
 * containers are gone.
 */
export async function removeRunNetworks(runId: string): Promise<void> {
  const filter = `label=${runLabel}=${runId}`;
  const listed = await run("docker", ["network", "ls", "--quiet", "--filter", filter]);
  const ids = listed.stdout.split("\n").filter((id) => id !== "");
  if (ids.length > 0) await run("docker", ["network", "rm", ...ids]);
}

function relayName(runId: string): string {
  return `evorca-${runId}-relay`;
}
