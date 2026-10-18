/**
 * The emulated service the connector evidence runs against: a GitHub API this process serves,
 * seeded with a repository and a token this run minted.
 *
 * A real service would need a person's account and a credential with it, and the seam's promise is
 * about where a credential goes and what happens when it is missing, so the service is one this
 * machine runs. `emulate` is a fixture server, vendored as this package's dependency, not a mock of
 * one library's client: the connector under test speaks MCP over the network, the MCP fixture calls
 * this service's REST surface over the network, and the assertions read the service's own state over
 * that same surface. Nothing here is stubbed above the socket.
 *
 * It listens on `0.0.0.0` on a port the OS picks. Every other fixture in this repo binds loopback,
 * and this one does not, on purpose: the driver proves that the sandbox cannot act on the service
 * even when the network reaches it, and a loopback-only fixture would make that proof ambiguous —
 * unreachable and unauthorized would be the same 401. Bound this way, a container can knock on the
 * door and the service is what says no.
 *
 * Three facts this service has, established by the driver's own probes against it rather than
 * assumed (see `packages/verify/scripts/connectors.ts`):
 *
 * - a write with no `authorization` header is refused with 401 (`Requires authentication`);
 * - a write that carries some bearer credential is accepted, whoever the token names;
 * - `reset()` empties the store and re-runs the seed, so the issues a run created are gone and the
 *   seeded repository is back.
 *
 * The middle fact is why the driver's claims are phrased the way they are: the container probe
 * proves a *missing* credential is refused, which is the credential-custody claim this unit makes.
 * It does not prove that a wrong credential is rejected, because this fixture does not do that.
 */

import { createEmulator } from "emulate";

/** The service's credentials: the one this run seeded, and the account it belongs to. */
export interface GithubFixtureOptions {
  /** The login the seeded token authenticates as. */
  readonly login: string;
  readonly owner: string;
  readonly repo: string;
}

/** One issue as the service reports it. The fields a driver asserts against, and no more. */
export interface IssueRow {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly body: string | null;
  readonly author: string;
}

export interface GithubFixture {
  /** The base URL this host reaches the service at. */
  readonly url: string;
  /** The port, for building the URL a container reaches the host by. */
  readonly port: number;
  /** The credential seeded into the service. It reaches the service's API and nothing else. */
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  /** The issues the service holds right now, read from the service, in its own order. */
  issues(): Promise<IssueRow[]>;
  /** The status and body one unauthenticated read of the issue list answers with. */
  probeWithoutCredential(): Promise<{ status: number; body: string }>;
  /** Empty the store and re-seed, the way a fresh service would look. */
  reset(): void;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A row as the service's own JSON reports it, reduced to the fields a driver asserts. */
function rowOf(raw: unknown): IssueRow {
  if (!isRecord(raw))
    throw new Error(`the service reported an issue that is not an object: ${typeof raw}`);
  const user = isRecord(raw.user) ? raw.user : {};
  return {
    number: typeof raw.number === "number" ? raw.number : 0,
    title: typeof raw.title === "string" ? raw.title : "",
    state: typeof raw.state === "string" ? raw.state : "",
    body: typeof raw.body === "string" ? raw.body : null,
    author: typeof user.login === "string" ? user.login : "",
  };
}

export async function startGithubFixture(options: GithubFixtureOptions): Promise<GithubFixture> {
  // A per-run credential, minted here and held by this object. It is never logged and never
  // written to an artifact; the artifact writer refuses one that carries it.
  const token = `github-fixture-${crypto.randomUUID()}`;
  const emulator = await createEmulator({
    service: "github",
    port: 0,
    hostname: "0.0.0.0",
    seed: {
      tokens: { [token]: { login: options.login, scopes: ["repo"] } },
      github: {
        users: [{ login: options.login, name: "FreeBot Fixture" }],
        repos: [{ owner: options.owner, name: options.repo, description: "the connector fixture" }],
      },
    },
  });
  const base = new URL(emulator.url);
  const port = Number(base.port);
  const url = `http://127.0.0.1:${port}`;
  const issuesPath = `/repos/${options.owner}/${options.repo}/issues`;

  return {
    url,
    port,
    token,
    owner: options.owner,
    repo: options.repo,
    async issues(): Promise<IssueRow[]> {
      const response = await fetch(`${url}${issuesPath}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      });
      const body = await response.text();
      if (response.status !== 200) {
        throw new Error(`the service refused its own issue list: ${response.status} ${body}`);
      }
      const parsed: unknown = JSON.parse(body);
      return Array.isArray(parsed) ? parsed.map(rowOf) : [];
    },
    async probeWithoutCredential(): Promise<{ status: number; body: string }> {
      // A write, because that is the request this service authenticates. Its list route answers
      // without one, which is why the probe is a POST rather than a GET.
      const response = await fetch(`${url}${issuesPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "probe without a credential" }),
      });
      return { status: response.status, body: (await response.text()).trim() };
    },
    reset(): void {
      emulator.reset();
    },
    close: () => emulator.close(),
  };
}
