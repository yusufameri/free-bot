/**
 * The localhost gate, in the order it runs: Host, then Origin, then the bearer token.
 *
 * The server binds 127.0.0.1, so the network already excludes remote callers. What is left is the
 * browser on this machine: any page the operator's browser loads can reach a loopback port, and a
 * `Location:`/DNS-rebinding attack can make the attacker's hostname resolve to 127.0.0.1. Three
 * structural checks cover that, each refusing with its own code so a caller can tell them apart:
 *
 * 1. `host_not_allowed`: the `Host` header must name loopback. Answered before any credential is
 *    read, so a rebound request is refused without the token being compared against anything.
 * 2. `origin_not_allowed`: an `Origin` header that is present must be a loopback http(s) origin.
 *    A browser sends `Origin` on cross-origin requests and on same-origin non-GET requests, so a
 *    foreign page cannot reach the API with its own origin attached; `Origin: null` is refused
 *    because it parses as nothing.
 * 3. `token_missing` / `token_mismatch`: a bearer token minted at boot, never stored, compared
 *    hash-first so the comparison is fixed-length and constant-time.
 *
 * The one deliberate exception: an *absent* `Origin` is allowed, because non-browser clients (the
 * operator's curl, the launcher, the in-process test client) send none. That cannot be used to skip
 * the checks that matter: a browser always sends `Origin` when it crosses an origin, and the
 * rebinding vector fails the Host check regardless. See docs/server-auth.md.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** One distinct code per refusal. A body carries a code and a message, never the presented token. */
export const AUTH_REFUSAL_CODES = [
  "host_not_allowed",
  "origin_not_allowed",
  "token_missing",
  "token_mismatch",
] as const;

export type AuthRefusalCode = (typeof AUTH_REFUSAL_CODES)[number];

export interface AuthRefusal {
  code: AuthRefusalCode;
  status: 401 | 403;
  message: string;
}

/** The hostnames a loopback-bound server answers to. A foreign one is a rebinding attempt. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

const LOOPBACK_ORIGIN_PROTOCOLS = new Set(["http:", "https:"]);

/** A fresh 256-bit token per launch, url-safe so it can ride a WebSocket query string. */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/** `Host` as a hostname: strips the port, and unwraps an IPv6 literal. */
export function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    return close === -1 ? value : value.slice(1, close);
  }
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

export function checkHost(host: string | null): AuthRefusal | null {
  if (host === null || host === "") {
    return { code: "host_not_allowed", status: 403, message: "no Host header" };
  }
  const hostname = hostnameOf(host);
  if (LOOPBACK_HOSTNAMES.has(hostname)) return null;
  return {
    code: "host_not_allowed",
    status: 403,
    message: `Host ${hostname} is not loopback`,
  };
}

export function checkOrigin(origin: string | null): AuthRefusal | null {
  if (origin === null || origin === "") return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { code: "origin_not_allowed", status: 403, message: `Origin ${origin} is not a URL` };
  }
  if (!LOOPBACK_ORIGIN_PROTOCOLS.has(url.protocol) || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return {
      code: "origin_not_allowed",
      status: 403,
      message: `Origin ${origin} is not a loopback http(s) origin`,
    };
  }
  return null;
}

/**
 * Compare by digest, so the comparison is over two equal-length buffers and a wrong-length guess
 * costs the same as a wrong-length-equal one.
 */
function tokensEqual(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

export function checkToken(presented: string | null, expected: string): AuthRefusal | null {
  if (presented === null || presented === "") {
    return { code: "token_missing", status: 401, message: "missing bearer token" };
  }
  if (!tokensEqual(presented, expected)) {
    return { code: "token_mismatch", status: 401, message: "bearer token does not match" };
  }
  return null;
}

/** `Authorization: Bearer <token>`, or null when the header is absent or another scheme. */
export function bearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * The token a request presents. The header first; a WebSocket upgrade may also carry it in the
 * query string, because a browser cannot set headers on a WebSocket.
 */
export function presentedToken(request: Request, fromQuery: boolean): string | null {
  const fromHeader = bearerToken(request.headers.get("authorization"));
  if (fromHeader !== null) return fromHeader;
  if (!fromQuery) return null;
  return new URL(request.url).searchParams.get("token");
}

/**
 * Run the three checks in order over one request. Returns the first refusal, or null when the
 * request may proceed.
 */
export function authorize(
  request: Request,
  expectedToken: string,
  options: { tokenFromQuery?: boolean } = {},
): AuthRefusal | null {
  return (
    checkHost(request.headers.get("host")) ??
    checkOrigin(request.headers.get("origin")) ??
    checkToken(presentedToken(request, options.tokenFromQuery === true), expectedToken)
  );
}

export function refusalResponse(refusal: AuthRefusal): Response {
  return Response.json(
    { error: { code: refusal.code, message: refusal.message } },
    {
      status: refusal.status,
    },
  );
}

/**
 * One line per refusal, for the operator watching stdout: the code and the request's place, never
 * the presented token and never a header value.
 */
export function refusalLogLine(refusal: AuthRefusal, request: Request): string {
  const path = new URL(request.url).pathname;
  return `[auth] refused code=${refusal.code} method=${request.method} path=${path}`;
}
