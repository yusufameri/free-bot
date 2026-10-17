import { describe, expect, test } from "bun:test";
import {
  AUTH_REFUSAL_CODES,
  authorize,
  bearerToken,
  checkHost,
  checkOrigin,
  checkToken,
  hostnameOf,
  mintToken,
  presentedToken,
  refusalResponse,
} from "./auth.ts";

const TOKEN = "dG9rZW4tdW5kZXItdGVzdA";

/** One request through the real gate, with only the named header exercised. */
function gate(
  presented: {
    host?: string | null;
    origin?: string | null;
    token?: string | null;
    query?: string;
  },
  options: { tokenFromQuery?: boolean } = {},
) {
  const headers = new Headers();
  if (presented.host !== undefined && presented.host !== null) headers.set("host", presented.host);
  if (presented.origin !== undefined && presented.origin !== null) {
    headers.set("origin", presented.origin);
  }
  if (presented.token !== undefined && presented.token !== null) {
    headers.set("authorization", `Bearer ${presented.token}`);
  }
  const query = presented.query === undefined ? "" : `?token=${presented.query}`;
  return authorize(new Request(`http://127.0.0.1:4000/rpc${query}`, { headers }), TOKEN, options);
}

const HOST = "127.0.0.1:4000";
const ORIGIN = "http://127.0.0.1:4000";

describe("the per-launch token", () => {
  test("is 256 bits of url-safe text, different every launch", () => {
    const first = mintToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintToken()).not.toBe(first);
  });

  test("mints the same shape over 100 launches", () => {
    const tokens = new Set(Array.from({ length: 100 }, mintToken));
    expect(tokens.size).toBe(100);
  });
});

describe("the refusal matrix", () => {
  test("the five codes are distinct literals", () => {
    expect(AUTH_REFUSAL_CODES).toEqual([
      "host_not_allowed",
      "origin_not_allowed",
      "token_missing",
      "token_mismatch",
    ]);
  });

  test("a request with no token is refused 401 token_missing", () => {
    const refusal = gate({ host: HOST, origin: ORIGIN });
    expect(refusal?.code).toBe("token_missing");
    expect(refusal?.status).toBe(401);
  });

  test("a wrong token is refused 401 token_mismatch", () => {
    const refusal = gate({ host: HOST, origin: ORIGIN, token: "not-the-token" });
    expect(refusal?.code).toBe("token_mismatch");
    expect(refusal?.status).toBe(401);
  });

  test("a token that differs only in length is refused the same way", () => {
    expect(gate({ host: HOST, origin: ORIGIN, token: `${TOKEN}x` })?.code).toBe("token_mismatch");
    expect(gate({ host: HOST, origin: ORIGIN, token: TOKEN.slice(0, -1) })?.code).toBe(
      "token_mismatch",
    );
  });

  test("a foreign Origin is refused 403 origin_not_allowed", () => {
    const refusal = gate({ host: HOST, origin: "http://evil.example", token: TOKEN });
    expect(refusal?.code).toBe("origin_not_allowed");
    expect(refusal?.status).toBe(403);
  });

  test("a foreign Host is refused 403 host_not_allowed before the token is read", () => {
    const refusal = gate({ host: "evil.example", origin: ORIGIN, token: TOKEN });
    expect(refusal?.code).toBe("host_not_allowed");
    expect(refusal?.status).toBe(403);
  });

  test("the allowed request passes", () => {
    expect(gate({ host: HOST, origin: ORIGIN, token: TOKEN })).toBeNull();
  });

  test("a refusal body carries the code and never the presented token", async () => {
    const refusal = gate({ host: HOST, origin: ORIGIN, token: "not-the-token" });
    if (refusal === null) throw new Error("expected a refusal");
    const body = await refusalResponse(refusal).text();
    expect(body).toBe(
      '{"error":{"code":"token_mismatch","message":"bearer token does not match"}}',
    );
    expect(body).not.toContain("not-the-token");
  });
});

describe("the Host check", () => {
  test("accepts loopback in every spelling", () => {
    for (const host of [
      "127.0.0.1",
      "127.0.0.1:5173",
      "localhost",
      "localhost:8080",
      "[::1]:443",
    ]) {
      expect(checkHost(host)).toBeNull();
    }
  });

  test("refuses a rebinding-style hostname, including loopback-lookalikes", () => {
    for (const host of [
      "evil.example",
      "127.0.0.1.evil.example",
      "localhost.evil.example",
      "0.0.0.0:3000",
      "192.168.1.10:8080",
      "[::]:8080",
    ]) {
      expect(checkHost(host)?.code).toBe("host_not_allowed");
    }
  });

  test("refuses a missing Host header", () => {
    expect(checkHost(null)?.code).toBe("host_not_allowed");
    expect(checkHost("")?.code).toBe("host_not_allowed");
  });

  test("reads the hostname out of every host spelling", () => {
    expect(hostnameOf("127.0.0.1:8080")).toBe("127.0.0.1");
    expect(hostnameOf("LOCALHOST:80")).toBe("localhost");
    expect(hostnameOf("[::1]:8080")).toBe("::1");
    expect(hostnameOf("localhost")).toBe("localhost");
  });
});

describe("the Origin check", () => {
  test("accepts loopback origins on http and https", () => {
    for (const origin of [
      "http://127.0.0.1:3000",
      "http://localhost:5173",
      "https://localhost:8443",
    ]) {
      expect(checkOrigin(origin)).toBeNull();
    }
  });

  test("refuses a foreign origin", () => {
    expect(checkOrigin("http://evil.example")?.code).toBe("origin_not_allowed");
    expect(checkOrigin("https://evil.example:443")?.code).toBe("origin_not_allowed");
  });

  test("refuses the opaque and non-http origins a browser can send", () => {
    expect(checkOrigin("null")?.code).toBe("origin_not_allowed");
    expect(checkOrigin("file://")?.code).toBe("origin_not_allowed");
    expect(checkOrigin("chrome-extension://abcdef")?.code).toBe("origin_not_allowed");
  });

  test("allows an absent Origin, which only a non-browser client sends", () => {
    expect(checkOrigin(null)).toBeNull();
    expect(checkOrigin("")).toBeNull();
  });
});

describe("the token reader", () => {
  test("reads a bearer header and nothing else", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  test("reads a query token only where the caller allows it", () => {
    const request = new Request(`http://127.0.0.1:4000/rpc-ws?token=${TOKEN}`);
    expect(presentedToken(request, true)).toBe(TOKEN);
    expect(presentedToken(request, false)).toBeNull();
  });

  test("prefers the header when both are present", () => {
    const request = new Request(`http://127.0.0.1:4000/rpc-ws?token=wrong`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(presentedToken(request, true)).toBe(TOKEN);
  });

  test("a query token satisfies the gate only when the caller asks for it", () => {
    expect(gate({ host: HOST, origin: ORIGIN, query: TOKEN }, { tokenFromQuery: true })).toBeNull();
    expect(gate({ host: HOST, origin: ORIGIN, query: TOKEN })?.code).toBe("token_missing");
  });
});

describe("the check order", () => {
  test("Host beats Origin beats token", () => {
    expect(gate({ host: "evil.example", origin: "http://evil.example" })?.code).toBe(
      "host_not_allowed",
    );
    expect(gate({ host: HOST, origin: "http://evil.example" })?.code).toBe("origin_not_allowed");
    expect(gate({ host: HOST, origin: ORIGIN })?.code).toBe("token_missing");
  });

  test("a bare checkToken over the matrix", () => {
    expect(checkToken(null, TOKEN)?.code).toBe("token_missing");
    expect(checkToken("", TOKEN)?.code).toBe("token_missing");
    expect(checkToken("x", TOKEN)?.code).toBe("token_mismatch");
    expect(checkToken(TOKEN, TOKEN)).toBeNull();
    expect(checkToken(mintToken(), TOKEN)?.code).toBe("token_mismatch");
  });
});
