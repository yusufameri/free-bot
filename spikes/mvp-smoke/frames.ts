/**
 * Committed-frame distinctness for the MVP smoke dry run (U0.11).
 *
 * Every frame the harness commits records the page facts it captured. Distinct PNG bytes are not
 * evidence: the bytes vary run to run (timestamped filenames, antialiasing, a taller scrollbar),
 * so `06-denied` and `07-done` once shipped as two different files that showed the same page —
 * the denial capture lost its race with the terminal frames, and the artifact claimed a moment no
 * frame documented. This module is the guard. Distinctness is checked pairwise over the recorded
 * facts, so a re-capture that collapses two frames into one state fails the run instead of
 * landing silently.
 */

/** What the user could see in a frame, read from the live page at capture time. */
export interface FrameFacts {
  lastSeq: number;
  done: boolean;
  frameCount: number;
  turns: number;
  cards: Array<[string, string]>;
  approvals: Array<string | null>;
  deltas: string[];
  resume: number | null;
  streamEnd: string | null;
}

export interface Capture {
  name: string;
  file: string;
  bytes: number;
  sha256: string;
  facts: FrameFacts;
}

/** The facts as one comparable key. The frame's name is not part of the page's state. */
export function factsKey(facts: FrameFacts): string {
  return JSON.stringify(facts);
}

/** Every pair of captures that recorded the same page state, as `06-denied/07-done`. */
export function collapsedPairs(captures: Capture[]): string[] {
  const pairs: string[] = [];
  for (let index = 0; index < captures.length; index += 1) {
    for (let other = index + 1; other < captures.length; other += 1) {
      const left = captures[index];
      const right = captures[other];
      if (left === undefined || right === undefined) continue;
      if (factsKey(left.facts) === factsKey(right.facts)) {
        pairs.push(`${left.name}/${right.name}`);
      }
    }
  }
  return pairs;
}

/** One readable line for the artifact, so a reader can see what each frame documented. */
export function describeFacts(facts: FrameFacts): string {
  const cards = facts.cards.map(([call, status]) => `${call}:${status}`).join(" ");
  const approvals = facts.approvals.map((decision) => decision ?? "pending").join(",");
  return [
    `last seq ${facts.lastSeq}`,
    `done ${facts.done}`,
    `turns ${facts.turns}`,
    `cards [${cards}]`,
    `approvals [${approvals}]`,
    `resume ${facts.resume ?? "-"}`,
    `stream end ${facts.streamEnd ?? "-"}`,
    `text "${facts.deltas.at(-1) ?? ""}"`,
  ].join(" · ");
}
