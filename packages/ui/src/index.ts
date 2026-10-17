/** The shared UI core (plan 2.7): the thread model, its display strings, and the frame contract. */
export * from "./bots.ts";
export * from "./frames.ts";
export * from "./thread.ts";

/** Surface that hosts the shared TypeScript UI core. */
export type SurfaceId = "web" | "desktop" | "mobile";
