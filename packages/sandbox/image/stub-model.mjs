/**
 * Keyless OpenAI-compatible replay stub, adapted for node from `spikes/pi-rpc/stub-model.ts`.
 *
 * The spike copy runs under bun's `Bun.serve`; the sandbox image ships node and nothing else, so
 * this copy uses `node:http`. Behavior is the spike's, trimmed to the one scripted turn this unit
 * replays: the first request of a turn asks for `replay_echo`, any request carrying a tool result
 * answers with text that echoes it. No credentials are involved.
 */
import { createServer } from "node:http";

export function contentText(content) {
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

export function planReply(body) {
  const messages = body.messages ?? [];
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  const lastTool = [...messages.slice(lastUserIndex + 1)]
    .reverse()
    .find((message) => message.role === "tool");
  if (lastTool) {
    return {
      kind: "text",
      text: `stub-model saw tool result: ${contentText(lastTool.content).slice(0, 300)}`,
    };
  }
  const userText = contentText(messages[lastUserIndex]?.content);
  if (userText.includes("replay_echo")) {
    return { kind: "tool", name: "replay_echo", args: '{"text":"hello-from-stub"}' };
  }
  return { kind: "text", text: "stub-model: prompt did not name replay_echo" };
}

function chunk(delta, finishReason) {
  return JSON.stringify({
    id: "chatcmpl-replay-stub",
    object: "chat.completion.chunk",
    created: 0,
    model: "stub-1",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function sseBody(payloads) {
  return `${payloads.map((payload) => `data: ${payload}\n\n`).join("")}data: [DONE]\n\n`;
}

export function startStubModel(port, record) {
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !String(request.url).endsWith("/chat/completions")) {
      response.writeHead(404).end("not found");
      return;
    }
    let raw = "";
    for await (const piece of request) raw += piece.toString();
    const body = JSON.parse(raw);
    requestCount += 1;
    const reply = planReply(body);
    record({
      dir: "stub",
      kind: "request",
      n: requestCount,
      model: body.model,
      tools: (body.tools ?? []).map((tool) => tool.function?.name),
      roles: (body.messages ?? []).map((message) => message.role),
      toolResults: (body.messages ?? [])
        .filter((message) => message.role === "tool")
        .map((message) => contentText(message.content).slice(0, 300)),
    });
    record({ dir: "stub", kind: "reply", n: requestCount, ...reply });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (reply.kind === "text") {
      response.end(
        sseBody([
          chunk({ role: "assistant", content: "" }, null),
          chunk({ content: reply.text }, null),
          chunk({}, "stop"),
        ]),
      );
      return;
    }
    const name = reply.name ?? "";
    const args = reply.args ?? "{}";
    const call = {
      index: 0,
      id: `call_stub_${requestCount}`,
      type: "function",
      function: { name, arguments: args },
    };
    response.end(
      sseBody([
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
      ]),
    );
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        stop: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
