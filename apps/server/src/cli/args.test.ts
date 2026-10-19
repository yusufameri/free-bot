import { describe, expect, test } from "bun:test";
import {
  envProviderMode,
  envSpendCapNanoUsd,
  envTokenPrices,
  envWorkspace,
  pageUrl,
  parseUpArgs,
  UP_USAGE,
} from "./args.ts";
import { envSandboxBackend, parseSandboxBackendValue } from "./sandbox-backend.ts";

describe("parseUpArgs", () => {
  test("no flags takes a free port on both legs, opens a browser, and asks the vault", () => {
    expect(parseUpArgs([], {})).toEqual({
      apiPort: 0,
      tunnelPort: 0,
      open: true,
      providerMode: "auto",
      sandbox: "auto",
      sandboxSource: "default",
      transcript: null,
      connectors: null,
      workspace: null,
      spendCapNanoUsd: null,
      prices: null,
      help: false,
    });
  });

  test("--api-port and --tunnel-port pin the two legs", () => {
    expect(parseUpArgs(["--api-port", "8080", "--tunnel-port", "8081"], {})).toEqual({
      apiPort: 8080,
      tunnelPort: 8081,
      open: true,
      providerMode: "auto",
      sandbox: "auto",
      sandboxSource: "default",
      transcript: null,
      connectors: null,
      workspace: null,
      spendCapNanoUsd: null,
      prices: null,
      help: false,
    });
  });

  test("--transcript and --connectors name the two files a driver pins, and both take a path", () => {
    expect(
      parseUpArgs(["--transcript", "/tmp/turn.jsonl", "--connectors", "/tmp/c.json"], {}),
    ).toEqual({
      apiPort: 0,
      tunnelPort: 0,
      open: true,
      providerMode: "auto",
      sandbox: "auto",
      sandboxSource: "default",
      transcript: "/tmp/turn.jsonl",
      connectors: "/tmp/c.json",
      workspace: null,
      spendCapNanoUsd: null,
      prices: null,
      help: false,
    });
    expect(parseUpArgs([], { FREEBOT_TRANSCRIPT: "/tmp/t.jsonl" }).transcript).toBe("/tmp/t.jsonl");
    expect(parseUpArgs([], { FREEBOT_CONNECTORS: "/tmp/c.json" }).connectors).toBe("/tmp/c.json");
    expect(parseUpArgs([], { FREEBOT_TRANSCRIPT: "" }).transcript).toBeNull();
    expect(() => parseUpArgs(["--transcript"], {})).toThrow("--transcript needs a path");
    expect(() => parseUpArgs(["--connectors", "--replay"], {})).toThrow(
      "--connectors needs a path",
    );
  });

  test("--no-open leaves the browser alone", () => {
    expect(parseUpArgs(["--no-open"], {}).open).toBe(false);
  });

  test("--live demands the vault and --replay records, and the last flag wins", () => {
    expect(parseUpArgs(["--live"], {}).providerMode).toBe("live");
    expect(parseUpArgs(["--replay"], {}).providerMode).toBe("replay");
    expect(parseUpArgs(["--live", "--replay"], {}).providerMode).toBe("replay");
    expect(parseUpArgs(["--replay", "--live"], {}).providerMode).toBe("live");
  });

  test("FREEBOT_PROVIDER sets the default a launched process starts with", () => {
    expect(parseUpArgs([], { FREEBOT_PROVIDER: "replay" }).providerMode).toBe("replay");
    expect(parseUpArgs(["--live"], { FREEBOT_PROVIDER: "replay" }).providerMode).toBe("live");
    expect(envProviderMode({ FREEBOT_PROVIDER: "live" })).toBe("live");
    expect(envProviderMode({ FREEBOT_PROVIDER: "keyed" })).toBeNull();
    expect(envProviderMode({})).toBeNull();
  });

  test("FREEBOT_SPEND_CAP_USD sets the cap, and a malformed one is refused at boot", () => {
    expect(parseUpArgs([], { FREEBOT_SPEND_CAP_USD: "0.25" }).spendCapNanoUsd).toBe(250_000_000);
    expect(envSpendCapNanoUsd({})).toBeNull();
    expect(envSpendCapNanoUsd({ FREEBOT_SPEND_CAP_USD: "" })).toBeNull();
    expect(() => envSpendCapNanoUsd({ FREEBOT_SPEND_CAP_USD: "a dollar" })).toThrow(
      "FREEBOT_SPEND_CAP_USD is not a USD amount",
    );
    expect(parseUpArgs(["--help"], { FREEBOT_SPEND_CAP_USD: "a dollar" }).help).toBe(true);
  });

  test("the four token prices are all four or none, and a finer-than-nano price is refused", () => {
    const prices = {
      FREEBOT_PRICE_INPUT_PER_MTOK: "3.00",
      FREEBOT_PRICE_OUTPUT_PER_MTOK: "15.00",
      FREEBOT_PRICE_CACHE_READ_PER_MTOK: "0.30",
      FREEBOT_PRICE_CACHE_WRITE_PER_MTOK: "3.75",
    };
    expect(envTokenPrices(prices)).toEqual({
      inputPerMTok: "3.00",
      outputPerMTok: "15.00",
      cacheReadPerMTok: "0.30",
      cacheWritePerMTok: "3.75",
    });
    expect(envTokenPrices({})).toBeNull();
    expect(() => envTokenPrices({ FREEBOT_PRICE_INPUT_PER_MTOK: "3.00" })).toThrow(
      "token prices are all four or none",
    );
    expect(() =>
      envTokenPrices({ ...prices, FREEBOT_PRICE_OUTPUT_PER_MTOK: "0.0000000001" }),
    ).toThrow("a configured token price is unusable");
  });

  test("FREEBOT_WORKSPACE moves the Bots directory, and an empty one means the default", () => {
    expect(parseUpArgs([], { FREEBOT_WORKSPACE: "/tmp/ws" }).workspace).toBe("/tmp/ws");
    expect(envWorkspace({ FREEBOT_WORKSPACE: "/tmp/ws" })).toBe("/tmp/ws");
    expect(envWorkspace({ FREEBOT_WORKSPACE: "" })).toBeNull();
    expect(envWorkspace({})).toBeNull();
  });

  test("--sandbox names the backend, and the flag wins over FREEBOT_SANDBOX", () => {
    const fromFlag = parseUpArgs(["--sandbox", "microsandbox"], {});
    expect(fromFlag.sandbox).toBe("microsandbox");
    expect(fromFlag.sandboxSource).toBe("--sandbox");
    const fromEnv = parseUpArgs([], { FREEBOT_SANDBOX: "docker" });
    expect(fromEnv.sandbox).toBe("docker");
    expect(fromEnv.sandboxSource).toBe("FREEBOT_SANDBOX");
    const flagWins = parseUpArgs(["--sandbox", "docker"], { FREEBOT_SANDBOX: "microsandbox" });
    expect(flagWins.sandbox).toBe("docker");
    expect(flagWins.sandboxSource).toBe("--sandbox");
    expect(parseUpArgs(["--sandbox", "auto"], {}).sandbox).toBe("auto");
  });

  test("a backend this launcher does not have is refused by name, never guessed at", () => {
    expect(() => parseUpArgs(["--sandbox", "e2b"], {})).toThrow(
      '--sandbox names no backend: "e2b"; use docker, microsandbox or auto',
    );
    expect(() => parseUpArgs(["--sandbox"], {})).toThrow(
      "--sandbox needs a backend id: docker, microsandbox or auto",
    );
    expect(() => parseUpArgs(["--sandbox", "--no-open"], {})).toThrow(
      "--sandbox needs a backend id: docker, microsandbox or auto",
    );
    expect(() => envSandboxBackend({ FREEBOT_SANDBOX: "boat" })).toThrow(
      'FREEBOT_SANDBOX="boat" names no sandbox backend; use docker, microsandbox, auto',
    );
    expect(envSandboxBackend({})).toBeNull();
    expect(envSandboxBackend({ FREEBOT_SANDBOX: "" })).toBeNull();
    expect(parseSandboxBackendValue("auto")).toBe("auto");
    expect(parseSandboxBackendValue("firecracker")).toBeNull();
  });

  test("an invalid FREEBOT_SANDBOX cannot refuse a flag or help", () => {
    const flagWins = parseUpArgs(["--sandbox", "docker"], { FREEBOT_SANDBOX: "boat" });
    expect(flagWins.sandbox).toBe("docker");
    expect(flagWins.sandboxSource).toBe("--sandbox");
    const help = parseUpArgs(["--help"], { FREEBOT_SANDBOX: "boat" });
    expect(help.help).toBe(true);
    expect(help.sandboxSource).toBe("default");
  });

  test("an unknown flag is refused and named", () => {
    expect(() => parseUpArgs(["--port", "1"], {})).toThrow('unknown flag "--port"');
  });

  test("a value that is not a port is refused", () => {
    expect(() => parseUpArgs(["--api-port", "http"], {})).toThrow(
      "--api-port needs an integer port",
    );
    expect(() => parseUpArgs(["--tunnel-port"], {})).toThrow("--tunnel-port needs a port number");
  });

  test("--help is read without the rest of the line having to parse", () => {
    expect(parseUpArgs(["--help"], {}).help).toBe(true);
  });
});

describe("pageUrl", () => {
  test("the operator token rides the fragment, which no browser sends to a server", () => {
    expect(pageUrl(51234, "tok")).toBe("http://127.0.0.1:51234/#token=tok");
  });
});

describe("UP_USAGE", () => {
  test("names the command and every flag, so --help is the whole contract", () => {
    for (const flag of [
      "--no-open",
      "--live",
      "--replay",
      "--sandbox",
      "--api-port",
      "--tunnel-port",
      "-h, --help",
    ]) {
      expect(UP_USAGE).toContain(flag);
    }
    expect(UP_USAGE.split("\n")[0]).toBe("usage: bun run up [flags]");
  });
});
