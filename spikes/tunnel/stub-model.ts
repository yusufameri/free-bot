/**
 * Keyless OpenAI-compatible stub for the tunnel spike, shaped after spikes/pi-rpc/stub-model.ts.
 *
 * It scripts a four-turn exchange: three `spike_echo` tool calls, each preceded by a paced burst
 * of text deltas, then a closing answer. The pacing is what gives the harness a wide, reliably
 * mid-stream window to kill the tunnel in.
 */

export interface StubModel {
  port: number;
  requests: number;
  stop(): void;
}
const DELTAS = [6, 40, 12, 8];
const NOTES = ["one", "two", "three"];

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "",
      )
      .join(" ");
  }
  return "";
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-tunnel-spike",
    object: "chat.completion.chunk",
    created: 0,
    model: "stub-1",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function sse(payloads: Planned[], deltaDelayMs: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(chunk(payload.delta, payload.finishReason)));
        if (deltaDelayMs > 0) await Bun.sleep(deltaDelayMs);
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

interface Planned {
  delta: Record<string, unknown>;
  finishReason: string | null;
}

/** Turn n streams its deltas, then either calls a tool (turns 0-2) or closes the exchange. */
function planTurn(turn: number, requestNumber: number): Planned[] {
  const planned: Planned[] = [{ delta: { role: "assistant", content: "" }, finishReason: null }];
  for (let index = 0; index < (DELTAS[turn] ?? 6); index += 1) {
    planned.push({ delta: { content: `turn-${turn + 1}-chunk-${index} ` }, finishReason: null });
  }
  if (turn < NOTES.length) {
    const note = NOTES[turn] ?? "one";
    const args = JSON.stringify({ note, delay_ms: 200 });
    planned.push({
      delta: {
        content: null,
        tool_calls: [
          {
            index: 0,
            id: `call_spike_${requestNumber}`,
            type: "function",
            function: { name: "spike_echo", arguments: "" },
          },
        ],
      },
      finishReason: null,
    });
    planned.push({
      delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
      finishReason: null,
    });
    planned.push({ delta: {}, finishReason: "tool_calls" });
    return planned;
  }
  planned.push({ delta: { content: "spike exchange complete." }, finishReason: null });
  planned.push({ delta: {}, finishReason: "stop" });
  return planned;
}

export function startStubModel(record: (note: Record<string, unknown>) => void): StubModel {
  let requests = 0;
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as {
        messages?: Array<Record<string, unknown>>;
      };
      requests += 1;
      const messages = body.messages ?? [];
      const toolResults = messages.filter((message) => message.role === "tool");
      const turn = Math.min(toolResults.length, 3);
      record({
        type: "unknown_frame",
        raw: {
          type: "stub_request",
          n: requests,
          turn,
          toolResults: toolResults.map((message) => contentText(message.content)),
        },
      });
      return sse(planTurn(turn, requests), 15);
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
