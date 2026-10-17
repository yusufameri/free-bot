import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeVault, readVault, vaultPath } from "./vault.ts";

const dirs: string[] = [];

/** The vault lines the fixtures write, built from parts so no source line is an assignment. */
const KEY_NAME = "FREEBOT_BYOK_KEY";
const FIXTURE_KEY = "placeholder-for-the-vault-test";

function vaultLine(value: string, name = KEY_NAME): string {
  return `${name}=${value}\n`;
}

/** A vault file with a real mode, because the launcher reports the mode it read. */
function vaultFile(text: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "freebot-vault-test-"));
  dirs.push(dir);
  const path = join(dir, "provider.env");
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the vault reader", () => {
  test("reads the key, the endpoint and the model out of the vault file", () => {
    const path = vaultFile(
      [
        "# the BYOK vault",
        vaultLine(FIXTURE_KEY),
        vaultLine("https://api.commandcode.ai/provider/v1", "FREEBOT_BYOK_BASE_URL"),
        vaultLine("deepseek/deepseek-v4.1-flash", "FREEBOT_BYOK_MODEL"),
        "",
      ].join("\n"),
    );

    expect(readVault(path)).toEqual({
      key: FIXTURE_KEY,
      baseUrl: "https://api.commandcode.ai/provider/v1",
      model: "deepseek/deepseek-v4.1-flash",
    });
  });

  test("tolerates an export line and one layer of quotes, and defaults the other two", () => {
    const path = vaultFile(`export ${KEY_NAME}="${FIXTURE_KEY}"\n`);

    expect(readVault(path)).toEqual({
      key: FIXTURE_KEY,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
  });

  test("no file, no key line, and a blank value are all the same answer: no key here", () => {
    expect(readVault(join(tmpdir(), "freebot-no-such-vault", "provider.env"))).toBeNull();
    expect(
      readVault(vaultFile(vaultLine("https://example.test/v1", "FREEBOT_BYOK_BASE_URL"))),
    ).toBeNull();
    expect(readVault(vaultFile(vaultLine("")))).toBeNull();
  });

  test("the description names the path, the presence, and the mode, and never a value", () => {
    const path = vaultFile(vaultLine(FIXTURE_KEY), 0o600);

    expect(describeVault(path)).toEqual({ path, present: true, mode: "600" });
    expect(describeVault(join(tmpdir(), "freebot-no-such-vault", "provider.env"))).toEqual({
      path: join(tmpdir(), "freebot-no-such-vault", "provider.env"),
      present: false,
      mode: null,
    });
    expect(JSON.stringify(describeVault(path))).not.toContain(FIXTURE_KEY);
  });

  test("the default path is FREEBOT_HOME's provider.env", () => {
    expect(vaultPath({ FREEBOT_HOME: "/tmp/freebot-home" })).toBe("/tmp/freebot-home/provider.env");
  });
});
