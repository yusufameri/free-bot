// Copied-with-attribution from spikes/web-stream/app.ts (U0.10). Unmodified except this header.
import type { DisplayFrame } from "./envelope.ts";
import { applyFrame, initialState, markError, markResumed } from "./reducer.ts";

const params = new URLSearchParams(location.search);
const autoAnswer = params.get("auto");

let state = initialState();

const connEl = must<HTMLSpanElement>("#conn");
const dupsEl = must<HTMLSpanElement>("#dups");
const lastSeqEl = must<HTMLSpanElement>("#lastseq");
const resumeEl = must<HTMLDivElement>("#resume");
const errorEl = must<HTMLDivElement>("#error");
const streamEl = must<HTMLElement>("#stream");

const toolRefs = new Map<string, { card: HTMLElement; status: HTMLElement; output: HTMLElement }>();
const approvalRefs = new Map<string, { card: HTMLElement; actions: HTMLElement }>();
let currentAssistant: HTMLElement | null = null;
let socket: WebSocket | null = null;

function must<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`missing element ${selector}`);
  return found;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function updateHeader(): void {
  dupsEl.textContent = `duplicates ignored: ${state.duplicatesIgnored}`;
  lastSeqEl.textContent = `last seq ${state.lastSeq}`;
}

function sendAnswer(decision: "allow" | "deny", approvalId: string): void {
  const refs = approvalRefs.get(approvalId);
  if (refs !== undefined) {
    for (const button of refs.actions.querySelectorAll("button")) button.disabled = true;
    refs.card.dataset.answerSent = decision;
  }
  socket?.send(JSON.stringify({ type: "answer", decision, approvalId }));
}

function renderFrame(frame: DisplayFrame): void {
  switch (frame.type) {
    case "turn_start": {
      const section = el("section", "frame turn");
      section.dataset.seq = String(frame.seq);
      section.append(el("h3", "turn-title", `turn ${frame.payload.turn}`));
      currentAssistant = el("div", "assistant");
      section.append(currentAssistant);
      streamEl.append(section);
      break;
    }
    case "message_delta": {
      const span = el("span", "frame delta", frame.payload.text);
      span.dataset.seq = String(frame.seq);
      (currentAssistant ?? streamEl).append(span);
      break;
    }
    case "tool_call": {
      const card = el("article", "frame tool-card");
      card.dataset.seq = String(frame.seq);
      card.dataset.toolCall = frame.payload.toolCallId;
      card.append(el("code", "cmd", frame.payload.command));
      if (frame.payload.destructive) card.classList.add("destructive");
      const status = el(
        "span",
        "status",
        frame.payload.destructive ? "awaiting approval" : "running",
      );
      card.append(status);
      const output = el("pre", "output");
      card.append(output);
      streamEl.append(card);
      toolRefs.set(frame.payload.toolCallId, { card, status, output });
      break;
    }
    case "approval_request": {
      const card = el("article", "frame approval-card");
      card.dataset.seq = String(frame.seq);
      card.dataset.approval = frame.payload.approvalId;
      card.append(
        el("div", "approval-body", "destructive tool call needs approval: "),
        el("code", "cmd", frame.payload.command),
      );
      const actions = el("div", "approval-actions");
      const allow = el("button", "allow-once", "Allow once");
      const deny = el("button", "deny", "Deny");
      allow.addEventListener("click", () => sendAnswer("allow", frame.payload.approvalId));
      deny.addEventListener("click", () => sendAnswer("deny", frame.payload.approvalId));
      actions.append(allow, deny);
      card.append(actions);
      streamEl.append(card);
      approvalRefs.set(frame.payload.approvalId, { card, actions });
      if (autoAnswer === "allow" || autoAnswer === "deny") {
        setTimeout(() => sendAnswer(autoAnswer, frame.payload.approvalId), 600);
      }
      break;
    }
    case "approval_resolved": {
      const decision = frame.payload.decision;
      const word =
        decision === "allow" ? "allowed once" : decision === "deny" ? "denied" : "pending";
      const marker = el(
        "div",
        "frame approval-resolved",
        `approval ${frame.payload.approvalId}: ${word}`,
      );
      marker.dataset.seq = String(frame.seq);
      streamEl.append(marker);
      const refs = approvalRefs.get(frame.payload.approvalId);
      if (refs !== undefined && decision !== null) {
        refs.card.classList.add("resolved");
        refs.card.dataset.decision = decision;
        refs.actions.replaceChildren(el("span", "approval-result", word));
      }
      break;
    }
    case "tool_result": {
      const refs = toolRefs.get(frame.payload.toolCallId);
      const word = frame.payload.denied ? "denied" : "done";
      if (refs !== undefined) {
        refs.status.textContent = word;
        refs.output.textContent = frame.payload.denied ? "" : frame.payload.output;
        refs.card.classList.add("finished");
      }
      const millis = frame.payload.durationMs === null ? "" : ` in ${frame.payload.durationMs}ms`;
      const marker = el(
        "div",
        "frame tool-result",
        `result ${frame.payload.toolCallId}: ${word}${millis}`,
      );
      marker.dataset.seq = String(frame.seq);
      marker.dataset.toolCall = frame.payload.toolCallId;
      streamEl.append(marker);
      break;
    }
    case "turn_end": {
      const marker = el("div", "frame turn-end", `turn ${frame.payload.turn} end`);
      marker.dataset.seq = String(frame.seq);
      streamEl.append(marker);
      break;
    }
    case "stream_end": {
      const marker = el("div", "frame stream-end", "stream complete");
      marker.dataset.seq = String(frame.seq);
      streamEl.append(marker);
      break;
    }
  }
}

function showError(message: string): void {
  errorEl.hidden = false;
  errorEl.textContent = `stream error: ${message}`;
  connEl.textContent = "error";
}

function connect(): void {
  const carry = new URLSearchParams();
  for (const key of ["drop_at", "echo_last", "auto"]) {
    const value = params.get(key);
    if (value !== null) carry.set(key, value);
  }
  carry.set("last_seen_seq", String(state.lastSeq));
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/events?${carry.toString()}`);
  socket = ws;
  ws.onopen = () => {
    if (state.lastSeq > 0) {
      state = markResumed(state, state.lastSeq);
      resumeEl.hidden = false;
      resumeEl.textContent = `resumed from seq ${state.lastSeq}`;
      resumeEl.dataset.resumedFrom = String(state.lastSeq);
    }
    connEl.textContent = "connected";
  };
  ws.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as DisplayFrame;
    try {
      const next = applyFrame(state, frame);
      const applied = next.frameCount === state.frameCount + 1;
      state = next;
      if (applied) renderFrame(frame);
    } catch (err) {
      state = markError(state, err instanceof Error ? err.message : String(err));
      showError(state.error ?? "unknown");
      ws.close();
      return;
    }
    updateHeader();
  };
  ws.onclose = () => {
    if (state.error !== null) return;
    connEl.textContent = "reconnecting";
    setTimeout(connect, 250);
  };
}

window.__webStreamState = () => ({
  lastSeq: state.lastSeq,
  frameCount: state.frameCount,
  duplicatesIgnored: state.duplicatesIgnored,
  resumedFrom: state.resumedFrom,
  awaitingApproval: state.awaitingApproval,
  done: state.done,
  error: state.error,
});

declare global {
  interface Window {
    __webStreamState: () => {
      lastSeq: number;
      frameCount: number;
      duplicatesIgnored: number;
      resumedFrom: number | null;
      awaitingApproval: boolean;
      done: boolean;
      error: string | null;
    };
  }
}

updateHeader();
connect();
