/**
 * Keyless OpenAI-compatible stub for the Pi RPC spike.
 *
 * Speaks just enough of `POST /v1/chat/completions` (SSE, stream: true) for Pi's
 * `openai-completions` provider API: it answers the first request of a turn with a tool call
 * chosen from the user text, and any follow-up request that carries a tool result with a text
 * reply that echoes what the tool result said. No credentials are involved; this is the same
 * replay-stub shape the plan reserves for CI (finding 13).
 */

export type Frame = Record<string, unknown>;

export interface StubReply {
  kind: "tool" | "text";
  name?: string;
  args?: string;
  text?: string;
}

export interface StubModel {
  port: number;
  replies: StubReply[];
  stop(): void;
}

function plan(body: { messages?: Array<Record<string, unknown>> }): StubReply {
  const messages = body.messages ?? [];
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  const lastUser = messages[lastUserIndex];
  const userText = contentText(lastUser?.content);
  const lastTool = [...messages.slice(lastUserIndex + 1)]
    .reverse()
    .find((message) => message.role === "tool");
  if (lastTool) {
    const seen = contentText(lastTool.content);
    return { kind: "text", text: `stub-model saw tool result: ${seen.slice(0, 300)}` };
  }
  if (userText.includes("gated_blocked")) {
    return { kind: "tool", name: "gated_blocked", args: "{}" };
  }
  if (userText.includes("gated_confirm_deny")) {
    return { kind: "tool", name: "gated_confirm", args: '{"mode":"deny"}' };
  }
  if (userText.includes("gated_confirm_allow")) {
    return { kind: "tool", name: "gated_confirm", args: '{"mode":"allow"}' };
  }
  if (userText.includes("gate_demo_runner")) {
    return { kind: "tool", name: "gate_demo_runner", args: "{}" };
  }
  if (userText.includes("native bash")) {
    return { kind: "tool", name: "bash", args: '{"command":"echo native-should-not-run"}' };
  }
  return { kind: "tool", name: "gated_echo", args: '{"text":"hello-from-stub"}' };
}

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
  return JSON.stringify({
    id: "chatcmpl-spike",
    object: "chat.completion.chunk",
    created: 0,
    model: "stub-1",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function sse(...payloads: string[]): Response {
  const events = payloads.map((payload) => `data: ${payload}\n\n`).concat("data: [DONE]\n\n");
  return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
}

export function startStubModel(record: (frame: Frame) => void): StubModel {
  const replies: StubReply[] = [];
  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as {
        model?: string;
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<Record<string, unknown>>;
      };
      requestCount += 1;
      const reply = plan(body);
      replies.push(reply);
      const toolResults = (body.messages ?? [])
        .filter((message) => message.role === "tool")
        .map((message) => contentText(message.content).slice(0, 300));
      record({
        dir: "stub",
        kind: "request",
        n: requestCount,
        model: body.model,
        tools: (body.tools ?? []).map((tool) => tool.function?.name),
        roles: (body.messages ?? []).map((message) => message.role),
        toolResults,
      });
      record({ dir: "stub", kind: "reply", n: requestCount, ...reply });

      if (reply.kind === "text") {
        return sse(
          chunk({ role: "assistant", content: "" }, null),
          chunk({ content: reply.text ?? "" }, null),
          chunk({}, "stop"),
        );
      }
      const call = {
        index: 0,
        id: `call_stub_${requestCount}`,
        type: "function",
        function: { name: reply.name, arguments: reply.args ?? "{}" },
      };
      const [name, args] = [reply.name ?? "", reply.args ?? "{}"];
      return sse(
        chunk(
          {
            role: "assistant",
            content: null,
            tool_calls: [{ ...call, function: { name, arguments: "" } }],
          },
          null,
        ),
        chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }, null),
        chunk({}, "tool_calls"),
      );
    },
  });
  return {
    port: server.port ?? 0,
    replies,
    stop: () => server.stop(true),
  };
}
