/**
 * The transport seam. `spawnPiTransport` drives a real Pi process; `createReplayTransport`
 * plays back the committed transcript so tests run deterministic and modelless.
 */

import { PiProtocolError, PiTransportError } from "./errors.ts";
import { type PiCommand, type PiInboundFrame, parseFrame, serializeFrame } from "./frames.ts";

/** Anything a transport reports upward. Frames are already parsed. */
export type TransportEvent =
  | { kind: "frame"; frame: PiInboundFrame }
  | { kind: "error"; error: PiProtocolError }
  | { kind: "closed"; error?: PiTransportError };

export interface Transport {
  /** Send one command. Throws `PiTransportError` when the transport cannot deliver it. */
  write(frame: PiCommand): void;
  subscribe(listener: (event: TransportEvent) => void): () => void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Live: spawn `pi --mode rpc`
// ---------------------------------------------------------------------------

export interface SpawnPiOptions {
  command: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Diagnostics ring buffer size for stderr. Stderr is never protocol data. */
  maxStderrLines?: number;
}

export interface SpawnPiTransport extends Transport {
  /** The last stderr lines, diagnostics only. */
  stderrLines: string[];
  /** Resolves with pi's exit code. */
  exited: Promise<number>;
}

/** Spawn Pi in RPC mode and speak strict JSONL over its stdio. */
export function spawnPiTransport(options: SpawnPiOptions): SpawnPiTransport {
  const child = Bun.spawn(options.command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (typeof child.stdin === "number") {
    throw new PiTransportError("pi stdin is not a pipe");
  }
  const stdin = child.stdin;
  const listeners = new Set<(event: TransportEvent) => void>();
  const stderrLines: string[] = [];
  const maxStderrLines = options.maxStderrLines ?? 100;
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  let stdoutBuffer = "";

  const emit = (event: TransportEvent) => {
    for (const listener of listeners) listener(event);
  };

  const stdoutDone = (async () => {
    for await (const chunk of child.stdout) {
      stdoutBuffer += stdoutDecoder.decode(chunk, { stream: true });
      let newline = stdoutBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.trim().length > 0) {
          try {
            emit({ kind: "frame", frame: parseFrame(line) });
          } catch (error) {
            if (!(error instanceof PiProtocolError)) throw error;
            emit({ kind: "error", error });
          }
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    }
  })();

  const stderrDone = (async () => {
    for await (const chunk of child.stderr) {
      for (const line of stderrDecoder.decode(chunk, { stream: true }).split("\n")) {
        if (line.trim().length === 0) continue;
        stderrLines.push(line);
        if (stderrLines.length > maxStderrLines) stderrLines.shift();
      }
    }
  })();

  const exited = (async () => {
    const code = await child.exited;
    await stdoutDone.catch(() => {});
    await stderrDone.catch(() => {});
    emit({
      kind: "closed",
      ...(code === 0 ? {} : { error: new PiTransportError(`pi exited with code ${code}`) }),
    });
    return code;
  })();

  return {
    stderrLines,
    exited,
    write(frame) {
      void stdin.write(serializeFrame(frame));
      void stdin.flush();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      void stdin.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: replay the committed transcript
// ---------------------------------------------------------------------------

export interface ReplayTransport extends Transport {
  /** Every line the session wrote, in order, for assertions. */
  sent: string[];
  /** Release every remaining recorded frame. */
  drain(): void;
}

/**
 * Play back recorded pi->bridge frames. A response is released when the session asks for its id,
 * together with every recorded frame before it; `drain` releases the rest. The transport does not
 * simulate Pi: it never generates frames the recording does not contain.
 */
export function createReplayTransport(frames: readonly PiInboundFrame[]): ReplayTransport {
  const listeners = new Set<(event: TransportEvent) => void>();
  const sent: string[] = [];
  let cursor = 0;

  const emit = (event: TransportEvent) => {
    for (const listener of listeners) listener(event);
  };

  const deliverUntil = (end: number) => {
    while (cursor < end) {
      const frame = frames[cursor];
      cursor += 1;
      if (frame !== undefined) emit({ kind: "frame", frame });
    }
  };

  return {
    sent,
    drain() {
      deliverUntil(frames.length);
    },
    write(frame) {
      sent.push(serializeFrame(frame));
      if (frame.type === "extension_ui_response" || frame.id === undefined) return;
      const requested = frame.id;
      const index = frames.findIndex(
        (candidate, position) =>
          position >= cursor && candidate.type === "response" && candidate.id === requested,
      );
      if (index === -1) {
        throw new PiTransportError(`replay: no recorded response for id ${requested}`);
      }
      deliverUntil(index + 1);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      emit({ kind: "closed" });
    },
  };
}
