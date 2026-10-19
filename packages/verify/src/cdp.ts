/**
 * The shared Chrome DevTools Protocol client.
 *
 * Six drivers grew their own copy of this transport, its reply bookkeeping, its waiter list and its
 * `DevToolsActivePort` handshake. This module is that copy, once, so a new driver starts from a
 * client instead of from a paste. It carries three things: the socket and its request/reply map, the
 * event waiters a driver needs for a load, and the page-level helpers every driver writes anyway
 * (open a page, evaluate an expression, wait for a predicate, set a viewport, take a screenshot).
 *
 * `design-contract.ts` is the first consumer. The existing drivers still carry their own copies on
 * purpose, so this unit's diff stays reviewable; moving them onto this module is a follow-up, named
 * in `docs/DESIGN-CONTRACT.md`.
 */

import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where Chrome lives on this project's build host (order 18: this Mac is the build host), or the
 * path a caller pins through `FREEBOT_CHROME`. CI installs its own Chrome and sets that variable,
 * so the one gate that needs a browser names the browser rather than assuming the host.
 */
export const CHROME =
  process.env.FREEBOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export type CdpReply = {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message: string };
};

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

type Waiter = {
  predicate: (message: CdpReply) => boolean;
  resolve: (message: CdpReply) => void;
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The flat-session CDP connection: one socket, one page session per target. */
export class Cdp {
  readonly #ws: WebSocket;
  readonly #pending = new Map<number, Pending>();
  #waiters: Waiter[] = [];
  #nextId = 1;
  #version = "";
  /** Everything the pages reported through `console` or threw, in arrival order. */
  readonly console: string[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (event: MessageEvent) => this.#receive(JSON.parse(String(event.data)));
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`CDP connect failed: ${url}`));
    });
    return new Cdp(ws);
  }

  #receive(message: CdpReply & { params?: unknown }): void {
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error !== undefined) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result ?? {});
      return;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const args = (message.params as { args?: Array<{ value?: unknown; description?: string }> })
        ?.args;
      this.console.push(
        (args ?? []).map((arg) => String(arg.value ?? arg.description ?? "")).join(" "),
      );
    }
    if (message.method === "Runtime.exceptionThrown") {
      this.console.push(`EXCEPTION ${JSON.stringify(message.params)}`);
    }
    this.#waiters = this.#waiters.filter((waiter) => {
      if (!waiter.predicate(message)) return true;
      waiter.resolve(message);
      return false;
    });
  }

  get version(): string {
    return this.#version;
  }

  get product(): string {
    return `chrome ${this.#version}`;
  }

  async init(): Promise<void> {
    const version = await this.send<{ product: string }>("Browser.getVersion");
    this.#version = version.product;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.#nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as Pending["resolve"], reject });
      this.#ws.send(JSON.stringify(message));
    });
  }

  /** One event, matched by predicate, or a rejection naming what was being waited for. */
  once(
    predicate: (message: CdpReply) => boolean,
    desc: string,
    timeoutMs = 30_000,
  ): Promise<CdpReply> {
    return new Promise<CdpReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP event timeout: ${desc}`)), timeoutMs);
      this.#waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  close(): void {
    this.#ws.close();
  }
}

export interface Chrome {
  readonly cdp: Cdp;
  stop(): void;
}

export interface ChromeOptions {
  /** The browser window's own size. A driver that sets a viewport per page does not depend on it. */
  readonly windowSize?: string;
  readonly extraArgs?: readonly string[];
  /** A directory the caller owns and cleans up, or a fresh one under the system temporary dir. */
  readonly profileDir?: string;
}

/**
 * Start headless Chrome, wait for its debugging port, and attach. The caller stops it.
 *
 * The port file Chrome writes is the handshake: a fixed port would collide with a second driver on
 * the same machine (order 22 keeps drivers from killing each other, and this keeps them from
 * fighting over a port).
 */
export async function launchChrome(options: ChromeOptions = {}): Promise<Chrome> {
  const profileDir = options.profileDir ?? join(tmpdir(), `freebot-cdp-${Date.now()}`);
  mkdirSync(profileDir, { recursive: true });
  const proc = Bun.spawn(
    [
      CHROME,
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--mute-audio",
      "--hide-scrollbars",
      `--window-size=${options.windowSize ?? "1440,900"}`,
      ...(options.extraArgs ?? []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const portFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (!isFile(portFile)) {
    if (Date.now() > deadline) throw new Error("Chrome did not write DevToolsActivePort");
    await sleep(100);
  }
  const [port = "", path = ""] = readFileSync(portFile, "utf8").split("\n");
  let cdp: Cdp | null = null;
  for (let attempt = 0; attempt < 20 && cdp === null; attempt++) {
    try {
      cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
    } catch {
      await sleep(250);
    }
  }
  if (cdp === null) {
    proc.kill();
    throw new Error("could not attach CDP to Chrome");
  }
  await cdp.init();
  let stopped = false;
  return {
    cdp,
    stop() {
      if (stopped) return;
      stopped = true;
      cdp.close();
      proc.kill();
      rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Open a page in its own target, wait for its load event, and return its session id. */
export async function openPage(cdp: Cdp, url: string): Promise<string> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  const loaded = cdp.once(
    (message) => message.sessionId === sessionId && message.method === "Page.loadEventFired",
    `page load ${url}`,
  );
  await cdp.send("Page.navigate", { url }, sessionId);
  await loaded;
  return sessionId;
}

/** What CDP reports when the page itself threw: a summary, and the exception it carries. */
export interface PageExceptionDetails {
  readonly text?: string;
  readonly exception?: { readonly description?: string; readonly value?: unknown };
}

/** The page's own error, never the CDP summary and never the expression that raised it. */
export function pageErrorMessage(details: PageExceptionDetails): string {
  const description = details.exception?.description;
  if (typeof description === "string" && description !== "") {
    return description.split("\n")[0] ?? description;
  }
  if (typeof details.exception?.value === "string" && details.exception.value !== "") {
    return details.exception.value;
  }
  return details.text ?? "the page threw without a message";
}

/** Evaluate one expression in a page and return its value, failing on a page exception. */
export async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string): Promise<T> {
  const result = await cdp.send<{
    result?: { value?: unknown };
    exceptionDetails?: PageExceptionDetails;
  }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails !== undefined) {
    throw new Error(`evaluate failed: ${pageErrorMessage(result.exceptionDetails)}`);
  }
  return result.result?.value as T;
}

/** Poll one expression until it is true, or fail naming what was waited for. */
export async function waitFor(
  cdp: Cdp,
  sessionId: string,
  desc: string,
  expression: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate<boolean>(cdp, sessionId, expression)) return;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${desc}`);
}

/** One viewport, applied to the page rather than to the browser window, so it is exact. */
export async function setViewport(
  cdp: Cdp,
  sessionId: string,
  width: number,
  height: number,
): Promise<void> {
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
}

/**
 * Let layout settle: the fonts resolved, then a frame's worth of time.
 *
 * The wait is raced against a timeout because `document.fonts.ready` is the page's promise and a
 * driver must not be at its mercy. A background tab throttles timers, so nothing here waits on
 * `requestAnimationFrame` either.
 */
export async function settle(cdp: Cdp, sessionId: string, quietMs = 120): Promise<void> {
  await Promise.race([
    evaluate(cdp, sessionId, "document.fonts.ready.then(() => true)").catch(() => false),
    sleep(3_000),
  ]);
  await sleep(quietMs);
}

/** The viewport-sized PNG of the page as it stands. */
export async function screenshot(cdp: Cdp, sessionId: string): Promise<Buffer> {
  const shot = await cdp.send<{ data: string }>(
    "Page.captureScreenshot",
    { format: "png" },
    sessionId,
  );
  return Buffer.from(shot.data, "base64");
}
