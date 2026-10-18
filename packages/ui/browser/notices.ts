/**
 * The banner and the notice stack: the two lines above the transcript.
 *
 * It decides nothing. `packages/ui/src/notices.ts` owns the copy, the banner's rule, what raises a
 * notice and how a dismissal is remembered; this module turns those into nodes and reads them back
 * for the evidence harness.
 *
 * The banner's element is the export's (`freebot-prototype.html:1044`): `#banner` with a pulsing dot
 * and its one sentence. A notice is one `.notice` row with the record's words, its one action and
 * its own dismiss control, and the stack's last row is `Dismiss all` (`:1046-1051`). What a notice
 * is *about* is not this module's business: the host reads the records and pushes them.
 */

import type { ProviderConnection, RunSummary } from "@freebot/protocol";
import {
  BANNER_TEXT,
  bannerAfter,
  NOTICE_DISMISS_ALL,
  NOTICE_DISMISS_LABEL,
  NOTICE_DISMISSED_KEY,
  NOTICE_OPEN_LABEL,
  type Notice,
  type NoticeFacts,
  noticesFrom,
  readDismissed,
  type StreamConnection,
  undismissed,
} from "../src/notices.ts";
import { icon } from "./icons.ts";

export interface NoticeHandle {
  /** The page's own socket state. The banner is bound to it and to nothing else. */
  setConnection(connection: StreamConnection): void;
  /** The records a notice comes from. The stack repaints; it keeps no copy of them. */
  update(input: {
    readonly connection: ProviderConnection | null;
    readonly latest: RunSummary | null;
  }): void;
  facts(): NoticeFacts;
}

declare global {
  interface Window {
    /** Live banner and notice facts, read from the DOM, for the CDP harness. */
    __noticeFacts?: () => NoticeFacts;
  }
}

function must<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`missing element ${selector}`);
  return found;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

export function mountNotices(config: {
  /** What a notice's one action does. The only action is the way back to the provider page. */
  readonly onOpenProvider?: () => void;
}): NoticeHandle {
  const bannerEl = must<HTMLElement>("#banner");
  const stackEl = must<HTMLElement>("#notices");

  const bannerText = el("span", "grow", BANNER_TEXT);
  bannerEl.replaceChildren(el("span", "pulse"), bannerText);
  bannerEl.dataset.bannerText = BANNER_TEXT;

  let connection: StreamConnection = "connecting";
  let down = false;
  let dismissed = readDismissed(localStorage.getItem(NOTICE_DISMISSED_KEY));
  let records: { connection: ProviderConnection | null; latest: RunSummary | null } = {
    connection: null,
    latest: null,
  };

  function persist(): void {
    localStorage.setItem(NOTICE_DISMISSED_KEY, JSON.stringify(dismissed));
  }

  function paintBanner(): void {
    bannerEl.hidden = !down;
    bannerEl.dataset.shown = String(down);
  }

  function noticeNode(notice: Notice): HTMLElement {
    const row = el("div", "notice");
    row.dataset.notice = notice.id;
    row.append(el("span", "dot on"));
    row.append(el("span", "grow", notice.text));
    const act = el("span", "act");
    if (notice.action === "open-provider") {
      const open = el("button", "btn btn-secondary btn-xs", NOTICE_OPEN_LABEL);
      open.type = "button";
      open.dataset.action = notice.action;
      open.addEventListener("click", () => config.onOpenProvider?.());
      act.append(open);
    }
    const dismiss = el("button", "iconbtn");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", NOTICE_DISMISS_LABEL);
    dismiss.append(icon("x"));
    dismiss.addEventListener("click", () => {
      dismissed = [...dismissed, notice.id];
      persist();
      paintStack();
    });
    act.append(dismiss);
    row.append(act);
    return row;
  }

  function paintStack(): void {
    const shown = undismissed(noticesFrom(records), dismissed);
    const rows: Node[] = shown.map(noticeNode);
    if (rows.length > 0) {
      const all = el("div", "notice notice-all");
      const dismissAll = el("button", "btn btn-ghost btn-xs", NOTICE_DISMISS_ALL);
      dismissAll.type = "button";
      dismissAll.addEventListener("click", () => {
        dismissed = [...new Set([...dismissed, ...shown.map((notice) => notice.id)])];
        persist();
        paintStack();
      });
      all.append(dismissAll);
      rows.push(all);
    }
    stackEl.replaceChildren(...rows);
    stackEl.hidden = rows.length === 0;
    stackEl.dataset.count = String(shown.length);
  }

  return {
    setConnection(next) {
      connection = next;
      down = bannerAfter(down, next);
      paintBanner();
    },
    update(input) {
      records = input;
      paintStack();
    },
    facts() {
      return {
        connection,
        banner: {
          shown: document.querySelector("#banner")?.hasAttribute("hidden") === false,
          text: bannerText.textContent ?? "",
        },
        notices: [...stackEl.querySelectorAll<HTMLElement>(".notice[data-notice]")].map((node) => ({
          id: node.dataset.notice ?? "",
          text: node.querySelector(".grow")?.textContent ?? "",
          actions: [...node.querySelectorAll<HTMLElement>(".act button[data-action]")].map(
            (button) => button.dataset.action ?? "",
          ),
        })),
        dismissed: readDismissed(localStorage.getItem(NOTICE_DISMISSED_KEY)),
      };
    },
  };
}

/** Expose the live banner and notice facts on `window`, so a CDP driver reads the page. */
export function exposeNoticeFacts(handle: NoticeHandle): void {
  window.__noticeFacts = () => handle.facts();
}
