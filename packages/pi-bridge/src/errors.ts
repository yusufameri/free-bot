/** Typed failures the bridge surfaces to its callers. */

/** A stdout line was not a protocol frame, or the dialog/decision payload was malformed. */
export class PiProtocolError extends Error {
  readonly line: string;

  constructor(message: string, line: string) {
    super(message);
    this.name = "PiProtocolError";
    this.line = line;
  }
}

/** Pi answered a command with `success: false`. */
export class PiCommandError extends Error {
  readonly command: string;
  readonly id: string | undefined;

  constructor(response: { command: string; id?: string; error?: string }) {
    super(`${response.command} failed: ${response.error ?? "no error text"}`);
    this.name = "PiCommandError";
    this.command = response.command;
    this.id = response.id;
  }
}

/** The transport itself failed: process exit, replay miss, deadline. */
export class PiTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PiTransportError";
  }
}
