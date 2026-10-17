import { Hono } from "hono";

/** Control-plane HTTP handler; the oRPC wiring lands with its own pass, this stays the fetch entry. */
export const app = new Hono();

app.get("/healthz", (c) => c.json({ status: "ok", service: "freebot-server" }));
