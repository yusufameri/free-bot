/**
 * `PiSession` drives one Pi process (or one replay) as a typed client: it sends commands,
 * correlates responses by id, surfaces events in arrival order, and answers the extension UI
 * dialogs that carry Gate 1.
 */

import { PiCommandError, PiProtocolError, PiTransportError } from "./errors.ts";
import type {
  ExtensionUiRequestFrame,
  PiEventFrame,
  PiExtensionUiResponse,
  PiRequest,
  PiResponse,
} from "./frames.ts";
import {
  decideToolCall,
  decodeToolGateRequest,
  defaultDenyGate,
  encodeToolGateDecision,
  TOOL_GATE_TITLE,
  type ToolGate,
} from "./gate.ts";
import type { Transport, TransportEvent } from "./transport.ts";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface PiSessionOptions {
  /** Consulted for every tool-gate dialog. Absent or denied is a closed gate. */
  gate?: ToolGate;
  /** Deadline for a command awaiting its response frame. Default 30000 ms. */
  requestTimeoutMs?: number;
}

/** One answered tool-gate dialog, in arrival order. The control plane's approval trail. */
export interface ToolGateLogEntry {
  dialogId: string;
  toolName: string | null;
  outcome: "allow" | "deny";
  reason?: string;
}

interface PendingRequest {
  resolve: (response: PiResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PiSession {
  /** Non-response inbound frames in arrival order. */
  readonly events: PiEventFrame[] = [];
  /** Unparsable stdout lines and id-less responses. */
  readonly protocolErrors: PiProtocolError[] = [];
  /** Every tool-gate decision, in arrival order. */
  readonly toolGates: ToolGateLogEntry[] = [];

  private readonly transport: Transport;
  private readonly gate: ToolGate;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(frame: PiEventFrame) => void>();
  private readonly unsubscribeTransport: () => void;
  private requestCounter = 0;
  private settledSeen = false;
  private closing = false;

  constructor(transport: Transport, options: PiSessionOptions = {}) {
    this.transport = transport;
    this.gate = options.gate ?? defaultDenyGate;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.unsubscribeTransport = transport.subscribe((event) => this.onTransportEvent(event));
  }

  /** Send a command and resolve with its response. `success:false` rejects with PiCommandError. */
  async request(command: PiRequest): Promise<PiResponse> {
    if (this.closing) throw new PiTransportError("session is closed");
    const id = command.id ?? `req-${++this.requestCounter}`;
    const withId = { ...command, id } as PiRequest;
    const response = new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiTransportError(`timeout: no response for ${id}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.transport.write(withId);
    } catch (error) {
      const entry = this.pending.get(id);
      if (entry !== undefined) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
      }
      throw error;
    }
    const answer = await response;
    if (!answer.success) throw new PiCommandError(answer);
    return answer;
  }

  /** Answer an extension UI request. `id` must repeat the request's id. */
  respond(response: PiExtensionUiResponse): void {
    try {
      this.transport.write(response);
    } catch (error) {
      this.noteProtocolError(error);
    }
  }

  /** Listen to non-response frames as they arrive. */
  subscribe(listener: (frame: PiEventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolve when Pi reports `agent_settled`; the only "Pi will not continue" signal. */
  waitForSettled(timeoutMs = 120_000): Promise<void> {
    if (this.settledSeen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const unsubscribe = this.subscribe((frame) => {
        if (frame.type !== "agent_settled") return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new PiTransportError("timeout: agent_settled never arrived"));
      }, timeoutMs);
    });
  }

  /** Close the transport and fail everything still pending. */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.failPending(new PiTransportError("session closed"));
    this.unsubscribeTransport();
    this.transport.close();
  }

  private onTransportEvent(event: TransportEvent): void {
    switch (event.kind) {
      case "error":
        this.protocolErrors.push(event.error);
        return;
      case "closed":
        if (this.closing) return;
        this.failPending(event.error ?? new PiTransportError("pi closed the connection"));
        return;
      case "frame": {
        const frame = event.frame;
        if (frame.type === "response") {
          this.onResponse(frame);
          return;
        }
        this.events.push(frame);
        if (frame.type === "agent_settled") this.settledSeen = true;
        if (frame.type === "extension_ui_request") void this.onDialog(frame);
        for (const listener of this.listeners) listener(frame);
      }
    }
  }

  private onResponse(response: PiResponse): void {
    if (response.id !== undefined) {
      const entry = this.pending.get(response.id);
      if (entry !== undefined) {
        this.pending.delete(response.id);
        clearTimeout(entry.timer);
        entry.resolve(response);
        return;
      }
    }
    // A response nobody asked for; Pi's malformed-stdin `parse` answer arrives this way (rpc.md).
    this.protocolErrors.push(
      new PiProtocolError(
        `response without a pending request: ${response.command}`,
        JSON.stringify(response),
      ),
    );
  }

  private async onDialog(request: ExtensionUiRequestFrame): Promise<void> {
    if (!DIALOG_METHODS.has(request.method)) return;
    if (request.method === "input" && request.title === TOOL_GATE_TITLE) {
      await this.answerToolGate(request);
      return;
    }
    // An unattributed dialog stays unanswered for nobody: fail closed rather than park Pi.
    this.respond({ type: "extension_ui_response", id: request.id, cancelled: true });
  }

  private async answerToolGate(request: ExtensionUiRequestFrame): Promise<void> {
    const call = decodeToolGateRequest(request.placeholder);
    if (call === undefined) {
      this.toolGates.push({
        dialogId: request.id,
        toolName: null,
        outcome: "deny",
        reason: "malformed tool gate request",
      });
      this.respond({ type: "extension_ui_response", id: request.id, cancelled: true });
      return;
    }
    if (typeof request.timeout !== "number") {
      this.toolGates.push({
        dialogId: request.id,
        toolName: call.toolName,
        outcome: "deny",
        reason: "dialog carried no timeout",
      });
      this.respond({ type: "extension_ui_response", id: request.id, cancelled: true });
      return;
    }

    let answered = false;
    const watchdog = setTimeout(() => {
      if (answered) return;
      answered = true;
      this.toolGates.push({
        dialogId: request.id,
        toolName: call.toolName,
        outcome: "deny",
        reason: "dialog timeout",
      });
      this.respond({ type: "extension_ui_response", id: request.id, cancelled: true });
    }, request.timeout);

    const decision = await decideToolCall(this.gate, call);
    if (answered) {
      this.toolGates.push({
        dialogId: request.id,
        toolName: call.toolName,
        outcome: "deny",
        reason: `late answer dropped: ${decision.allow ? "allow" : decision.reason}`,
      });
      return;
    }
    answered = true;
    clearTimeout(watchdog);
    if (decision.allow) {
      this.toolGates.push({ dialogId: request.id, toolName: call.toolName, outcome: "allow" });
    } else {
      this.toolGates.push({
        dialogId: request.id,
        toolName: call.toolName,
        outcome: "deny",
        reason: decision.reason,
      });
    }
    this.respond({
      type: "extension_ui_response",
      id: request.id,
      value: encodeToolGateDecision(decision),
    });
  }

  private failPending(error: PiTransportError): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private noteProtocolError(error: unknown): void {
    if (error instanceof PiProtocolError) {
      this.protocolErrors.push(error);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.protocolErrors.push(new PiProtocolError(`write failed: ${message}`, message));
  }
}
