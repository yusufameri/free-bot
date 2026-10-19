#!/usr/bin/env bun
/**
 * The Workspace pages' evidence: the left navigation, its seven destinations, and the group header.
 *
 * The peer is the real launcher, spawned the way a person runs it: `bun run up --no-open --replay`
 * over a temporary `FREEBOT_HOME` and bots root of this driver's own. Three Bots and a group are
 * made through the same oRPC routes the page calls, so every row the screenshots show is a record
 * this driver actually created.
 *
 * What it asserts, from the rendered DOM:
 * - the sidebar's Pinned, Work, and Hidden Bots sections, with the hidden disclosure's count;
 * - the Workspace nav's seven entries, and each page's own title;
 * - the Settings providers pane reading the install's connection;
 * - the Activity page's empty state, because this driver starts no run;
 * - the group header naming both members;
 * - no horizontal overflow at 1440x900 or 390x844.
 *
 * Run from the repo root: bun packages/verify/scripts/workspace-pages.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Cdp,
  evaluate,
  launchChrome,
  openPage,
  screenshot,
  setViewport,
  sleep,
  waitFor,
} from "../src/cdp.ts";
import { artifactDir } from "../src/index.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const feature = "workspace-pages";
const sha = (await Bun.$`git rev-parse --short HEAD`.text()).trim();
const out = artifactDir(root, feature, sha);
mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "freebot-workspace-pages-"));
const botsRoot = join(home, "bots");
let launch: Bun.Subprocess | null = null;
let chrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
const checks: string[] = [];
const failures: string[] = [];

function check(label: string, holds: boolean, detail = ""): void {
  const line = `${holds ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` :: ${detail}`}`;
  checks.push(line);
  if (!holds) failures.push(line);
}

interface Wire {
  readonly status: number;
  readonly body: string;
}

async function post(port: number, token: string, procedure: string, input: unknown): Promise<Wire> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      origin: `http://127.0.0.1:${port}`,
    },
    body: JSON.stringify({ json: input }),
  });
  return { status: response.status, body: await response.text() };
}

async function main(): Promise<void> {
  writeFileSync(
    join(home, "provider.env"),
    [
      "# workspace-pages.ts placeholder vault; --replay means no request reads it",
      `FREEBOT_BYOK_KEY=workspace-pages-${Date.now()}`,
      "FREEBOT_BYOK_BASE_URL=http://127.0.0.1:9/not-a-provider",
      "FREEBOT_BYOK_MODEL=workspace-pages-placeholder",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const proc = Bun.spawn(["bun", "run", "up", "--no-open", "--replay"], {
    cwd: root,
    env: {
      ...process.env,
      FREEBOT_HOME: home,
      FREEBOT_WORKSPACE: botsRoot,
      FREEBOT_PROVIDER: "replay",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  launch = proc;

  let stdout = "";
  let stderr = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) stdout += decoder.decode(chunk);
  })();
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) stderr += decoder.decode(chunk);
  })();

  const deadline = Date.now() + 30_000;
  let url = "";
  while (Date.now() < deadline && url === "") {
    const found = /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m.exec(stdout);
    if (found?.[1] !== undefined) url = found[1];
    else await sleep(50);
  }
  if (url === "") throw new Error(`the launcher printed no URL; stderr:\n${stderr.slice(-2000)}`);
  const parsed = new URL(url);
  const port = Number(parsed.port);
  const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "";

  const makeBot = async (name: string): Promise<{ botId: string; threadId: string }> => {
    const answer = await post(port, token, "create_bot", { name });
    const botId = (JSON.parse(answer.body) as { json: { botId: string } }).json.botId;
    const thread = await post(port, token, "create_thread", { botId });
    const threadId = (JSON.parse(thread.body) as { json: { threadId: string } }).json.threadId;
    return { botId, threadId };
  };

  const atlas = await makeBot("Atlas");
  const scout = await makeBot("Scout");
  const warehouse = await makeBot("Warehouse");
  const room = await makeBot("Launch room");

  await post(port, token, "update_bot", {
    botId: atlas.botId,
    role: "Chief of staff",
    purpose: "Keep the release pipeline moving",
  });
  await post(port, token, "update_bot", {
    botId: scout.botId,
    role: "Research",
    purpose: "Read before writing",
  });
  await post(port, token, "update_bot", {
    botId: room.botId,
    role: "Group chat",
    purpose: "Draft the launch note",
  });
  await post(port, token, "arrange_bot", { botId: atlas.botId, pinned: true });
  await post(port, token, "arrange_bot", { botId: warehouse.botId, hidden: true });
  await post(port, token, "arrange_bot", {
    botId: room.botId,
    group: true,
    members: [atlas.botId, scout.botId],
  });

  chrome = await launchChrome();
  const cdp: Cdp = chrome.cdp;
  const page = await openPage(cdp, url);
  await setViewport(cdp, page, 1440, 900);
  await waitFor(cdp, page, "the app shell", "document.querySelector('#sidebar')?.hidden === false");
  await waitFor(
    cdp,
    page,
    "the grouped Bot list",
    "document.querySelectorAll('#bot-list .sb-row').length >= 3",
  );
  await sleep(300);

  const shell = await evaluate<{
    sections: string[];
    rows: number;
    hiddenCount: string;
    hiddenShown: boolean;
    navCount: number;
    title: string;
    role: string;
    groupHidden: boolean;
  }>(
    cdp,
    page,
    `(() => ({
      sections: [...document.querySelectorAll('#bot-list > .sb-label')].map((n) => n.textContent?.trim() ?? ''),
      rows: document.querySelectorAll('#bot-list .sb-row').length,
      hiddenCount: document.querySelector('#hidden-count')?.textContent ?? '',
      hiddenShown: document.querySelector('#hidden-bots')?.hidden === false,
      navCount: document.querySelectorAll('#nav-list [data-view]').length,
      title: document.querySelector('#bot-title')?.textContent ?? '',
      role: document.querySelector('#bot-role')?.textContent ?? '',
      groupHidden: document.querySelector('#groupbar')?.hidden !== false,
    }))()`,
  );
  check(
    "the sidebar carries Pinned",
    shell.sections.includes("Pinned"),
    shell.sections.join(" | "),
  );
  check("the sidebar carries Work", shell.sections.includes("Work"), shell.sections.join(" | "));
  check("the main list holds the three visible Bots", shell.rows === 3, String(shell.rows));
  check(
    "Hidden Bots is present with a count of one",
    shell.hiddenShown && shell.hiddenCount === "1",
    shell.hiddenCount,
  );
  check("the Workspace nav carries seven entries", shell.navCount === 7, String(shell.navCount));
  check("the header names the selected Bot", shell.title.length > 0, shell.title);
  check("the header carries the Bot's role", shell.role.length > 0, shell.role);
  check("an ordinary Bot shows no group bar", shell.groupHidden, String(shell.groupHidden));

  const views = ["skills", "apps", "rules", "activity", "teams", "settings", "mobile"] as const;
  const titles: Record<(typeof views)[number], string> = {
    skills: "Skills",
    apps: "Apps and connectors",
    rules: "Rules and the approvals ledger",
    activity: "Activity log",
    teams: "Teams",
    settings: "Settings",
    mobile: "Mobile and the second surface",
  };

  for (const [index, view] of views.entries()) {
    await evaluate(cdp, page, `document.querySelector('#nav-list [data-view="${view}"]').click()`);
    await waitFor(
      cdp,
      page,
      `${view} page`,
      `document.querySelector('#page')?.hidden === false && document.querySelector('#page .page-title h1')?.textContent === ${JSON.stringify(titles[view])}`,
    );
    const facts = await evaluate<{ title: string; overflow: boolean; paragraphs: string }>(
      cdp,
      page,
      `(() => ({
        title: document.querySelector('#page .page-title h1')?.textContent ?? '',
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        paragraphs: [...document.querySelectorAll('#page p, #page h3')].map((n) => n.textContent ?? '').join(' '),
      }))()`,
    );
    check(`${view} page title`, facts.title === titles[view], facts.title);
    check(`${view} page has no horizontal overflow`, !facts.overflow, String(facts.overflow));
    writeFileSync(
      join(out, `${String(index + 1).padStart(2, "0")}-${view}.png`),
      await screenshot(cdp, page),
    );
  }

  await evaluate(cdp, page, `document.querySelector('#nav-list [data-view="settings"]').click()`);
  await waitFor(
    cdp,
    page,
    "the settings page",
    `document.querySelector('#page .page-title h1')?.textContent === "Settings"`,
  );
  const settings = await evaluate<{ model: string; panes: number; providerCard: boolean }>(
    cdp,
    page,
    `(() => ({
      model: [...document.querySelectorAll('#page .kv')].find((n) => n.querySelector('.k')?.textContent === 'Model')?.textContent ?? '',
      panes: document.querySelectorAll('#page .sb-row').length,
      providerCard: [...document.querySelectorAll('#page .cap')].some((n) => n.textContent === 'Provider'),
    }))()`,
  );
  check(
    "Settings reports the install's model",
    settings.model.includes("workspace-pages-placeholder") || settings.model.includes("none"),
    settings.model,
  );
  check("Settings carries its Provider card", settings.providerCard, String(settings.providerCard));
  check("Settings carries its seven panes", settings.panes === 7, String(settings.panes));

  const activityText = await evaluate<string>(
    cdp,
    page,
    `(() => {
      document.querySelector('#nav-list [data-view="activity"]').click();
      return document.querySelector('#page')?.textContent ?? '';
    })()`,
  );
  check(
    "Activity starts with an empty state",
    activityText.includes("No runs match those filters"),
    activityText.slice(0, 120),
  );

  await evaluate(cdp, page, `document.querySelector('#nav-list [data-view="skills"]').click()`);
  await sleep(120);
  const skillsText = await evaluate<string>(
    cdp,
    page,
    "document.querySelector('#page')?.textContent ?? ''",
  );
  check(
    "Skills says the library is empty",
    skillsText.includes("No skills yet"),
    skillsText.slice(0, 120),
  );

  await evaluate(cdp, page, `document.querySelector('#nav-list [data-view="teams"]').click()`);
  await sleep(120);
  const teamsText = await evaluate<string>(
    cdp,
    page,
    "document.querySelector('#page')?.textContent ?? ''",
  );
  check(
    "Teams says there is no team",
    teamsText.includes("No team on this install"),
    teamsText.slice(0, 120),
  );

  await evaluate(cdp, page, `document.querySelector('#nav-list [data-view="apps"]').click()`);
  await sleep(250);
  const appsText = await evaluate<string>(
    cdp,
    page,
    "document.querySelector('#page')?.textContent ?? ''",
  );
  check(
    "Apps says no connector is connected",
    appsText.includes("No apps connected"),
    appsText.slice(0, 120),
  );

  // The group header: select the room and read its member chips.
  await evaluate(
    cdp,
    page,
    `document.querySelector('#bot-list .sb-row[data-bot="${room.botId}"]').click()`,
  );
  await waitFor(
    cdp,
    page,
    "the group bar",
    "document.querySelector('#groupbar')?.hidden === false && document.querySelectorAll('#groupbar .gm').length === 2",
  );
  const group = await evaluate<{ members: string[]; tag: string; header: string }>(
    cdp,
    page,
    `(() => ({
      members: [...document.querySelectorAll('#groupbar .gm')].map((n) => n.textContent?.trim() ?? ''),
      tag: document.querySelector('#groupbar .tag')?.textContent ?? '',
      header: document.querySelector('#bot-title')?.textContent ?? '',
    }))()`,
  );
  check("the group bar names both members", group.members.length === 2, group.members.join(" | "));
  check("the group bar names the shared volume", group.tag === "/shared volume", group.tag);
  check("the header names the room", group.header.includes("Launch room"), group.header);
  writeFileSync(join(out, "08-group.png"), await screenshot(cdp, page));

  // The Share control copies the page, never the operator fragment. Drive the real button with a
  // clipboard shim so the captured string is the one the page would have written.
  const shared = await evaluate<string>(
    cdp,
    page,
    `(async () => {
      let copied = "no-clipboard";
      const clipboard = navigator.clipboard;
      if (clipboard) {
        const original = clipboard.writeText.bind(clipboard);
        clipboard.writeText = async (text) => {
          copied = text;
          try { await original(text); } catch {}
        };
      }
      document.querySelector('#share-button').click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      return copied;
    })()`,
  );
  const origin = new URL(url).origin;
  check(
    "Share copies the path without the operator token",
    shared === `${origin}/` && !shared.includes("token"),
    shared,
  );

  const accountMenu = await evaluate<string>(
    cdp,
    page,
    `(() => {
      document.querySelector('#account-row').click();
      const labels = [...document.querySelectorAll('.menu button')].map((n) => n.textContent ?? '');
      document.querySelector('.menu')?.remove();
      return labels.join(' | ');
    })()`,
  );
  check(
    "the account menu signs out of the page",
    accountMenu.includes("Sign out of this page"),
    accountMenu,
  );

  // The same page at a phone width: no horizontal scroll, and the sidebar stands down.
  await setViewport(cdp, page, 390, 844);
  await sleep(150);
  const mobile = await evaluate<{ sidebarHidden: boolean; overflow: boolean }>(
    cdp,
    page,
    `(() => ({
      sidebarHidden: getComputedStyle(document.querySelector('#sidebar')).display === 'none',
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }))()`,
  );
  check("the sidebar stands down at 390", mobile.sidebarHidden, String(mobile.sidebarHidden));
  check("the page does not scroll sideways at 390", !mobile.overflow, String(mobile.overflow));
  writeFileSync(join(out, "09-group-390.png"), await screenshot(cdp, page));

  writeFileSync(
    join(out, "assert.txt"),
    [
      `feature: ${feature}`,
      `command: bun packages/verify/scripts/workspace-pages.ts`,
      `timestamp: ${new Date().toISOString()}`,
      `git short sha: ${sha}`,
      `launcher: ${url.replace(/#token=.*$/, "#token=<redacted>")}`,
      `screenshots: 01-skills .. 07-mobile at 1440x900, 08-group, 09-group-390`,
      "",
      ...checks,
      "",
      `RESULT: ${failures.length === 0 ? "PASS" : "FAIL"} (${checks.length - failures.length}/${checks.length})`,
    ].join("\n"),
  );
  console.log(checks.join("\n"));
  console.log(
    `RESULT: ${failures.length === 0 ? "PASS" : "FAIL"} (${checks.length - failures.length}/${checks.length})`,
  );
  console.log(`artifact: ${out}`);
  if (failures.length > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  // The values are assigned inside `main`, which control-flow analysis cannot see from here.
  const browser = chrome as Awaited<ReturnType<typeof launchChrome>> | null;
  const proc = launch as Bun.Subprocess | null;
  browser?.stop();
  proc?.kill("SIGINT");
  await sleep(250);
  rmSync(home, { recursive: true, force: true });
}
