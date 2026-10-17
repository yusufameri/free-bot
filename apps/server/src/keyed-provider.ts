/**
 * The keyed provider: one real model turn per loop turn, over the landed OpenAI-compatible client.
 *
 * The loop owns the gate and the sandbox, so this adapter owns only the wire. It carries the prompt,
 * the tools the run offers, and every tool's outcome back to the model, and turns the reply into the
 * `ProviderTurn` the loop asked for. Nothing here executes a tool and nothing here decides whether
 * one may run: a call the model asks for leaves as a call the gate then judges, which is what keeps
 * the gate the only thing that allows anything.
 *
 * The conversation accumulates here, because the loop hands each turn only the outcomes of the one
 * before it. Two facts leave this object: the `journal`, for the evidence driver, and one note per
 * turn through `note`, so the request the app made and the model's own words are readable outside
 * the process that made them. The key is in neither: it reaches one `Authorization` header.
 */

import type {
  ProviderPort,
  ProviderToolCall,
  ProviderTurn,
  ToolDefinition,
  ToolOutcome,
  TurnInput,
} from "@freebot/core";
import { ProviderTurnError } from "@freebot/core";
import {
  type ChatMessage,
  type ChatResult,
  type Connection,
  OpenAiCompatibleClient,
  ProviderAuthError,
  ProviderMalformedToolCallError,
  ProviderRateLimitError,
  type ToolCallInput,
  type ToolSpec,
  type Usage,
} from "@freebot/providers";

/** The request one turn made, as a reader can check it. The header value is never the key. */
export interface KeyedRequest {
  readonly method: "POST";
  readonly url: string;
  readonly model: string;
  readonly messages: number;
  readonly tools: readonly string[];
  readonly authorization: "Bearer <redacted>";
}

export interface KeyedCall {
  readonly toolCallId: string;
  readonly toolName: string;
  /** The arguments exactly as the provider sent them, before parsing. */
  readonly arguments: string;
  /** The readings the client's parser applied, so a weak caller's shape is visible not hidden. */
  readonly repairs: readonly string[];
}

/** One real turn, held for a driver that reads the run rather than trusting this summary. */
export interface KeyedTurnRecord {
  readonly turn: number;
  readonly request: KeyedRequest;
  readonly text: string;
  readonly calls: readonly KeyedCall[];
  readonly finishReason: string;
  readonly usage: Usage | null;
}

const SYSTEM_PROMPT = [
  "You are the bot in a sandboxed workspace with one tool, bash, which runs a command line inside",
  "the sandbox. Do the work with that tool, then answer in one short paragraph.",
  "A call the gate refuses is final: do not ask for it again, and say what you did instead.",
].join(" ");

export interface KeyedProviderOptions {
  readonly connection: Connection;
  readonly model: string;
  /** The run's prompt: the model's one user message. */
  readonly prompt: string;
  readonly system?: string;
  /** Whether the run's gate governs this tool. Fail-closed: an unknown tool is governed. */
  readonly destructive?: (toolName: string) => boolean;
  readonly timeoutMs?: number;
  /** Injectable so a test drives the adapter over a loopback transport. */
  readonly client?: OpenAiCompatibleClient;
  /** One line per turn, for a driver reading the run's own process. Defaults to stderr. */
  readonly note?: (line: string) => void;
}

export class KeyedProvider implements ProviderPort {
  readonly #client: OpenAiCompatibleClient;
  readonly #model: string;
  readonly #destructive: (toolName: string) => boolean;
  readonly #note: (line: string) => void;
  readonly #apiKey: string;
  readonly #journal: KeyedTurnRecord[] = [];
  readonly #conversation: ChatMessage[];
  #pending: readonly ToolCallInput[] = [];
  #pendingText = "";

  constructor(options: KeyedProviderOptions) {
    this.#model = options.model;
    this.#apiKey = options.connection.apiKey;
    this.#client =
      options.client ??
      new OpenAiCompatibleClient(options.connection, {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    this.#destructive = options.destructive ?? (() => true);
    this.#note = options.note ?? ((line) => console.error(line));
    this.#conversation = [
      { role: "system", content: options.system ?? SYSTEM_PROMPT },
      { role: "user", content: options.prompt },
    ];
  }

  /** Every turn of this run, in order, for a driver that must show the turn was real. */
  get journal(): readonly KeyedTurnRecord[] {
    return this.#journal;
  }

  /** The conversation as the wire has it, so a test can read what the model was told. */
  get conversation(): readonly ChatMessage[] {
    return this.#conversation;
  }

  async next(input: TurnInput): Promise<ProviderTurn> {
    this.#answerPrevious(input);
    const request: KeyedRequest = {
      method: "POST",
      url: this.#client.endpoint,
      model: this.#model,
      messages: this.#conversation.length,
      tools: input.tools.map((tool) => tool.name),
      authorization: "Bearer <redacted>",
    };
    this.#note(
      `freebot provider: turn ${input.turn} request ${request.method} ${request.url} ` +
        `model=${request.model} messages=${request.messages} tools=${request.tools.join(",")} ` +
        `authorization="${request.authorization}"`,
    );

    let result: ChatResult;
    try {
      result = await this.#client.chat({
        model: this.#model,
        messages: this.#conversation,
        tools: input.tools.map(toToolSpec),
        toolChoice: "auto",
      });
    } catch (error) {
      throw this.#asTurnError(error);
    }

    if (result.text.length > 0) {
      this.#note(
        `freebot provider: turn ${input.turn} text ${JSON.stringify(this.#redact(result.text))}`,
      );
    }
    const calls = result.toolCalls.map((call) => {
      if (!input.tools.some((tool) => tool.name === call.name)) {
        throw new ProviderTurnError(
          "provider_malformed_tool_call",
          `the model asked for ${JSON.stringify(call.name)}, which this run does not offer`,
        );
      }
      this.#note(
        `freebot provider: turn ${input.turn} tool_call ${call.id} ${call.name} ` +
          `${this.#redact(call.arguments)}${call.repairs.length === 0 ? "" : ` repairs=${JSON.stringify(call.repairs)}`}`,
      );
      return {
        toolCallId: call.id,
        toolName: call.name,
        args: call.args,
        destructive: this.#destructive(call.name),
      } satisfies ProviderToolCall;
    });
    this.#note(
      `freebot provider: turn ${input.turn} done finish=${result.finishReason} usage=${formatUsage(result.usage)}`,
    );

    this.#journal.push({
      turn: input.turn,
      request,
      text: result.text,
      calls: result.toolCalls.map((call) => ({
        toolCallId: call.id,
        toolName: call.name,
        arguments: this.#redact(call.arguments),
        repairs: call.repairs,
      })),
      finishReason: result.finishReason,
      usage: result.usage,
    });
    this.#pending = result.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    }));
    this.#pendingText = result.text;
    return { text: result.text.length === 0 ? [] : [result.text], toolCalls: calls };
  }

  /** Put the finished turn and its outcomes into the conversation, before the next one is asked. */
  #answerPrevious(input: TurnInput): void {
    if (input.turn === 1) {
      if (input.results.length > 0) {
        throw new ProviderTurnError(
          "internal_invariant",
          "the first turn arrived with results from a turn the model was never asked",
        );
      }
      return;
    }
    if (input.results.length !== this.#pending.length) {
      throw new ProviderTurnError(
        "internal_invariant",
        `turn ${input.turn} carried ${input.results.length} results for ${this.#pending.length} calls`,
      );
    }
    this.#conversation.push({
      role: "assistant",
      content: this.#pendingText.length === 0 ? null : this.#pendingText,
      toolCalls: [...this.#pending],
    });
    for (const [index, outcome] of input.results.entries()) {
      const call = this.#pending[index];
      if (call === undefined) continue;
      this.#conversation.push({
        role: "tool",
        toolCallId: call.id,
        content: outcomeText(outcome),
      });
    }
  }

  /** The client's typed failures as the run's taxonomy. Anything unnamed settles at the invariant. */
  #asTurnError(error: unknown): ProviderTurnError {
    if (error instanceof ProviderAuthError) {
      return new ProviderTurnError(
        "provider_auth",
        `${error.name}: ${this.#redact(error.message)}`,
      );
    }
    if (error instanceof ProviderRateLimitError) {
      // The wire's own hint belongs in the failure line: it is the one thing that tells an operator
      // when the same run is worth starting again.
      const hint = error.retryAfterMs === null ? "" : `, retry after ${error.retryAfterMs}ms`;
      return new ProviderTurnError(
        "provider_rate_limit",
        `${error.name}: ${this.#redact(error.message)}${hint}`,
      );
    }
    if (error instanceof ProviderMalformedToolCallError) {
      return new ProviderTurnError(
        "provider_malformed_tool_call",
        `${error.name}: ${this.#redact(error.message)}`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ProviderTurnError("internal_invariant", this.#redact(message));
  }

  /**
   * Belt and braces for order 8. The provider should never echo an `Authorization` header, and this
   * adapter never reads one back, so a value that did arrive would have to be quoted by the
   * provider itself. Redacting it here means no note, journal line, or failure detail can carry a
   * key out of this process whatever the provider does.
   */
  #redact(text: string): string {
    if (this.#apiKey.length === 0) return text;
    return text.split(this.#apiKey).join("<redacted>");
  }
}

/** What the model is told a call did. A refusal is final and says so. */
export function outcomeText(outcome: ToolOutcome): string {
  if (outcome.denied) return `refused by the user: ${outcome.output}`;
  if (!outcome.ok) return `the command failed: ${outcome.output}`;
  return outcome.output.length === 0 ? "(the command produced no output)" : outcome.output;
}

export function formatUsage(usage: Usage | null): string {
  return usage === null
    ? "none"
    : `${usage.inputTokens}/${usage.outputTokens}/${usage.totalTokens}`;
}

function toToolSpec(tool: ToolDefinition): ToolSpec {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}
