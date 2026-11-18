import { describe, expect, it } from "vitest";
import { relayRunArgs, taskNetworkArgs } from "./relay.js";

function valuesOf(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, i) => (args[i - 1] === flag ? [arg] : []));
}

describe("taskNetworkArgs", () => {
  it("creates an internal network without a gateway address, with the run's label", () => {
    const args = taskNetworkArgs("20261117T120000Z-react", "evorca-20261117T120000Z-react-bank-3");

    expect(args.slice(0, 2)).toEqual(["network", "create"]);
    expect(args).toContain("--internal");
    expect(valuesOf(args, "--opt")).toEqual(["com.docker.network.bridge.inhibit_ipv4=true"]);
    expect(valuesOf(args, "--label")).toEqual(["evorca.run=20261117T120000Z-react"]);
    expect(args.at(-1)).toBe("evorca-20261117T120000Z-react-bank-3");
  });
});

describe("relayRunArgs", () => {
  it("runs the relay locked down, labeled, and pointed at the proxy's port on the host", () => {
    const args = relayRunArgs("20261117T120000Z-react", 51234);

    expect(valuesOf(args, "--name")).toEqual(["evorca-20261117T120000Z-react-relay"]);
    expect(valuesOf(args, "--label")).toEqual(["evorca.run=20261117T120000Z-react"]);
    expect(valuesOf(args, "--add-host")).toEqual(["host.docker.internal:host-gateway"]);
    expect(valuesOf(args, "--env")).toEqual(["EVORCA_PROXY_PORT=51234"]);
    expect(args).toContain("--read-only");
    expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
    expect(valuesOf(args, "--user")).toEqual(["65534:65534"]);
    expect(valuesOf(args, "--network")).toEqual([]);
    expect(valuesOf(args, "--publish")).toEqual([]);
  });

  it("never passes an API key", () => {
    expect(relayRunArgs("20261117T120000Z-react", 51234).join(" ")).not.toContain("API_KEY");
  });
});
