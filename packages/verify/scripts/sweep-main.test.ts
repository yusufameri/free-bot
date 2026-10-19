/**
 * The sweep's two contracts that a run cannot prove cheaply: which drivers can run here, and what
 * a red driver becomes. The runner is called with fake drivers in a temp checkout, so the failure
 * path is proven without wrecking a real driver's subject.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Capability,
  classify,
  driverVerdict,
  type HostFacts,
  isGreen,
  leaksSecret,
  parseManifest,
  planDrivers,
  probeHost,
  resolveArgv,
  runSweep,
  type Subject,
  summaryLine,
  vaultSecrets,
} from "./sweep-main.ts";

const made: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function host(present: readonly Capability[]): HostFacts {
  const facts = {} as HostFacts;
  for (const capability of [
    "docker",
    "microsandbox",
    "chrome",
    "vaultKey",
    "liveInstance",
  ] as const) {
    facts[capability] = present.includes(capability)
      ? { present: true, detail: `${capability} probe answered` }
      : { present: false, detail: `${capability} probe found nothing` };
  }
  return facts;
}

function subject(overrides: Partial<Subject> = {}): Subject {
  return {
    driver: "fake",
    argv: ["bun", "fake.ts"],
    artifact: { dir: "packages/verify/artifacts/fake", file: "assert.txt" },
    subject: "the fake surface",
    needs: [],
    missing: null,
    ...overrides,
  };
}

function fakeDriver(dir: string, name: string, body: string): string {
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, `${body}\n`);
  return path;
}

const shortSha = "abc1234";
const artifactLabel = `packages/verify/artifacts/sweep-main/${shortSha}`;

function options(checkout: string, subjects: Subject[], secrets: string[] = []) {
  return {
    checkout,
    commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    shortSha,
    branch: "origin/main (deadbee)",
    host: host([]),
    subjects,
    artifactDir: join(checkout, artifactLabel),
    artifactLabel,
    secrets,
  };
}

describe("classification", () => {
  test("a driver whose capabilities are present is runnable", () => {
    const result = classify(
      subject({ needs: [["docker"], ["chrome"]] }),
      host(["docker", "chrome"]),
    );

    expect(result).toEqual({ kind: "runnable" });
  });

  test("a missing capability becomes a skip naming the need and what the probe found", () => {
    const result = classify(subject({ needs: [["docker"]] }), host([]));

    expect(result).toEqual({
      kind: "skipped",
      reason: "needs the Docker daemon the pinned image runs in (docker probe found nothing)",
    });
  });

  test("a requirement group is satisfied by either backend", () => {
    const result = classify(
      subject({ needs: [["docker", "microsandbox"]] }),
      host(["microsandbox"]),
    );

    expect(result).toEqual({ kind: "runnable" });
  });

  test("a manifest entry with no sweep block is skipped by name", () => {
    const entries = parseManifest(
      JSON.stringify({
        drivers: [
          {
            id: "unwired",
            command: "bun unwired.ts",
            artifact: "packages/verify/artifacts/unwired",
          },
        ],
      }),
    );
    const [plan] = planDrivers(entries);

    expect(plan?.missing).toBe("driver-subjects.json carries no sweep block for it");
    expect(
      classify({ ...subject(), driver: "unwired", missing: plan?.missing ?? null }, host([])),
    ).toEqual({
      kind: "skipped",
      reason: "driver-subjects.json carries no sweep block for it",
    });
  });

  test("the status capture skips with the live-instance reason when no URL is set", async () => {
    const facts = await probeHost(tempDir("sweep-probe-"), {});

    expect(facts.liveInstance).toEqual({
      present: false,
      detail: "FREEBOT_STATUS_URL is not set",
    });
    expect(classify(subject({ needs: [["liveInstance"]] }), facts)).toEqual({
      kind: "skipped",
      reason: "needs a live instance named by FREEBOT_STATUS_URL (FREEBOT_STATUS_URL is not set)",
    });
  });

  test("the status capture is runnable when FREEBOT_STATUS_URL is set, and the URL is not echoed", async () => {
    const facts = await probeHost(tempDir("sweep-probe-"), {
      FREEBOT_STATUS_URL: "http://127.0.0.1:9/#token=secret-launch-token",
    });

    expect(facts.liveInstance).toEqual({
      present: true,
      detail: "FREEBOT_STATUS_URL is set",
    });
    expect(JSON.stringify(facts)).not.toContain("secret-launch-token");
  });
});

describe("the driver's own verdict", () => {
  test("the last RESULT line wins over the per-viewport lines before it", () => {
    const text = [
      "RESULT: PASS — viewport 360x800",
      "RESULT: FAIL — viewport 390x844",
      "RESULT: PASS (54/54)",
      "",
    ].join("\n");

    expect(driverVerdict(text)).toBe("RESULT: PASS (54/54)");
    expect(isGreen(driverVerdict(text))).toBe(true);
  });

  test("a bare PASS line at the end is a verdict, as type-gate writes it", () => {
    expect(driverVerdict("probe 1\nprobe 2\nPASS type-gate\n")).toBe("PASS type-gate");
    expect(isGreen("PASS type-gate")).toBe(true);
    expect(isGreen("FAIL type-gate")).toBe(false);
  });

  test("text with no verdict line is not green", () => {
    expect(driverVerdict("everything looked fine\n")).toBeNull();
    expect(isGreen(null)).toBe(false);
  });
});

describe("the failure path", () => {
  test("a driver that exits non-zero fails the sweep and proposes one fileable unit", async () => {
    const checkout = tempDir("sweep-fail-");
    const red = fakeDriver(checkout, "red", 'console.log("RESULT: FAIL (1/2)"); process.exit(1);');
    const sweep = await runSweep(
      options(checkout, [
        subject({
          driver: "fake-red",
          argv: ["bun", red],
          subject: "the fake surface",
        }),
      ]),
    );

    expect(sweep.counts).toEqual({ runnable: 1, passed: 0, failed: 1, skipped: 0 });
    expect(sweep.ok).toBe(false);
    const outcome = sweep.runs[0]?.outcome;
    if (outcome?.kind !== "failed") throw new Error("expected a failed outcome");
    expect(outcome.code).toBe(1);
    expect(outcome.verdict).toBe("RESULT: FAIL (1/2)");
    expect(outcome.proof).toBe(`${artifactLabel}/fake-red.log`);
    expect(outcome.proposed).toBe(
      `file a unit: "sweep-main: fake-red is red against main". The fake-red driver (\`bun ${red}\`, the fake surface) exited 1 with "RESULT: FAIL (1/2)" at ${shortSha}. Proof ${artifactLabel}/fake-red.log.`,
    );

    const log = readFileSync(join(checkout, artifactLabel, "fake-red.log"), "utf8");
    expect(log).toContain("exit: 1");
    expect(log).toContain("RESULT: FAIL (1/2)");
    const artifact = readFileSync(join(checkout, artifactLabel, "sweep.txt"), "utf8");
    expect(artifact).toContain(`FAIL fake-red: RESULT: FAIL (1/2)`);
    expect(artifact).toContain(`  proof: ${artifactLabel}/fake-red.log`);
    expect(artifact).toContain(`  ${outcome.proposed}`);
  });

  test("the summary's arithmetic adds up with a pass, a failure and a skip", async () => {
    const checkout = tempDir("sweep-counts-");
    const green = fakeDriver(checkout, "green", 'console.log("RESULT: PASS (2/2)");');
    const red = fakeDriver(checkout, "red", 'console.log("RESULT: FAIL (1/2)"); process.exit(1);');
    const sweep = await runSweep(
      options(checkout, [
        subject({ driver: "fake-green", argv: ["bun", green] }),
        subject({ driver: "fake-red", argv: ["bun", red] }),
        subject({ driver: "fake-skip", needs: [["docker"]] }),
      ]),
    );

    expect(summaryLine(sweep.counts)).toBe("runnable 2, passed 1, failed 1, skipped 1");
    expect(sweep.arithmetic).toBe(true);
    const artifact = readFileSync(join(checkout, artifactLabel, "sweep.txt"), "utf8");
    expect(artifact).toContain("runnable 2, passed 1, failed 1, skipped 1");
    expect(artifact).toContain(
      "arithmetic: 2 = 1 + 1 (passed + failed), 3 = 2 + 1 (runnable + skipped)",
    );
    expect(artifact).toContain("RESULT: FAIL (1/2)");
    expect(artifact).toContain("SKIP fake-skip: needs the Docker daemon");
  });

  test("a driver that exits 0 without a verdict line is red, not a silent pass", async () => {
    const checkout = tempDir("sweep-noverdict-");
    const quiet = fakeDriver(checkout, "quiet", 'console.log("nothing to report");');
    const sweep = await runSweep(
      options(checkout, [subject({ driver: "fake-quiet", argv: ["bun", quiet] })]),
    );

    expect(sweep.counts.failed).toBe(1);
    const outcome = sweep.runs[0]?.outcome;
    if (outcome?.kind !== "failed") throw new Error("expected a failed outcome");
    expect(outcome.proposed).toContain("It exited 0 without printing a verdict line.");
  });

  test("a driver that prints a vault value fails and its log refuses to carry the value", async () => {
    const checkout = tempDir("sweep-leak-");
    const leaky = fakeDriver(
      checkout,
      "leaky",
      'console.log("FREEBOT_BYOK_KEY=supersecretvalue"); console.log("RESULT: PASS (1/1)");',
    );
    const sweep = await runSweep(
      options(checkout, [subject({ driver: "fake-leaky", argv: ["bun", leaky] })]),
    );

    expect(sweep.counts.failed).toBe(1);
    const outcome = sweep.runs[0]?.outcome;
    if (outcome?.kind !== "failed") throw new Error("expected a failed outcome");
    expect(outcome.proposed).toContain("printed a vault value");
    const log = readFileSync(join(checkout, artifactLabel, "fake-leaky.log"), "utf8");
    expect(log).toContain("(refused: a vault value was in this driver's output)");
    expect(log).not.toContain("supersecretvalue");
  });
});

describe("the manifest boundary", () => {
  test("a malformed needs block fails by driver, not as a silent skip", () => {
    const text = JSON.stringify({
      drivers: [
        {
          id: "bad",
          command: "bun bad.ts",
          artifact: "packages/verify/artifacts/bad",
          sweep: { argv: ["bun", "bad.ts"], subject: "bad", needs: [["gpu"]] },
        },
      ],
    });

    expect(() => parseManifest(text)).toThrow(
      "driver bad: sweep.needs[0] names unknown capability gpu",
    );
  });

  test("a command placeholder without a value fails before a driver starts", () => {
    expect(() => resolveArgv(["bun", "live.ts", "{statusUrl}"], { checkout: "/tmp" })).toThrow(
      "command placeholder {statusUrl} has no value",
    );
    expect(
      resolveArgv(["bun", "live.ts", "{statusUrl}"], { statusUrl: "http://127.0.0.1:9" }),
    ).toEqual(["bun", "live.ts", "http://127.0.0.1:9"]);
  });

  test("the vault scanner reads key-shaped names only", () => {
    const dir = tempDir("sweep-vault-");
    const path = join(dir, "provider.env");
    writeFileSync(
      path,
      [
        "# comment",
        "FREEBOT_BYOK_KEY=sk-live-value-123",
        "FREEBOT_BYOK_BASE_URL=https://api.example.test/v1",
        "FREEBOT_BYOK_MODEL=some/model",
        "GITHUB_TOKEN=ghp-token-value",
        "",
      ].join("\n"),
    );

    expect(vaultSecrets(path)).toEqual(["sk-live-value-123", "ghp-token-value"]);
    expect(leaksSecret("the key was sk-live-value-123", vaultSecrets(path))).toBe(true);
    expect(leaksSecret("https://api.example.test/v1 is not a secret", vaultSecrets(path))).toBe(
      false,
    );
  });
});
