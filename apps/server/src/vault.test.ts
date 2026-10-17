import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeVault, readVault, vaultPath } from "./vault.ts";

const dirs: string[] = [];

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
        "FREEBOT_BYOK_KEY=sk-vault-value",
        "FREEBOT_BYOK_BASE_URL=https://api.commandcode.ai/provider/v1",
        "FREEBOT_BYOK_MODEL=deepseek/deepseek-v4.1-flash",
        "",
      ].join("\n"),
    );

    expect(readVault(path)).toEqual({
      key: "sk-vault-value",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      model: "deepseek/deepseek-v4.1-flash",
    });
  });

  test("tolerates an export line and one layer of quotes, and defaults the other two", () => {
    expect(readVault(vaultFile('export FREEBOT_BYOK_KEY="sk-quoted"\n'))).toEqual({
      key: "sk-quoted",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
  });

  test("no file, no key line, and a blank value are all the same answer: no key here", () => {
    expect(readVault(join(tmpdir(), "freebot-no-such-vault", "provider.env"))).toBeNull();
    expect(readVault(vaultFile("FREEBOT_BYOK_BASE_URL=https://example.test/v1\n"))).toBeNull();
    expect(readVault(vaultFile("FREEBOT_BYOK_KEY=\n"))).toBeNull();
  });

  test("the description names the path, the presence, and the mode, and never a value", () => {
    const path = vaultFile("FREEBOT_BYOK_KEY=sk-vault-value\n", 0o600);

    expect(describeVault(path)).toEqual({ path, present: true, mode: "600" });
    expect(describeVault(join(tmpdir(), "freebot-no-such-vault", "provider.env"))).toEqual({
      path: join(tmpdir(), "freebot-no-such-vault", "provider.env"),
      present: false,
      mode: null,
    });
    expect(JSON.stringify(describeVault(path))).not.toContain("sk-vault-value");
  });

  test("the default path is FREEBOT_HOME's provider.env", () => {
    expect(vaultPath({ FREEBOT_HOME: "/tmp/freebot-home" })).toBe("/tmp/freebot-home/provider.env");
  });
});
