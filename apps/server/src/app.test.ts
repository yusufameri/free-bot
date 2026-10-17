import { describe, expect, test } from "bun:test";
import { app } from "./app";

describe("GET /healthz", () => {
  test("returns 200 and the service identity", async () => {
    const res = await app.fetch(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "freebot-server" });
  });

  test("unknown paths are 404", async () => {
    const res = await app.fetch(new Request("http://localhost/nope"));
    expect(res.status).toBe(404);
  });
});
