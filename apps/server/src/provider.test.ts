import { describe, expect, test } from "bun:test";
import { chooseProvider, describeChoice, MissingKeyError, providerLine } from "./provider.ts";

/** A vault with a key in it, as `readVault` returns one. */
const VAULT = {
  key: "vault-key-for-the-factory-test",
  baseUrl: "https://api.commandcode.ai/provider/v1",
  model: "deepseek/deepseek-v4.1-flash",
};

describe("the provider factory", () => {
  test("auto takes the vault's keyed path when the vault holds a key", () => {
    const choice = chooseProvider({ mode: "auto", vault: VAULT });

    expect(choice).toEqual({
      kind: "keyed",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      model: "deepseek/deepseek-v4.1-flash",
      key: "vault-key-for-the-factory-test",
    });
    expect(describeChoice(choice)).toEqual({
      kind: "keyed",
      endpoint: "https://api.commandcode.ai/provider/v1/chat/completions",
      model: "deepseek/deepseek-v4.1-flash",
      keyPresent: true,
    });
  });

  test("auto replays on a keyless machine and says why", () => {
    const choice = chooseProvider({ mode: "auto", vault: null });

    expect(choice.kind).toBe("replay");
    expect(choice).toMatchObject({ why: "no-vault-key" });
    expect(choice.kind === "replay" && choice.transcript).toEndWith(
      "packages/pi-bridge/fixtures/rpc-handshake.jsonl",
    );
    expect(describeChoice(choice)).toMatchObject({
      kind: "replay",
      model: null,
      keyPresent: false,
    });
  });

  test("replay records even when a key is right there, which is how an evidence driver pins it", () => {
    const choice = chooseProvider({ mode: "replay", vault: VAULT });

    expect(choice).toMatchObject({ kind: "replay", why: "asked-for-replay" });
  });

  test("live demands the key and refuses to fall back to a recording", () => {
    expect(() => chooseProvider({ mode: "live", vault: null })).toThrow(MissingKeyError);
    expect(() => chooseProvider({ mode: "live", vault: null })).toThrow(
      "no FREEBOT_BYOK_KEY in the vault at",
    );
    expect(chooseProvider({ mode: "live", vault: VAULT }).kind).toBe("keyed");
  });

  test("the description and the launcher's line carry no key, only its presence", () => {
    const choice = chooseProvider({ mode: "auto", vault: VAULT });
    const described = describeChoice(choice);
    const line = providerLine(described);

    expect(line).toBe(
      "model deepseek/deepseek-v4.1-flash via api.commandcode.ai (key from the vault)",
    );
    expect(JSON.stringify(described)).not.toContain(VAULT.key);
    expect(line).not.toContain(VAULT.key);
    expect(
      providerLine(describeChoice(chooseProvider({ mode: "replay", vault: null }))),
    ).toStartWith("keyless, replaying ");
  });
});
