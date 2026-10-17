import { Hono } from "hono";

/** Control-plane HTTP handler; oRPC routes land with T2 and this stays the fetch entry. */
export const app = new Hono();

app.get("/healthz", (c) => c.json({ status: "ok", service: "freebot-server" }));
