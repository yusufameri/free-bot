/**
 * The Connect apps driver's pure guards, so the proof that the artifact carries no credential and
 * that a capture is stable can be tested without a browser or a launch.
 *
 * The driver names every secret by a label, never by a value. These functions read the values to
 * search for them, and answer with labels and reasons, so a failure line cannot carry a secret out
 * of the run it was minted in.
 */

export type Secret = readonly [label: string, value: string];

/** The labels of the secrets whose value appears literally in `text`. */
export function secretsIn(text: string, secrets: readonly Secret[]): string[] {
  return secrets
    .filter(([, value]) => value !== "" && text.includes(value))
    .map(([label]) => label);
}

/** A key-shaped literal no artifact may carry, whatever the run minted. */
const KEY_SHAPED = /FREEBOT_BYOK_KEY=\S{8,}/;

/**
 * Why this artifact text must not be written, or null when it is clean. The operator token and every
 * credential of the run are refused by name, and a key-shaped literal is refused even when the run
 * did not mint the key it names.
 */
export function artifactRefusal(
  text: string,
  secrets: readonly Secret[],
  operatorToken: string,
): string | null {
  if (operatorToken !== "" && text.includes(operatorToken)) {
    return "the artifact carries the operator token";
  }
  const found = secretsIn(text, secrets);
  if (found.length > 0) {
    return `the artifact carries a credential named ${found.join(", ")}`;
  }
  if (KEY_SHAPED.test(text)) {
    return "the artifact carries a key-shaped literal";
  }
  return null;
}

/** Whether a capture's facts moved between the read before the shot and the read after it. */
export function factsEqual(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

/** The reasons a capture is refused, one line each, so the driver can log all of them. */
export function captureRefusals(
  before: unknown,
  after: unknown,
  caption: string,
  secrets: readonly Secret[],
): string[] {
  const refusals: string[] = [];
  if (!factsEqual(before, after)) refusals.push(`${caption}: the facts moved during the capture`);
  const found = secretsIn(JSON.stringify(before), secrets);
  if (found.length > 0) refusals.push(`${caption}: its facts carry ${found.join(", ")}`);
  return refusals;
}
