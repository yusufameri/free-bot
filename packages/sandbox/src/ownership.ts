/**
 * The order-22 ownership labels, in one place. Every backend writes these three on every sandbox it
 * creates and the conformance suite reads them back through its ownership port, so the contract
 * lives here rather than once per adapter. `docs/sandbox-provider.md` carries the per-provider
 * semantics and `docs/sandbox-conformance.md` the sweep the labels scope.
 */

export const SANDBOX_LABEL = "freebot.sandbox";
export const UNIT_LABEL = "freebot.unit";
export const PROVIDER_LABEL = "freebot.provider";
