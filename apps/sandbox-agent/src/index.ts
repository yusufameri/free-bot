/**
 * Reusable pieces of the sandbox agent. The entry points are `supervisor.ts` (owns Pi) and
 * `agent.ts` (forwards frames over the tunnel); importing this module starts neither.
 */

export * from "./link.ts";
export * from "./outbox.ts";
