/**
 * Keyless scripted OpenAI-compatible stub for forge test A, shaped after spikes/tunnel/stub-model.ts.
 *
 * It has no model and no key: the harness queues one plan per turn over `POST /plan`, and the stub
 * streams that plan as SSE deltas when Pi asks for the next completion. If no plan is queued, it
 * waits, which parks Pi mid-turn rather than inventing a decision. The artifact says plainly that
 * every model decision here is this script, not a provider.
 */

export interface StubPlan {
  kind: "tool" | "stop";
  toolName?: string;
  args?: unknown;
  callId?: string;
}

export interface StubModel {
  port: number;
  requests: number;
  stop(): void;
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-forge-a",
    object: "chat.completion.chunk",
    created: 0,
    model: "stub-1",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function sse(
  payloads: Array<{ delta: Record<string, unknown>; finishReason: string | null }>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(chunk(payload.delta, payload.finishReason)));
        await Bun.sleep(15);
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

export function startStubModel(): StubModel {
  let requests = 0;
  const queue: StubPlan[] = [];
  let waiter: (() => void) | null = null;

  async function nextPlan(): Promise<StubPlan> {
    const deadline = Date.now() + 60_000;
    while (queue.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        waiter = resolve;
        setTimeout(resolve, 250);
      });
    }
    waiter = null;
    return queue.shift() ?? { kind: "stop" };
  }

  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/plan") {
        const body = (await request.json()) as { plan: StubPlan };
        queue.push(body.plan);
        waiter?.();
        return Response.json({ queued: queue.length });
      }
      if (request.method === "GET" && url.pathname === "/requests") {
        return Response.json({ requests });
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      requests += 1;
      const plan = await nextPlan();
      if (plan.kind === "tool") {
        const args = JSON.stringify(plan.args ?? {});
        return sse([
          { delta: { role: "assistant", content: "" }, finishReason: null },
          { delta: { content: "calling " }, finishReason: null },
          { delta: { content: `${plan.toolName} ` }, finishReason: null },
          {
            delta: {
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: plan.callId ?? "call_unknown",
                  type: "function",
                  function: { name: plan.toolName ?? "", arguments: "" },
                },
              ],
            },
            finishReason: null,
          },
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
            finishReason: null,
          },
          { delta: {}, finishReason: "tool_calls" },
        ]);
      }
      return sse([
        { delta: { role: "assistant", content: "" }, finishReason: null },
        { delta: { content: "script complete." }, finishReason: null },
        { delta: {}, finishReason: "stop" },
      ]);
    },
  });
  return {
    port: server.port ?? 0,
    get requests() {
      return requests;
    },
    stop: () => server.stop(true),
  };
}
