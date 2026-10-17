import { Hono } from "hono";
import { createRunService, runRoutes } from "./run-service.ts";

/** Control-plane HTTP handler; the oRPC wiring lands with its own pass, this stays the fetch entry. */
export const app = new Hono();

app.get("/healthz", (c) => c.json({ status: "ok", service: "freebot-server" }));

/** This process's runs, over one event log. */
export const runService = createRunService();

app.route("/", runRoutes(runService));
