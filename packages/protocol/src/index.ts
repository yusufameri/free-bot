/**
 * @freebot/protocol: the v1 shared contract.
 *
 * `envelope.ts` holds the one wire shape and the parse entry point, `events.ts` holds the kind
 * taxonomy and payload schemas, `dto.ts` holds the oRPC shapes. The schemas are the single source
 * of truth; every exported type is a `z.infer` of one of them.
 *
 * The package defines what travels. It does not enforce ordering: packages/core's `SeqLog` owns
 * ingest, refusal, dedupe, and the audit, and nothing here weakens those rules.
 */

export * from "./dto.ts";
export * from "./envelope.ts";
export * from "./events.ts";
