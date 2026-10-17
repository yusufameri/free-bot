/**
 * The transport seam. The client builds one request and a transport delivers bytes back.
 * `fetchTransport` is the only implementation that touches the network; tests and the replay
 * cases inject `createFakeTransport`, so no test makes a live provider call (order 9).
 */

import { ProviderTransportError } from "./errors.ts";

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal | undefined;
}

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  /** Body bytes, consumed once. Streamed for `stream: true`, whole for everything else. */
  body: ReadableStream<Uint8Array>;
}

export interface ProviderTransport {
  send(request: ProviderRequest): Promise<ProviderResponse>;
}

/** The real transport: one POST over global fetch. */
export function fetchTransport(): ProviderTransport {
  return {
    async send(request) {
      const init: RequestInit = {
        method: "POST",
        headers: request.headers,
        body: request.body,
      };
      if (request.signal !== undefined) init.signal = request.signal;
      const response = await fetch(request.url, init);
      if (response.body === null) {
        throw new ProviderTransportError(`no response body from ${request.url}`);
      }
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: response.body,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers for the injected fake transport and for recorded literals
// ---------------------------------------------------------------------------

/** One JSON body with a status. */
export function jsonResponse(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): ProviderResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: new Response(JSON.stringify(value)).body as ReadableStream<Uint8Array>,
  };
}

/** One SSE body: each entry becomes a `data:` record, and `[DONE]` is appended. */
export function sseResponse(
  status: number,
  payloads: readonly unknown[],
  options: { done?: boolean; headers?: Record<string, string> } = {},
): ProviderResponse {
  const lines = payloads.map((payload) =>
    typeof payload === "string" ? `data: ${payload}` : `data: ${JSON.stringify(payload)}`,
  );
  if (options.done !== false) lines.push("data: [DONE]");
  return rawResponse(status, `${lines.join("\n\n")}\n\n`, options.headers ?? {});
}

/** One body exactly as given, for a wire shape that is not JSON-per-record. */
export function rawResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): ProviderResponse {
  return {
    status,
    headers: { "content-type": "text/event-stream", ...headers },
    body: new Response(text).body as ReadableStream<Uint8Array>,
  };
}

export interface FakeTransport extends ProviderTransport {
  /** Every request the client built, in order. */
  readonly requests: ProviderRequest[];
}

/**
 * A transport that answers from a script and records what it was asked. Throwing entries simulate
 * a socket failure. The script runs out into a `ProviderTransportError`, so an unexpected extra
 * call fails loudly instead of hanging.
 */
export function createFakeTransport(
  script: ReadonlyArray<ProviderResponse | Error>,
): FakeTransport {
  const requests: ProviderRequest[] = [];
  let cursor = 0;
  return {
    requests,
    send(request) {
      requests.push(request);
      const next = script[cursor];
      cursor += 1;
      if (next === undefined) {
        return Promise.reject(
          new ProviderTransportError(`fake transport: no scripted response for call ${cursor}`),
        );
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}
