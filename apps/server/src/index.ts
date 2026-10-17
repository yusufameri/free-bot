import { app } from "./app";

export { app };

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(Bun.env.PORT ?? 0),
  fetch: app.fetch,
});

console.log(`listening on http://127.0.0.1:${server.port}`);
