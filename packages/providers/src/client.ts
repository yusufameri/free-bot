/**
 * The OpenAI-compatible client: `POST {baseUrl}/chat/completions`, streaming and non-streaming,
 * tool-call parsing including the malformed shapes weak models produce, and typed errors.
 *
 * The client never logs or rethrows the `Authorization` value, and it parses the wire at this
 * boundary rather than trusting it: a body that is not the documented shape is a typed failure,
 * not a field read that yields `undefined`.
 */

import {
  ProviderAuthError,
  ProviderHttpError,
  ProviderMalformedToolCallError,
  ProviderRateLimitError,
  ProviderRefusalError,
  ProviderTimeoutError,
  ProviderTransportError,
} from "./errors.ts";
import { fetchTransport, type ProviderRequest, type ProviderTransport } from "./transport.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

/** One BYOK endpoint plus the key the caller already resolved. The key stays in memory. */
export interface Connection {
  baseUrl: string;
  apiKey: string;
}

export interface ToolCallInput {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls?: ToolCallInput[];
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One tool call read off the wire, with its arguments parsed and any repair named. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  args: unknown;
  repairs: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Usage | null;
}

export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call_delta";
      index: number;
      id: string | null;
      name: string | null;
      argumentsDelta: string;
    }
  | { type: "completed"; result: ChatResult };

export interface ChatOptions {
  model: string;
  messages: readonly ChatMessage[];
  tools?: readonly ToolSpec[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  responseFormat?: "json_object";
  maxTokens?: number;
  /** Deadline for each network step of this call. Default 60000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ClientOptions {
  transport?: ProviderTransport;
  timeoutMs?: number;
}

export interface ParsedArguments {
  args: unknown;
  /** Every reading aid the parser applied, so a weak caller's shape is visible not hidden. */
  repairs: string[];
}

// ---------------------------------------------------------------------------
// Wire parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProviderTransportError(
      `${what} is not an object: ${JSON.stringify(value)?.slice(0, 120)}`,
    );
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Strip a markdown fence, when the model wrapped its JSON in one. */
function stripFence(text: string): { text: string; stripped: boolean } {
  const match = text.match(/^```[A-Za-z]*\s*\n?([\s\S]*?)\n?```$/);
  if (match === null) return { text, stripped: false };
  const inner = match[1];
  return { text: inner === undefined ? text : inner.trim(), stripped: true };
}

/**
 * The first balanced `{...}` slice of `text`, respecting strings and escapes. Returns the substring
 * and whether the input carried anything before or after it.
 */
export function firstJsonObject(text: string): { slice: string; trimmed: boolean } | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, index + 1);
        return { slice, trimmed: text.trim() !== slice };
      }
    }
  }
  return undefined;
}

/**
 * Read one tool call's arguments. Handles the shapes observed from real and weak callers: absent
 * or empty arguments, arguments that arrive as an object, a fenced object, an object with prose
 * or a second object around it, and arguments split across stream deltas (already joined by the
 * caller). Anything else is a typed malformed-tool-call failure carrying the raw text.
 */
export function parseToolCallArguments(
  raw: unknown,
  toolName: string | null = null,
): ParsedArguments {
  const fail = (reason: string, rawArguments: string): never => {
    throw new ProviderMalformedToolCallError(reason, { toolName, rawArguments });
  };

  if (raw === undefined || raw === null || raw === "") {
    return { args: {}, repairs: ["absent arguments read as {}"] };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return { args: {}, repairs: ["blank arguments read as {}"] };

    const unfenced = stripFence(trimmed);
    const repairs: string[] = [];
    if (unfenced.stripped) repairs.push("markdown fence stripped");

    const direct = tryJson(unfenced.text);
    if (direct.ok) {
      if (!isRecord(direct.value)) return fail("arguments are not a JSON object", raw);
      return { args: direct.value, repairs };
    }

    const balanced = firstJsonObject(unfenced.text);
    if (balanced === undefined) {
      return fail(
        unfenced.text.includes("{")
          ? unbalancedReason(direct.message)
          : "arguments contain no JSON object",
        raw,
      );
    }
    const extracted = tryJson(balanced.slice);
    if (!extracted.ok || !isRecord(extracted.value)) {
      return fail(`the JSON object in the arguments did not parse: ${direct.message}`, raw);
    }
    repairs.push("surrounding text dropped, first JSON object kept");
    return { args: extracted.value, repairs };
  }
  if (isRecord(raw)) {
    return { args: raw, repairs: ["arguments arrived as an object, not a string"] };
  }
  return fail(`arguments are neither a string nor an object: ${typeof raw}`, JSON.stringify(raw));
}

function unbalancedReason(message: string): string {
  return /unterminated|Unexpected end|end of (the )?(input|JSON)/i.test(message)
    ? "arguments are an incomplete JSON object"
    : message;
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Read one tool call off a message object; `index` defaults to its position. */
function readToolCall(entry: unknown, index: number): ToolCall {
  const record = asRecord(entry, "tool call");
  const fn = asRecord(record.function, "tool call.function");
  const name = optionalString(fn.name) ?? "";
  if (name === "") {
    throw new ProviderMalformedToolCallError("the tool call names no function", {
      rawArguments: JSON.stringify(record),
    });
  }
  const rawArguments = fn.arguments;
  const parsed = parseToolCallArguments(rawArguments, name);
  const argumentsText =
    typeof rawArguments === "string"
      ? rawArguments
      : rawArguments === undefined || rawArguments === null
        ? ""
        : JSON.stringify(rawArguments);
  return {
    id: optionalString(record.id) ?? `tool-call-${index}`,
    name,
    arguments: argumentsText,
    args: parsed.args,
    repairs: parsed.repairs,
  };
}

/** `tool_calls`, or the legacy single `function_call` shape some compatible endpoints still send. */
function readToolCalls(message: Record<string, unknown>): ToolCall[] {
  const calls: ToolCall[] = [];
  const many = message.tool_calls;
  if (Array.isArray(many)) {
    for (const [index, entry] of many.entries()) calls.push(readToolCall(entry, index));
  }
  const legacy = message.function_call;
  if (calls.length === 0 && legacy !== undefined) {
    const record = asRecord(legacy, "function_call");
    const call = readToolCall({ function: record }, 0);
    calls.push({ ...call, repairs: [...call.repairs, "legacy function_call shape"] });
  }
  return calls;
}

/** Message text, whether the wire sent a string or an array of content parts. */
function readText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) ? (optionalString(part.text) ?? "") : ""))
      .join("");
  }
  return "";
}

export function parseCompletion(body: unknown): ChatResult {
  const root = asRecord(body, "chat completion");
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderTransportError("chat completion carries no choices");
  }
  const choice = asRecord(choices[0], "chat completion choice");
  const message = asRecord(choice.message ?? {}, "chat completion message");
  const finishReason = optionalString(choice.finish_reason) ?? "";
  const refusal = optionalString(message.refusal);
  if (typeof refusal === "string" && refusal.length > 0) {
    throw new ProviderRefusalError(finishReason === "" ? "refusal" : finishReason, refusal);
  }
  if (finishReason === "content_filter") {
    throw new ProviderRefusalError(finishReason, readText(message.content));
  }
  const usage = root.usage;
  return {
    text: readText(message.content),
    toolCalls: readToolCalls(message),
    finishReason,
    usage: isRecord(usage)
      ? {
          inputTokens: Number(usage.prompt_tokens ?? 0),
          outputTokens: Number(usage.completion_tokens ?? 0),
          totalTokens: Number(usage.total_tokens ?? 0),
        }
      : null,
  };
}

function parseSsePayload(payload: string): Record<string, unknown> {
  const parsed = tryJson(payload);
  if (!parsed.ok) {
    throw new ProviderTransportError(`stream chunk is not JSON: ${parsed.message}`);
  }
  return asRecord(parsed.value, "stream chunk");
}

function retryAfterMs(headers: Record<string, string>, bodyText: string): number | null {
  const header = headers["retry-after"];
  if (header !== undefined) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
  }
  const parsed = tryJson(bodyText);
  if (parsed.ok && isRecord(parsed.value)) {
    const error = parsed.value.error;
    const hint = isRecord(error) ? error.retry_after : undefined;
    const seconds = Number(hint);
    if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
  }
  return null;
}

/** The provider's own error text when the body carries one, else a bounded body slice. */
function errorDetail(bodyText: string): string {
  const parsed = tryJson(bodyText);
  if (parsed.ok && isRecord(parsed.value)) {
    const error = parsed.value.error;
    const message = isRecord(error) ? optionalString(error.message) : undefined;
    if (typeof message === "string" && message.length > 0) return message;
    const plain = optionalString(parsed.value.message);
    if (plain !== null && plain.length > 0) return plain;
  }
  return bodyText.trim().slice(0, 200);
}

function withDeadline<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderTimeoutError(ms));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readBody(response: { body: ReadableStream<Uint8Array> }): Promise<string> {
  try {
    return await new Response(response.body).text();
  } catch (error) {
    throw new ProviderTransportError(
      `response body could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function* ssePayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice("data:".length).trim();
          if (payload.length > 0) yield payload;
        }
        newline = buffer.indexOf("\n");
      }
    }
    const rest = buffer.replace(/\r$/, "");
    if (rest.startsWith("data:")) {
      const payload = rest.slice("data:".length).trim();
      if (payload.length > 0) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class OpenAiCompatibleClient {
  readonly endpoint: string;

  private readonly transport: ProviderTransport;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(connection: Connection, options: ClientOptions = {}) {
    const base = connection.baseUrl.replace(/\/+$/, "");
    this.endpoint = `${base}/chat/completions`;
    this.apiKey = connection.apiKey;
    this.transport = options.transport ?? fetchTransport();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** One non-streaming completion. */
  async chat(options: ChatOptions): Promise<ChatResult> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const response = await withDeadline(
      this.transport.send(this.buildRequest(options, false, controller)),
      timeoutMs,
      controller,
    );
    const bodyText = await readBody(response);
    if (response.status >= 400) {
      throw classifyStatus(response.status, bodyText, response.headers);
    }
    const parsed = tryJson(bodyText);
    if (!parsed.ok) {
      throw new ProviderTransportError(`response body is not JSON: ${parsed.message}`);
    }
    return parseCompletion(parsed.value);
  }

  /**
   * One streaming completion. Yields deltas as they arrive and, last, `completed` carrying the
   * assembled result. A refusal or a malformed tool call throws at the end of the iteration.
   */
  async *streamChat(options: ChatOptions): AsyncGenerator<ChatStreamEvent> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const response = await withDeadline(
      this.transport.send(this.buildRequest(options, true, controller)),
      timeoutMs,
      controller,
    );
    if (response.status >= 400) {
      throw classifyStatus(response.status, await readBody(response), response.headers);
    }

    let text = "";
    let finishReason = "";
    let refusal: string | null = null;
    const calls = new Map<
      number,
      { id: string | null; name: string; args: string; repairs: string[] }
    >();

    const payloads = ssePayloads(response.body);
    while (true) {
      const step = await withDeadline(payloads.next(), timeoutMs, controller);
      if (step.done === true) break;
      const payload = step.value;
      if (payload === "[DONE]") break;

      const chunk = parseSsePayload(payload);
      const choices = chunk.choices;
      if (!Array.isArray(choices) || choices.length === 0) continue;
      const choice = asRecord(choices[0], "stream choice");
      const reason = optionalString(choice.finish_reason);
      if (reason !== null && reason.length > 0) finishReason = reason;
      const delta = asRecord(choice.delta ?? {}, "stream delta");
      const refusalDelta = optionalString(delta.refusal);
      if (refusalDelta !== null && refusalDelta.length > 0) refusal = refusalDelta;

      const content = optionalString(delta.content);
      if (content !== null && content.length > 0) {
        text += content;
        yield { type: "text_delta", text: content };
      }

      const toolCalls = delta.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const entry of toolCalls) {
          const record = asRecord(entry, "stream tool call");
          const index = Number(record.index ?? calls.size);
          const existing = calls.get(index) ?? { id: null, name: "", args: "", repairs: [] };
          const id = optionalString(record.id);
          if (id !== null) existing.id = id;
          const fn = record.function;
          const name = isRecord(fn) ? optionalString(fn.name) : null;
          const argsDelta = isRecord(fn) ? optionalString(fn.arguments) : null;
          if (name !== null && name.length > 0) existing.name = name;
          if (argsDelta !== null) {
            existing.args += argsDelta;
            calls.set(index, existing);
            yield {
              type: "tool_call_delta",
              index,
              id,
              name: name !== null && name.length > 0 ? name : null,
              argumentsDelta: argsDelta,
            };
            continue;
          }
          calls.set(index, existing);
        }
      }
    }

    if (refusal !== null) {
      throw new ProviderRefusalError(finishReason === "" ? "refusal" : finishReason, refusal);
    }
    if (finishReason === "content_filter") {
      throw new ProviderRefusalError(finishReason, text);
    }

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => {
        const name = call.name === "" ? null : call.name;
        const parsed = parseToolCallArguments(call.args, name);
        return {
          id: call.id ?? `tool-call-${index}`,
          name: name ?? "",
          arguments: call.args,
          args: parsed.args,
          repairs: parsed.repairs,
        };
      });

    yield {
      type: "completed",
      result: { text, toolCalls, finishReason, usage: null },
    };
  }

  private buildRequest(
    options: ChatOptions,
    stream: boolean,
    controller: AbortController,
  ): ProviderRequest {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages.map((message) => serializeMessage(message)),
      stream,
    };
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }
    if (options.toolChoice !== undefined) {
      body.tool_choice =
        typeof options.toolChoice === "string"
          ? options.toolChoice
          : {
              type: "function",
              function: { name: options.toolChoice.name },
            };
    }
    if (options.responseFormat !== undefined) {
      body.response_format = { type: options.responseFormat };
    }
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const signal = combineSignals(controller, options.signal);
    return {
      url: this.endpoint,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    };
  }
}

function serializeMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId;
  if (message.toolCalls !== undefined) {
    wire.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return wire;
}

function combineSignals(controller: AbortController, extra: AbortSignal | undefined): AbortSignal {
  if (extra === undefined) return controller.signal;
  if (extra.aborted) controller.abort();
  else extra.addEventListener("abort", () => controller.abort(), { once: true });
  return controller.signal;
}

/** Map a non-2xx answer onto the typed error the caller can act on. */
export function classifyStatus(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): Error {
  const detail = errorDetail(bodyText);
  if (status === 401 || status === 403) return new ProviderAuthError(status, detail);
  if (status === 429)
    return new ProviderRateLimitError(status, detail, retryAfterMs(headers, bodyText));
  return new ProviderHttpError(status, bodyText);
}
