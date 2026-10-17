// Host-side origin for the browser-containment spike: the page the container
// browser is supposed to reach through the proxy. Plain HTTP on 127.0.0.1, so
// the proxy's own dial (127.0.0.1) needs no DNS; the browser names it as
// localhost and Chromium is told to proxy loopback too, because Chromium
// implicitly bypasses localhost otherwise.
//
// Usage: ORIGIN_PORT=9109 bun spikes/browser-containment/origin.ts
import { serve } from "bun";

const port = Number(process.env.ORIGIN_PORT ?? 9109);

serve({
  port,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/host-origin") {
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><title>FREEBOT HOST ORIGIN</title>
<style>body{background:#0b2b1a;color:#d3f9d8;font:18px/1.6 "DejaVu Sans Mono",monospace;margin:40px}
h1{font-size:26px}</style></head><body>
<h1>FREEBOT-HOST-ORIGIN-OK</h1>
<p>this page was served by origin.ts on the host at 127.0.0.1:${port}</p>
<p>and fetched by Chromium through the egress proxy. ${new Date().toISOString()}</p>
</body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`origin listening on 127.0.0.1:${port}`);
