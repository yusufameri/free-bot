/**
 * The DOM surface for the shared thread model: `packages/ui/src/thread.ts` decides, this renders.
 * It is framework-agnostic on purpose (plan 2.5 names Next.js for apps/web and React for the shared
 * core; see docs/web-shell.md for why this unit ships neither yet).
 *
 * The element ids and `data-*` hooks below are the contract the evidence harness asserts on, so the
 * facts it records are read from the rendered page rather than from the model that produced it.
 */

import type { Message } from "@freebot/protocol";
import type { FrameFacts } from "../src/frames.ts";
import { applyMessage, initialState, runInFlight, type ThreadState } from "../src/thread.ts";

declare global {
  interface Window {
    /** Live facts, read from the DOM, for the CDP harness (the smoke's hook, page-shaped). */
    __threadFacts?: () => FrameFacts;
    __threadConnection?: () => string;
  }
}

export type Connection = "connecting" | "connected" | "reconnecting" | "error";

export interface ThreadHandle {
  apply(message: Message): void;
  setConnection(connection: Connection): void;
  showError(message: string): void;
  /** Empty the transcript for a different thread's frames: the state, the DOM, and the counters. */
  reset(): void;
  state(): ThreadState;
  facts(): FrameFacts;
}

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

export function mountThread(config: {
  onAnswer: (decision: "allow" | "deny", approvalId: string) => void;
  /** The page's stop, sent for the run on screen. Omitted leaves the control inert. */
  onCancel?: (runId: string) => void;
  autoAnswer?: "allow" | "deny" | null;
  /** Fired on every connection change, so a second surface (the banner) reads the same state. */
  onConnection?: (connection: Connection) => void;
}): ThreadHandle {
  const connEl = must<HTMLSpanElement>("#conn");
  const lastSeqEl = must<HTMLSpanElement>("#lastseq");
  const dupsEl = must<HTMLSpanElement>("#dups");
  const runEl = must<HTMLSpanElement>("#run");
  const stopEl = must<HTMLButtonElement>("#stop");
  const resumeEl = must<HTMLDivElement>("#resume");
  const errorEl = must<HTMLDivElement>("#error");
  const threadEl = must<HTMLElement>("#thread");
  const idleNote = threadEl.querySelector<HTMLElement>("#idle-note");

  const toolRefs = new Map<
    string,
    { card: HTMLElement; status: HTMLElement; output: HTMLElement; details: HTMLDetailsElement }
  >();
  const approvalRefs = new Map<
    string,
    { card: HTMLElement; actions: HTMLElement; toolCallId: string }
  >();
  let currentAssistant: HTMLElement | null = null;
  let state = initialState();
  /** A click already sent, so the control cannot send the same stop twice. */
  let stopRequested = false;

  function updateHeader(): void {
    lastSeqEl.textContent = `last seq ${state.lastSeq}`;
    lastSeqEl.dataset.lastSeq = String(state.lastSeq);
    dupsEl.textContent = `duplicates ignored: ${state.duplicatesIgnored}`;
    dupsEl.dataset.duplicatesIgnored = String(state.duplicatesIgnored);
    if (state.runId !== null) {
      runEl.textContent = `run ${state.runId}`;
      runEl.dataset.runId = state.runId;
    }
    if (state.runStatus === null) delete runEl.dataset.runStatus;
    else runEl.dataset.runStatus = state.runStatus;
  }

  /**
   * The stop control's whole state: present always, enabled only while a run is in flight and no
   * stop is already on its way. The driver reads `disabled`, the label and these data attributes.
   */
  function updateStop(): void {
    const inFlight = runInFlight(state);
    stopEl.textContent = "Stop run";
    stopEl.disabled = !inFlight || stopRequested || config.onCancel === undefined;
    stopEl.dataset.inFlight = String(inFlight);
    stopEl.dataset.stopping = String(stopRequested);
    if (state.runId === null) delete stopEl.dataset.runId;
    else stopEl.dataset.runId = state.runId;
  }

  function sendAnswer(decision: "allow" | "deny", approvalId: string): void {
    const refs = approvalRefs.get(approvalId);
    if (refs !== undefined) {
      for (const button of refs.actions.querySelectorAll("button")) button.disabled = true;
      refs.card.dataset.answerSent = decision;
    }
    config.onAnswer(decision, approvalId);
  }

  /**
   * A card whose run has ended has no answer to give, so its buttons go and the card carries the
   * run's word instead of a person's. A replayed transcript can hold a card whose run the process
   * never came back to (a restart, a stop) and its request is nobody's to approve now: leaving the
   * buttons live would invite a click that reaches no parked call.
   */
  function closeWaitingCards(end: "cancelled" | "failed"): void {
    for (const refs of approvalRefs.values()) {
      for (const button of refs.actions.querySelectorAll("button")) button.disabled = true;
      if (refs.card.dataset.decision === undefined) {
        refs.card.dataset.decision = end;
        refs.actions.append(
          el("span", "approval-result", end === "cancelled" ? "run stopped" : "run failed"),
        );
      }
    }
  }

  function renderMessage(message: Message): void {
    if (idleNote !== null) idleNote.hidden = true;
    switch (message.type) {
      case "run.started": {
        const bubble = el("article", "frame message user");
        bubble.dataset.seq = String(message.seq);
        bubble.append(el("div", "prompt", message.payload.prompt));
        threadEl.append(bubble);
        break;
      }
      case "turn.started": {
        const section = el("section", "frame turn");
        section.dataset.seq = String(message.seq);
        section.dataset.turn = String(message.payload.turn);
        section.append(el("h3", "turn-title", `turn ${message.payload.turn}`));
        currentAssistant = el("div", "assistant");
        section.append(currentAssistant);
        threadEl.append(section);
        break;
      }
      case "message.text.delta": {
        const span = el("span", "frame delta", message.payload.text);
        span.dataset.seq = String(message.seq);
        (currentAssistant ?? threadEl).append(span);
        break;
      }
      case "tool_call.requested": {
        const card = el("article", "frame tool-card");
        card.dataset.seq = String(message.seq);
        card.dataset.toolCall = message.payload.toolCallId;
        card.append(el("code", "cmd", message.payload.command));
        if (message.payload.destructive) card.classList.add("destructive");
        const status = el(
          "span",
          "status",
          message.payload.destructive ? "awaiting approval" : "running",
        );
        status.dataset.status = message.payload.destructive ? "awaiting approval" : "running";
        card.append(status);
        const details = el("details", "output-details") as HTMLDetailsElement;
        details.open = true;
        details.hidden = true;
        details.append(el("summary", "output-summary", "output"));
        const output = el("pre", "output");
        details.append(output);
        card.append(details);
        threadEl.append(card);
        toolRefs.set(message.payload.toolCallId, { card, status, output, details });
        break;
      }
      case "tool_call.decision": {
        const payload = message.payload;
        const verdict = payload.allow ? "allow" : `deny (${payload.code})`;
        const marker = el(
          "div",
          "frame tool-decision",
          `decision ${payload.toolCallId}: ${verdict}`,
        );
        marker.dataset.seq = String(message.seq);
        marker.dataset.toolCall = payload.toolCallId;
        marker.dataset.allow = String(payload.allow);
        threadEl.append(marker);
        break;
      }
      case "tool_call.result": {
        const refs = toolRefs.get(message.payload.toolCallId);
        const word = message.payload.denied ? "denied" : "done";
        if (refs !== undefined) {
          refs.status.textContent = word;
          refs.status.dataset.status = word;
          refs.output.textContent = message.payload.denied ? "" : message.payload.output;
          refs.details.hidden = message.payload.denied || message.payload.output === "";
          refs.card.classList.add("finished");
          refs.card.dataset.finished = word;
        }
        const millis =
          message.payload.durationMs === null ? "" : ` in ${message.payload.durationMs}ms`;
        const marker = el(
          "div",
          "frame tool-result",
          `result ${message.payload.toolCallId}: ${word}${millis}`,
        );
        marker.dataset.seq = String(message.seq);
        marker.dataset.toolCall = message.payload.toolCallId;
        threadEl.append(marker);
        break;
      }
      case "approval.requested": {
        const card = el("article", "frame approval-card");
        card.dataset.seq = String(message.seq);
        card.dataset.approval = message.payload.approvalId;
        card.append(
          el(
            "div",
            "approval-body",
            "This call needs your approval: it can destroy or change things.",
          ),
        );
        card.append(el("code", "cmd", message.payload.command));
        const actions = el("div", "approval-actions");
        const allow = el("button", "allow-once", "Allow once");
        const deny = el("button", "deny", "Deny");
        allow.addEventListener("click", () => sendAnswer("allow", message.payload.approvalId));
        deny.addEventListener("click", () => sendAnswer("deny", message.payload.approvalId));
        actions.append(allow, deny);
        card.append(actions);
        threadEl.append(card);
        approvalRefs.set(message.payload.approvalId, {
          card,
          actions,
          toolCallId: message.payload.toolCallId,
        });
        if (config.autoAnswer === "allow" || config.autoAnswer === "deny") {
          const answer = config.autoAnswer;
          setTimeout(() => sendAnswer(answer, message.payload.approvalId), 600);
        }
        break;
      }
      case "approval.resolved": {
        const decision = message.payload.decision;
        const word = decision === "allow" ? "allowed once" : "denied";
        const marker = el(
          "div",
          "frame approval-resolved",
          `approval ${message.payload.approvalId}: ${word}`,
        );
        marker.dataset.seq = String(message.seq);
        threadEl.append(marker);
        const refs = approvalRefs.get(message.payload.approvalId);
        if (refs !== undefined) {
          refs.card.classList.add("resolved");
          refs.card.dataset.decision = decision;
          refs.actions.replaceChildren(el("span", "approval-result", word));
          const governed = toolRefs.get(refs.toolCallId);
          const status = decision === "allow" ? "running" : "denied";
          if (governed !== undefined) {
            governed.status.textContent = status;
            governed.status.dataset.status = status;
          }
        }
        break;
      }
      case "grant.lifecycle": {
        const payload = message.payload;
        const marker = el(
          "div",
          "frame grant-lifecycle",
          `grant ${payload.grantId}: ${payload.state}`,
        );
        marker.dataset.seq = String(message.seq);
        marker.dataset.grant = payload.grantId;
        marker.dataset.state = payload.state;
        threadEl.append(marker);
        break;
      }
      case "turn.ended": {
        const marker = el("div", "frame turn-end", `turn ${message.payload.turn} complete`);
        marker.dataset.seq = String(message.seq);
        threadEl.append(marker);
        break;
      }
      case "run.status": {
        // The run's own transition. Without this arm the frame is applied to the model and rendered
        // nowhere, so a run parked at the gate looks like a run that froze.
        const marker = el("div", "frame run-status", `run ${message.payload.status}`);
        marker.dataset.seq = String(message.seq);
        marker.dataset.runStatus = message.payload.status;
        threadEl.append(marker);
        if (message.payload.status === "cancelled") {
          // The card that was waiting has no answer now; a stop is not an allow and not a denial.
          closeWaitingCards("cancelled");
        }
        break;
      }
      case "run.finished": {
        const marker = el("div", "frame run-finished", "stream complete");
        marker.dataset.seq = String(message.seq);
        marker.dataset.runFinished = "true";
        threadEl.append(marker);
        break;
      }
      case "run.failed": {
        const marker = el("div", "frame run-failed", `run failed: ${message.payload.reason}`);
        marker.dataset.seq = String(message.seq);
        marker.dataset.runFailed = "true";
        threadEl.append(marker);
        // A failed run never reads its parked approval, so the card it left behind closes too.
        closeWaitingCards("failed");
        break;
      }
      case "stream.resumed": {
        resumeEl.hidden = false;
        resumeEl.textContent = `resumed from seq ${message.payload.fromSeq}`;
        resumeEl.dataset.resumedFrom = String(message.payload.fromSeq);
        break;
      }
      default:
        break;
    }
  }

  function facts(): FrameFacts {
    const resumeDataset = resumeEl.dataset.resumedFrom;
    return {
      lastSeq: Number(lastSeqEl.dataset.lastSeq ?? "0"),
      done: threadEl.querySelector(".run-finished") !== null,
      frameCount: threadEl.querySelectorAll(".frame[data-seq]").length,
      turns: threadEl.querySelectorAll(".turn").length,
      cards: [...threadEl.querySelectorAll<HTMLElement>(".tool-card")].map((card) => [
        card.dataset.toolCall ?? "",
        card.querySelector(".status")?.textContent ?? "",
      ]),
      outputShown: [...threadEl.querySelectorAll<HTMLElement>(".tool-card")].map(
        (card) => card.querySelector<HTMLElement>(".output-details")?.hidden === false,
      ),
      approvals: [...threadEl.querySelectorAll<HTMLElement>(".approval-card")].map(
        (card) => card.dataset.decision ?? null,
      ),
      deltas: [...threadEl.querySelectorAll<HTMLElement>(".delta")].map(
        (node) => node.textContent ?? "",
      ),
      resume: resumeEl.hidden || resumeDataset === undefined ? null : Number(resumeDataset),
      streamEnd: threadEl.querySelector(".run-finished")?.textContent ?? null,
    };
  }

  /** The one place the header's connection word is written, so every writer is also a reporter. */
  function announceConnection(connection: Connection): void {
    connEl.textContent = connection;
    connEl.dataset.connection = connection;
    config.onConnection?.(connection);
  }

  function showError(message: string): void {
    errorEl.hidden = false;
    errorEl.textContent = `stream error: ${message}`;
    errorEl.dataset.error = message;
    announceConnection("error");
  }

  stopEl.addEventListener("click", () => {
    if (state.runId === null || !runInFlight(state) || stopRequested) return;
    stopRequested = true;
    updateStop();
    config.onCancel?.(state.runId);
  });

  updateHeader();
  updateStop();

  return {
    apply(message: Message): void {
      const next = applyMessage(state, message);
      const applied = next.applied > state.applied;
      const announced = "seq" in message ? null : message.type;
      state = next;
      if (message.type === "run.started") stopRequested = false;
      if (applied || announced === "stream.resumed") renderMessage(message);
      updateHeader();
      updateStop();
      if (state.error !== null) showError(state.error);
    },
    setConnection(connection: Connection): void {
      announceConnection(connection);
    },
    reset(): void {
      state = initialState();
      stopRequested = false;
      toolRefs.clear();
      approvalRefs.clear();
      currentAssistant = null;
      threadEl.replaceChildren();
      if (idleNote !== null) {
        idleNote.hidden = false;
        threadEl.append(idleNote);
      }
      resumeEl.hidden = true;
      resumeEl.textContent = "";
      delete resumeEl.dataset.resumedFrom;
      errorEl.hidden = true;
      errorEl.textContent = "";
      delete errorEl.dataset.error;
      runEl.textContent = "";
      delete runEl.dataset.runId;
      delete runEl.dataset.runStatus;
      updateHeader();
      updateStop();
    },
    showError,
    state(): ThreadState {
      return state;
    },
    facts,
  };
}

/** Expose the live facts on `window` so a CDP driver reads the page, not a serialized model. */
export function exposeFacts(handle: ThreadHandle): void {
  window.__threadFacts = () => handle.facts();
}
