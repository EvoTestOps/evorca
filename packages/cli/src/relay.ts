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
fetch("${proxyUrl}/v1/messages", { method: "POST" })
  .then((response) => response.json())
  .then((body) => process.exit(body.error.type === "authentication_error" ? 0 : 1))
  .catch(() => process.exit(1));
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
  /** Creates the task network `network` and connects the relay to it as `evorca-proxy`. */
  openNetwork(network: string): Promise<void>;
  /** Disconnects the relay from the task network `network` and removes the network. */
  closeNetwork(network: string): Promise<void>;
};

/**
 * Starts the relay of run `runId` to the proxy on the host's port `proxyPort`.
 * Then it checks that a container on a task network gets the proxy's answer
 * through the relay.
 *
 * @throws Error if the relay does not start, or if the container gets no answer.
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
      await run("docker", ["network", "connect", "--alias", "evorca-proxy", network, name]);
    },
    async closeNetwork(network) {
      await run("docker", ["network", "disconnect", "--force", network, name]);
      await run("docker", ["network", "rm", network]);
    },
  };
  const network = `evorca-${runId}-check`;
  await relay.openNetwork(network);
  const check = await run("docker", [
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
    () => true,
    () => false,
  );
  await relay.closeNetwork(network);
  if (!check) {
    throw new Error(
      `A container on a task network got no answer from the model proxy through ${name}.`,
    );
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
