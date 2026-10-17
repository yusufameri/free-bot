export * from "./grants.ts";
export * from "./policy.ts";
export * from "./store.ts";

/** Outcome of one policy decision on a proposed action. */
export type ReviewVerdict = "allow" | "block";
