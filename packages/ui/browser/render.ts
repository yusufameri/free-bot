/**
 * The DOM surface for the shared thread model: `packages/ui/src/thread.ts` decides, this renders.
 * It is framework-agnostic on purpose (plan 2.5 names Next.js for apps/web and React for the shared
 * core; see docs/web-shell.md for why this unit ships neither yet).
 *
 * The element ids and `data-*` hooks below are the contract the evidence harness asserts on, so the
 * facts it records are read from the rendered page rather than from the model that produced it.
 */

import type { Message } from "@freebot/protocol";
import {
  type ApprovalItemState,
  approvalItemState,
  type FrameFacts,
  type ToolItemState,
  TURN_ITEM_TEXT,
  type TurnItemState,
  toolItemState,
} from "../src/frames.ts";
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

  interface ToolRefs {
    readonly card: HTMLElement;
    readonly dot: HTMLElement;
    readonly tag: HTMLElement;
    readonly details: HTMLDetailsElement;
    readonly summary: HTMLElement;
    readonly output: HTMLElement;
    readonly hint: HTMLElement;
  }

  interface ApprovalRefs {
    readonly card: HTMLElement;
    readonly dot: HTMLElement;
    readonly title: HTMLElement;
    readonly tag: HTMLElement;
    readonly bar: HTMLElement;
    readonly actions: HTMLElement;
    readonly disclosure: HTMLButtonElement;
    readonly full: HTMLElement;
    readonly expiry: HTMLElement;
    readonly toolCallId: string;
    readonly runId: string;
  }

  interface TurnRefs {
    readonly section: HTMLElement;
    readonly marker: HTMLElement;
    readonly text: HTMLElement;
  }

  const toolRefs = new Map<string, ToolRefs>();
  const approvalRefs = new Map<string, ApprovalRefs>();
  let currentAssistant: HTMLElement | null = null;
  let currentTurn: TurnRefs | null = null;
  let state = initialState();
  /** A click already sent, so the control cannot send the same stop twice. */
  let stopRequested = false;

  /**
   * The one `.tm` a turn owns. Its text is chosen from the turn's own phase, and the phase moves
   * with the events: the model composing, a command on the Bot's computer, or a result landing.
   */
  function setTurnPhase(phase: TurnItemState): void {
    if (currentTurn === null) return;
    currentTurn.marker.dataset.phase = phase;
    currentTurn.text.textContent = TURN_ITEM_TEXT[phase];
  }

  function lineCount(text: string): number {
    if (text === "") return 0;
    return text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
  }

  /**
   * A tool card's visible state. `data-status` carries the precise wire state for the harness; the
   * tag carries the export's three words plus the two this app adds for a refusal and a failure.
   */
  function setToolState(
    refs: ToolRefs,
    exact: ToolItemState | "awaiting approval",
    output = "",
  ): void {
    refs.card.dataset.status = exact;
    refs.tag.textContent = exact === "running" || exact === "awaiting approval" ? "pending" : exact;
    refs.dot.className =
      exact === "done"
        ? "dot on"
        : exact === "running" || exact === "awaiting approval"
          ? "pulse"
          : "dot ring";
    if (exact === "done" || exact === "failed") {
      refs.details.hidden = false;
      refs.details.open = true;
      refs.summary.textContent = `Output · ${lineCount(output)} ${lineCount(output) === 1 ? "line" : "lines"}`;
      refs.output.textContent = output;
      refs.hint.hidden = true;
    } else if (exact === "denied") {
      refs.details.hidden = true;
      refs.hint.hidden = false;
      refs.hint.textContent = "Nothing ran. This call was denied.";
    } else if (exact === "running") {
      refs.hint.hidden = true;
    } else {
      refs.hint.hidden = false;
      refs.hint.textContent = "Runs as soon as the gate below is answered.";
    }
    if (exact !== "running" && exact !== "awaiting approval") refs.card.dataset.finished = exact;
    refs.card.classList.toggle("finished", exact !== "running" && exact !== "awaiting approval");
  }

  function setApprovalResolved(
    refs: ApprovalRefs,
    next: ApprovalItemState,
    word: string,
    hint: string,
    expiry: string,
  ): void {
    refs.card.dataset.state = next;
    refs.card.dataset.decision =
      next === "allowed" ? "allow" : next === "denied" ? "deny" : "expired";
    refs.title.textContent =
      next === "allowed" ? "Allowed once" : next === "denied" ? "Denied" : "Expired";
    refs.tag.textContent = next;
    refs.dot.className = next === "allowed" ? "dot on" : "dot ring";
    refs.bar.style.width = "100%";
    refs.bar.classList.add("done");
    if (next === "allowed") refs.bar.classList.remove("done");
    refs.expiry.textContent = expiry;
    const result = el("span", "approval-result", word);
    const line = el("p", "hint");
    line.append(result, document.createTextNode(` ${hint}`));
    refs.actions.replaceChildren(line);
    refs.card.classList.remove("lift");
    for (const button of refs.actions.querySelectorAll("button")) button.disabled = true;
    refs.full.hidden = true;
    refs.disclosure.setAttribute("aria-expanded", "false");
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
   * run's word instead of a person's. Only the ending run's cards close: one thread can hold two
   * runs, and a card belonging to the other one is still a request somebody can answer. A replayed
   * transcript can hold a card whose run the process never came back to (a restart, a stop) and its
   * request is nobody's to approve now: leaving the buttons live would invite a click that reaches
   * no parked call.
   */
  function closeWaitingCards(end: "cancelled" | "failed", runId: string): void {
    for (const refs of approvalRefs.values()) {
      if (refs.runId !== runId) continue;
      if (refs.card.dataset.state !== "pending") continue;
      setApprovalResolved(
        refs,
        "expired",
        end === "cancelled" ? "run stopped" : "expired",
        end === "cancelled"
          ? "The run stopped before this was answered."
          : "Nobody answered within the window, so it did not run.",
        end === "cancelled" ? "the run stopped" : "run ended unanswered",
      );
      const governed = toolRefs.get(refs.toolCallId);
      if (governed !== undefined && governed.card.dataset.status !== "done") {
        governed.hint.hidden = false;
        governed.details.hidden = true;
        governed.hint.textContent = "The run ended before this call was answered.";
      }
    }
  }

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

  function renderMessage(message: Message): void {
    if (idleNote !== null) idleNote.hidden = true;
    switch (message.type) {
      case "run.started": {
        currentAssistant = null;
        currentTurn = null;
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
        const marker = el("div", "tm");
        marker.dataset.phase = "thinking";
        const text = el("span", "txt", TURN_ITEM_TEXT.thinking);
        marker.append(el("span", "pulse"), text);
        section.append(marker);
        currentAssistant = el("div", "assistant");
        section.append(currentAssistant);
        threadEl.append(section);
        currentTurn = { section, marker, text };
        break;
      }
      case "message.text.delta": {
        const span = el("span", "frame delta", message.payload.text);
        span.dataset.seq = String(message.seq);
        (currentAssistant ?? threadEl).append(span);
        setTurnPhase("thinking");
        break;
      }
      case "tool_call.requested": {
        const card = el("article", "frame tcard tool-card");
        card.dataset.seq = String(message.seq);
        card.dataset.toolCall = message.payload.toolCallId;
        card.dataset.status = message.payload.destructive ? "awaiting approval" : "running";
        const head = el("div", "tcard-head");
        const dot = el("span", "pulse");
        const tag = el("span", "tag status", "pending");
        head.append(dot, el("span", "ttl grow", "Tool call"), tag);
        const body = el("div", "tcard-body stack");
        const codeblock = el("div", "codeblock");
        codeblock.append(el("span", "cmd", message.payload.command));
        const copy = el("button", "iconbtn cb-copy", "Copy") as HTMLButtonElement;
        copy.type = "button";
        copy.setAttribute("aria-label", "Copy the command");
        copy.addEventListener("click", () => {
          const clipboard = navigator.clipboard;
          if (clipboard === undefined) return;
          void clipboard
            .writeText(message.payload.command)
            .then(() => {
              copy.textContent = "Copied";
              copy.dataset.copied = "true";
            })
            .catch(() => undefined);
        });
        codeblock.append(copy);
        const details = el("details", "output-details") as HTMLDetailsElement;
        details.hidden = true;
        details.open = false;
        const summary = el("summary", "disc", "Output · 0 lines");
        const output = el("pre", "output terminal");
        details.append(summary, output);
        const hint = el("span", "hint");
        hint.hidden = !message.payload.destructive;
        hint.textContent = message.payload.destructive
          ? "Runs as soon as the gate below is answered."
          : "";
        body.append(codeblock, details, hint);
        card.append(head, body);
        threadEl.append(card);
        toolRefs.set(message.payload.toolCallId, {
          card,
          dot,
          tag,
          details,
          summary,
          output,
          hint,
        });
        setTurnPhase("working");
        break;
      }
      case "tool_call.decision": {
        // The card is the only place a decision appears. An allow leaves the card running; a deny
        // closes it before the result frame arrives, so the refusal is never a separate line.
        const refs = toolRefs.get(message.payload.toolCallId);
        if (refs !== undefined) setToolState(refs, message.payload.allow ? "running" : "denied");
        break;
      }
      case "tool_call.result": {
        const refs = toolRefs.get(message.payload.toolCallId);
        if (refs !== undefined) {
          setToolState(refs, toolItemState(message.payload), message.payload.output);
        }
        setTurnPhase("waiting");
        break;
      }
      case "approval.requested": {
        const payload = message.payload;
        const card = el("article", "frame tcard gate approval-card");
        card.dataset.seq = String(message.seq);
        card.dataset.approval = payload.approvalId;
        card.dataset.state = "pending";
        const head = el("div", "tcard-head gate-head");
        const dot = el("span", "pulse");
        const title = el("span", "ttl grow", "Approval needed");
        const tag = el("span", "tag", "pending");
        head.append(dot, title, tag);
        const bar = el("div", "gate-bar");
        const now = Date.now();
        const windowMs = Math.max(1, payload.expiresAt - message.ts);
        const remaining = Math.max(0, payload.expiresAt - now);
        bar.style.width = `${Math.min(100, (remaining / windowMs) * 100)}%`;
        const body = el("div", "tcard-body gate-body stack approval-body");
        const proposal = el(
          "p",
          "proposal",
          "A shell command that runs on this Bot's computer and can change its workspace.",
        );
        const disclosure = document.createElement("button") as HTMLButtonElement;
        disclosure.type = "button";
        disclosure.className = "disc";
        disclosure.setAttribute("aria-expanded", "false");
        const chev = el("span", "chev", "›");
        disclosure.append(chev, document.createTextNode("View the full request"));
        const full = el("div", "codeblock");
        full.hidden = true;
        full.append(el("span", "cmd", payload.command));
        disclosure.addEventListener("click", () => {
          const open = disclosure.getAttribute("aria-expanded") === "true";
          disclosure.setAttribute("aria-expanded", String(!open));
          full.hidden = open;
        });
        const scope = el("div", "row-between");
        const scopeText = el("span", "hint", "Scope · this Bot's workspace · this command only");
        const expiry = el(
          "span",
          "mono fs-meta muted",
          `expires in ${Math.max(0, Math.round(remaining / 1000))}s`,
        );
        scope.append(scopeText, expiry);
        const actions = el("div", "row approval-actions");
        const allow = el(
          "button",
          "btn btn-primary btn-sm allow-once",
          "Allow once",
        ) as HTMLButtonElement;
        allow.type = "button";
        const deny = el("button", "btn btn-secondary btn-sm deny", "Deny") as HTMLButtonElement;
        deny.type = "button";
        allow.addEventListener("click", () => sendAnswer("allow", payload.approvalId));
        deny.addEventListener("click", () => sendAnswer("deny", payload.approvalId));
        actions.append(allow, deny);
        body.append(proposal, disclosure, full, scope, actions);
        card.append(head, bar, body);
        threadEl.append(card);
        approvalRefs.set(payload.approvalId, {
          card,
          dot,
          title,
          tag,
          bar,
          actions,
          disclosure,
          full,
          expiry,
          toolCallId: payload.toolCallId,
          runId: message.runId,
        });
        setTurnPhase("working");
        if (config.autoAnswer === "allow" || config.autoAnswer === "deny") {
          const answer = config.autoAnswer;
          setTimeout(() => sendAnswer(answer, payload.approvalId), 600);
        }
        break;
      }
      case "approval.resolved": {
        const refs = approvalRefs.get(message.payload.approvalId);
        const decision = message.payload.decision;
        if (refs !== undefined) {
          const state = approvalItemState({ decision });
          setApprovalResolved(
            refs,
            state,
            decision === "allow" ? "allowed once" : "denied",
            decision === "allow"
              ? "The grant is bound to this exact command; a changed command asks again."
              : "Nothing ran. The run continued to its end.",
            `decided by you · ${new Date().toTimeString().slice(0, 5)}`,
          );
          const governed = toolRefs.get(refs.toolCallId);
          if (governed !== undefined) {
            setToolState(governed, decision === "allow" ? "running" : "denied");
          }
        }
        setTurnPhase(decision === "allow" ? "working" : "waiting");
        break;
      }
      case "grant.lifecycle": {
        // The grant is part of the approval card's own story; it is not a line of its own.
        break;
      }
      case "turn.ended": {
        // The turn marker stays at its last phase; the next turn starts its own marker.
        break;
      }
      case "run.status": {
        // The run's own transition is shown by the cards and the Bot row, never by a marker line.
        if (message.payload.status === "awaiting_approval") setTurnPhase("working");
        else if (message.payload.status === "running") {
          const active = [...toolRefs.values()].some(
            (refs) =>
              refs.card.dataset.status === "running" ||
              refs.card.dataset.status === "awaiting approval",
          );
          setTurnPhase(active ? "working" : "thinking");
        } else if (message.payload.status === "cancelled") {
          closeWaitingCards("cancelled", message.runId);
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
        // A failed run never reads its parked approval, so the card it left behind expires.
        closeWaitingCards("failed", message.runId);
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
    const toolCards = [...threadEl.querySelectorAll<HTMLElement>(".tool-card")];
    const approvalCards = [...threadEl.querySelectorAll<HTMLElement>(".approval-card")];
    const turnMarkers = [...threadEl.querySelectorAll<HTMLElement>(".tm")];
    const renderedSeqs = [...threadEl.querySelectorAll<HTMLElement>(".frame[data-seq]")].map(
      (node) => Number(node.dataset.seq ?? "0"),
    );
    const seen = new Set<number>();
    const duplicateSeqs: number[] = [];
    for (const seq of renderedSeqs) {
      if (seen.has(seq)) duplicateSeqs.push(seq);
      else seen.add(seq);
    }
    return {
      lastSeq: Number(lastSeqEl.dataset.lastSeq ?? "0"),
      done: threadEl.querySelector(".run-finished") !== null,
      frameCount: renderedSeqs.length,
      turns: threadEl.querySelectorAll(".turn").length,
      cards: toolCards.map((card) => [card.dataset.toolCall ?? "", card.dataset.status ?? ""]),
      outputShown: toolCards.map(
        (card) => card.querySelector<HTMLElement>(".output-details")?.hidden === false,
      ),
      approvals: approvalCards.map((card) => card.dataset.decision ?? null),
      deltas: [...threadEl.querySelectorAll<HTMLElement>(".delta")].map(
        (node) => node.textContent ?? "",
      ),
      approvalStates: approvalCards.map(
        (card) => (card.dataset.state ?? "pending") as ApprovalItemState,
      ),
      toolStates: toolCards.map((card) => {
        const status = card.dataset.status ?? "running";
        if (status === "done" || status === "denied" || status === "failed") return status;
        return "running";
      }),
      turnPhases: turnMarkers.map(
        (marker) => (marker.dataset.phase ?? "thinking") as TurnItemState,
      ),
      turnTexts: turnMarkers.map(
        (marker) => marker.querySelector<HTMLElement>(".txt")?.textContent ?? "",
      ),
      renderedSeqs,
      duplicateSeqs,
      removedMarkers: {
        turnTitle: threadEl.querySelectorAll(".turn-title").length,
        turnEnd: threadEl.querySelectorAll(".turn-end").length,
        toolDecision: threadEl.querySelectorAll(".tool-decision").length,
        toolResult: threadEl.querySelectorAll(".tool-result").length,
        approvalResolved: threadEl.querySelectorAll(".approval-resolved").length,
        runStatus: threadEl.querySelectorAll(".run-status").length,
        grantLifecycle: threadEl.querySelectorAll(".grant-lifecycle").length,
      },
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
      currentTurn = null;
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
