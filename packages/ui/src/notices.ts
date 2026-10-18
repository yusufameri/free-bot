/**
 * Notices and the reconnect banner: the two lines the app shows above the transcript, and what
 * raises them.
 *
 * Both are bound to signals the app really has. The banner follows the page's own socket state, so
 * it appears when the stream drops and clears when the socket answers again. A notice comes from a
 * record: the provider connection's last test outcome, which `status` and `refusal` carry, and a run
 * the thread's own store reports as failed. There is no notice for a condition the app cannot
 * observe, and the stack is not on the page when nothing raises one.
 *
 * `packages/ui/browser/notices.ts` renders this and decides nothing. The copy lives here so the page
 * and the evidence read the same words, and the two provider lines are the ones page 1 already
 * states (`packages/ui/src/provider.ts`), so the same outcome never reads two ways.
 */

import type { ProviderConnection, RunSummary } from "@freebot/protocol";
import { providerHeadline, refusalLine } from "./provider.ts";

/** The export's banner copy (`freebot-prototype.html:1044`), kept verbatim. */
export const BANNER_TEXT =
  "Reconnecting — the stream dropped. The transcript refills from the last event it held.";

/**
 * The four stream states the page shows. They live here because the banner is what reads them and
 * the pane only reports them; `packages/ui/browser/render.ts` writes the same four onto `#conn`.
 */
export const STREAM_CONNECTIONS = ["connecting", "connected", "reconnecting", "error"] as const;

export type StreamConnection = (typeof STREAM_CONNECTIONS)[number];

/**
 * The banner's own rule: the page says the stream dropped when it did, and keeps saying it while it
 * is trying again — a retry sets the connection to `connecting`, which is not the same as an open
 * socket — until one answers. A page that has never dropped anything shows nothing.
 */
export function bannerAfter(previous: boolean, connection: StreamConnection): boolean {
  if (connection === "connected") return false;
  if (connection === "reconnecting" || connection === "error") return true;
  return previous;
}

export const NOTICE_DISMISS_LABEL = "Dismiss";
export const NOTICE_DISMISS_ALL = "Dismiss all";
export const NOTICE_OPEN_LABEL = "Open";

/** Where the page remembers which notices were dismissed, so a reload keeps them dismissed. */
export const NOTICE_DISMISSED_KEY = "freebot.notices.dismissed";

/** What a notice's one action does. A failed run has none: the app holds no request id for it. */
export type NoticeAction = "open-provider";

export interface Notice {
  /** Stable across reloads, so a dismissal lands on the same notice after a reload. */
  readonly id: string;
  readonly text: string;
  readonly action: NoticeAction | null;
}

/**
 * The provider notice's line. The stack is one line per notice like the export's, so this is the
 * provider page's own headline (`packages/ui/src/provider.ts`), plus the refusal's sentence when the
 * last test was refused. `Open` leads to the page that carries the paragraph behind the headline.
 */
export function providerNoticeText(connection: ProviderConnection): string {
  const headline = providerHeadline(connection.status);
  return connection.refusal === null ? headline : `${headline} ${refusalLine(connection.refusal)}`;
}

/**
 * The notices the records raise, in the order they are stacked. The provider's outcome comes first
 * because it is the one that changes what a run does; a failed run is the thread's own news.
 */
export function noticesFrom(input: {
  readonly connection: ProviderConnection | null;
  readonly latest: RunSummary | null;
}): Notice[] {
  const notices: Notice[] = [];
  const connection = input.connection;
  if (connection !== null && connection.status !== "capable") {
    notices.push({
      id: `provider-${connection.status}`,
      text: providerNoticeText(connection),
      action: "open-provider",
    });
  }
  if (input.latest !== null && input.latest.status === "failed") {
    notices.push({
      id: `run-failed-${input.latest.runId}`,
      text: `Run ${input.latest.runId} failed.`,
      action: null,
    });
  }
  return notices;
}

/** The notices on screen, which are the ones nobody has dismissed. */
export function undismissed(notices: readonly Notice[], dismissed: readonly string[]): Notice[] {
  return notices.filter((notice) => !dismissed.includes(notice.id));
}

/** What a page stored as its dismissals, refusing anything a page would not have written. */
export function readDismissed(raw: string | null): string[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

/** What the banner and the stack show, in the shape the evidence reads. */
export interface NoticeFacts {
  /** The connection the banner is bound to, so the evidence can name what raised it. */
  readonly connection: StreamConnection;
  readonly banner: { readonly shown: boolean; readonly text: string };
  readonly notices: Array<{
    readonly id: string;
    readonly text: string;
    readonly actions: string[];
  }>;
  readonly dismissed: string[];
}
