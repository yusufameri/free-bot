import { describe, expect, test } from "bun:test";
import {
  CONTAINER_PREFIX,
  containerName,
  DEFAULT_STATE_DIR,
  DEFAULT_UNIT,
  DockerAdapter,
  freebotLabels,
  PROVIDER_LABEL,
  SANDBOX_LABEL,
  SandboxError,
  type SandboxProvider,
  UNIT_LABEL,
  UnsupportedCapabilityError,
  validateSandboxSpec,
} from "./index.ts";

function specError(spec: Parameters<typeof validateSandboxSpec>[0]): SandboxError {
  try {
    validateSandboxSpec(spec);
  } catch (error) {
    if (error instanceof SandboxError) return error;
    throw error;
  }
  throw new Error("expected validateSandboxSpec to throw");
}

describe("spec validation", () => {
  test("accepts a spec the Docker surface can express", () => {
    expect(() =>
      validateSandboxSpec({
        name: "bot-a",
        env: { OPENAI_BASE_URL: "http://host.docker.internal:39412" },
        mounts: [{ host: "/tmp/work", container: "/workspace", readOnly: true }],
        stateDir: "/var/freebot",
        labels: { app: "freebot" },
        idleTtlMs: 1000,
      }),
    ).not.toThrow();
  });

  test("rejects names Docker cannot carry, with literal messages", () => {
    expect(specError({ name: "Bot A" }).message).toBe(
      'invalid sandbox name: "Bot A" (lowercase letters, digits and dashes, max 48 chars)',
    );
    expect(specError({ name: "" }).code).toBe("invalid_spec");
    expect(specError({ name: `a${"b".repeat(48)}` }).message).toBe(
      `invalid sandbox name: "a${"b".repeat(48)}" (lowercase letters, digits and dashes, max 48 chars)`,
    );
  });

  test("rejects env keys docker would refuse", () => {
    expect(specError({ name: "bot-a", env: { "1BAD": "x" } }).message).toBe(
      "invalid env key: 1BAD",
    );
    expect(specError({ name: "bot-a", env: { GOOD: "a\nb" } }).message).toBe(
      "env value has a newline: GOOD",
    );
  });

  test("rejects mounts that are relative or collide with Docker's CSV syntax", () => {
    expect(
      specError({ name: "bot-a", mounts: [{ host: "relative", container: "/workspace" }] }).message,
    ).toBe("invalid mount host (must be absolute): relative");
    expect(
      specError({ name: "bot-a", mounts: [{ host: "/tmp/w", container: "workspace" }] }).message,
    ).toBe("invalid mount container path (must be absolute): workspace");
    expect(
      specError({ name: "bot-a", mounts: [{ host: "/tmp/a,b", container: "/workspace" }] }).message,
    ).toBe("mount paths cannot contain a comma or colon: /tmp/a,b");
  });

  test("rejects a relative state dir and a nonsensical ttl", () => {
    expect(specError({ name: "bot-a", stateDir: "var/freebot" }).message).toBe(
      "invalid stateDir (must be absolute): var/freebot",
    );
    expect(specError({ name: "bot-a", idleTtlMs: 0 }).message).toBe(
      "invalid idleTtlMs (must be a positive integer): 0",
    );
    expect(specError({ name: "bot-a", idleTtlMs: 1.5 }).code).toBe("invalid_spec");
  });

  test("refuses the ownership namespace in caller labels", () => {
    expect(specError({ name: "bot-a", labels: { "freebot.unit": "u9.9" } }).message).toBe(
      "labels must not use the freebot namespace: freebot.unit",
    );
  });
});

describe("ownership labels (order 22)", () => {
  test("names containers and labels the way cleanup matches them", () => {
    expect(containerName("bot-a")).toBe(`${CONTAINER_PREFIX}bot-a`);
    expect(freebotLabels("bot-a", DEFAULT_UNIT)).toEqual({
      [SANDBOX_LABEL]: "bot-a",
      [UNIT_LABEL]: DEFAULT_UNIT,
      [PROVIDER_LABEL]: "docker",
    });
  });

  test("defaults the unit label to this unit and takes an override", () => {
    expect(new DockerAdapter().unit).toBe(DEFAULT_UNIT);
    expect(new DockerAdapter({ unit: "u9.9" }).unit).toBe("u9.9");
  });
});

describe("capability truth table", () => {
  test("Docker reports exactly what it can do", () => {
    expect(new DockerAdapter().capabilities()).toEqual({
      memoryPause: false,
      dockerInVm: false,
      kvm: false,
      gpu: false,
      regions: ["local"],
    });
  });
});

describe("unsupported capabilities are typed, never silent", () => {
  const adapter = new DockerAdapter();
  const handle = { provider: "docker", id: "bot-a" } as const;

  test("fork is an UnsupportedCapabilityError with a literal message", async () => {
    const error = await adapter.fork(handle).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(UnsupportedCapabilityError);
    expect(error).toBeInstanceOf(SandboxError);
    const typed = error as UnsupportedCapabilityError;
    expect(typed.code).toBe("unsupported_capability");
    expect(typed.capability).toBe("fork");
    expect(typed.provider).toBe("docker");
    expect(typed.message).toBe(
      "docker does not support fork: Phase 2+; today snapshot() plus create({ image: snapshot.ref }) restores the disk state into a new sandbox",
    );
  });

  test("desktop is an UnsupportedCapabilityError and the interface still carries it", async () => {
    const error = await adapter.desktop(handle).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(UnsupportedCapabilityError);
    expect((error as UnsupportedCapabilityError).capability).toBe("desktop");
    expect((error as UnsupportedCapabilityError).message).toBe(
      "docker does not support desktop: the screen channel (Xvfb + noVNC) lands in Phase 2; the interface carries it now so boat and E2B implement it without a redesign",
    );
  });
});

describe("boundary checks that run before docker", () => {
  const adapter = new DockerAdapter();

  test("refuses a handle that belongs to another provider", async () => {
    const error = await adapter.exec({ provider: "boat", id: "bot-a" }, ["echo", "hi"]).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).code).toBe("invalid_handle");
    expect((error as SandboxError).message).toBe("handle belongs to boat, not docker");
  });

  test("refuses an empty command", async () => {
    const error = await adapter.exec({ provider: "docker", id: "bot-a" }, []).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect((error as SandboxError).code).toBe("invalid_command");
    expect((error as SandboxError).message).toBe("exec needs a command");
  });

  test("refuses a relative upload path and an out-of-range port", async () => {
    const handle = { provider: "docker", id: "bot-a" } as const;
    await expect(adapter.upload(handle, "/tmp/x", "relative")).rejects.toThrow(
      "upload needs an absolute remote path: relative",
    );
    await expect(adapter.exposePort(handle, 0)).rejects.toThrow("invalid port: 0");
  });

  test("the adapter is assignable to the frozen interface", () => {
    const provider: SandboxProvider = adapter;
    expect(provider.id).toBe("docker");
    expect(DEFAULT_STATE_DIR).toBe("/var/freebot");
  });
});
