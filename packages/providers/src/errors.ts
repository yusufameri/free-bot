/**
 * Typed failures the OpenAI-compatible client and the capability probe surface to their callers.
 *
 * Every error carries wire text or a status code. None of them carries a request header: order 8
 * keeps the Authorization value out of messages, artifacts, and logs.
 */

/** The provider rejected the credential (401/403). */
export class ProviderAuthError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`auth rejected (${status}): ${detail}`);
    this.name = "ProviderAuthError";
    this.status = status;
  }
}

/** The provider rate-limited the request (429). `retryAfterMs` is the wire's own hint, or null. */
export class ProviderRateLimitError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, detail: string, retryAfterMs: number | null) {
    super(`rate limited (${status}): ${detail}`);
    this.name = "ProviderRateLimitError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The model declined to answer (`refusal` delta on the wire, or `finish_reason: content_filter`). */
export class ProviderRefusalError extends Error {
  readonly finishReason: string;
  readonly raw: string;

  constructor(finishReason: string, raw: string) {
    super(`model refused the request (${finishReason}): ${raw}`);
    this.name = "ProviderRefusalError";
    this.finishReason = finishReason;
    this.raw = raw;
  }
}

/** A tool call arrived whose arguments could not be read as a JSON object. */
export class ProviderMalformedToolCallError extends Error {
  readonly toolName: string | null;
  readonly rawArguments: string;
  readonly reason: string;

  constructor(reason: string, options: { toolName?: string | null; rawArguments: string }) {
    super(`malformed tool call${options.toolName ? ` for ${options.toolName}` : ""}: ${reason}`);
    this.name = "ProviderMalformedToolCallError";
    this.toolName = options.toolName ?? null;
    this.rawArguments = options.rawArguments;
    this.reason = reason;
  }
}

/** The request's per-step deadline expired. */
export class ProviderTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`timeout: no response within ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Any other non-2xx answer, with the provider's own error text when the body carried one. */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`http ${status}: ${body.slice(0, 200)}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body;
  }
}

/** The transport itself failed: no connection, a socket that died, a body that was not JSON. */
export class ProviderTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderTransportError";
  }
}
