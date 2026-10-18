# Bots and threads

The app has three nouns. A **Bot** is a named agent that owns a workspace directory. A **thread** is
one conversation with one Bot. A **run** is one execution from a prompt to a terminal state, and it
belongs to both: it names the Bot it acts for and the thread it appends to. `UX.md`'s vocabulary
defines the words, and this unit is `UX.md` page 3's list and page 5's conversation behind it.

Before this unit the app was one Bot and one thread per run: `apps/server/src/run-service.ts`
hard-coded `botId: "bot-local"` and `threadId: \`thread-${runId}\``. Both lines are gone. A run names
both records, the service refuses either one when it does not hold it, and a thread holds as many
runs as it is asked for.

## Where the records live

One directory holds everything a Bot owns. `FREEBOT_WORKSPACE` names it, and it defaults to
`~/.freebot/bots`, which is the directory the single-Bot app already kept its one workspace in.

```
~/.freebot/bots/
  index.jsonl                      the Bot registry: one command per record
  bot-local/                       one directory per Bot, named by its id
    workspace/                     this Bot's workspace, mounted at /workspace into its runs
    threads/
      thread-1/runs.jsonl          this thread's run journal
```

- **The registry** (`packages/core/src/bot-store.ts`) is a `BotStore`: an append-only journal of
  two commands, `bot.create` and `thread.create`, each idempotent by record id, replayed at boot.
  It follows `run-store.ts`'s shape and its reasons, and it is the second store rather than a second
  convention. A journal line whose record id already exists applies once; a `thread.create` for a
  Bot the journal does not hold is refused by name and recorded as refused.
- **A thread's runs** are a `RunStore` of its own, at `threads/<threadId>/runs.jsonl`, so a restart
  brings a thread's conversation back with the prompts and the statuses it ended at.
- **A thread's log** is a `SeqLog` of its own, in memory. One log per thread is what makes a
  conversation's seq space its own: `subscribe_events` and the page's stream both name the thread
  they follow, and a stream that names none, or one the server does not hold, is refused before the
  upgrade. Frames are the live log, not a persisted record: a restart brings back every run, and the
  frames of a finished conversation are gone with the process that streamed them. The transcript of
  a *running* conversation is not lost across a reconnect, which is what the resume banner covers.

## What a Bot owns

A Bot's id is the key of its directory, and the id is minted by the server because two callers that
picked their own would collide on the filesystem. The first Bot a fresh bots root holds takes
`bot-local`, the id the single-Bot app hard-coded, so a machine that already ran it keeps the
workspace directory its files are in. Later Bots take `bot-<n>`. The id is one path segment, and the
contract refuses an id that is not, before any handler turns it into a path.

Each Bot's workspace is `bots/<botId>/workspace`, and every run of that Bot mounts it at
`/workspace`. Two Bots therefore cannot see each other's files, and the `list_files` / `read_file`
arms name the Bot they read, so a surface can only read a whole workspace by naming whose it is.
`docs/files-surface.md` states the read rules and this unit adds only the Bot dimension to them.

## The page

`apps/web/host/` is the same one page, now with the shell `UX.md` page 3 describes:

- A sidebar lists the Bots, each row with its thread count, and a control that creates one. Creating
  a Bot also creates its first thread, because a Bot with no thread is a Bot nobody can talk to.
- Inside a Bot, a list of its threads, each row with the first thing that thread was asked and its
  run count. Selecting one re-subscribes that thread's log and replays it from the start of *its*
  seq space, so the transcript on screen is always the selected thread's.
- The composer sends `{type: "start", prompt, botId, threadId}`, so a run lands in the conversation
  the person is looking at. A prompt composed while the selected thread's socket is still opening
  waits in an outbox and goes out when it opens.
- The Library reads the selected Bot's workspace, so switching Bots switches the computer the
  Library is reading.

`packages/ui/src/bots.ts` holds the rows, the labels and the wording; `packages/ui/browser/shell.ts`
renders them and reads them back for the evidence harness. The split is the one `library.ts` and
`thread.ts` already keep.

Operator mode is still "the page was opened with an operator token", and it is now also what reveals
the sidebar: a Bot list needs the API, and the fixture peer serves none. On a server that holds no
Bot, the page creates the first one, named `Local Bot`, through the same arm a person's click uses.
That is a deliberate deviation from `UX.md` page 2, whose first-run welcome sequence is a later unit:
until it exists, the alternative is a page with nothing to type into.

## The evidence

`bun packages/verify/scripts/bots-and-threads.ts` is `live-ui-verified`. It launches
`bun run up --no-open` over a bots root of its own, so the server starts with no Bots at all; the
page creates the first one; the driver creates a second from the sidebar's own control; runs two
conversations in the first Bot's thread with the vault's keyed model, one of which writes a file
carrying a nonce the driver minted; opens a second thread and checks the transcript follows the
selection; opens the other Bot's Library and checks it is empty while the first Bot's workspace
holds that file; then interrupts the launch for real and starts a second one over the same
directory, comparing the Bot-and-thread list it reads over the route surface before the stop with
the one it reads after the start. Seven frames are committed with `assert.txt`.

## Limits and follow-ups

- **Two servers on one bots root are two writers of one journal.** Nothing locks
  `index.jsonl` or a thread's `runs.jsonl`, so two `bun run up` processes on one home can interleave
  lines. Measured: the four existing drivers each launch several servers, and every one of them
  passes; each driver now points its launches at a bots root of its own. A single-user local app is
  the assumption, and it is not enforced.
- **The frames of a finished conversation are not persisted.** A restart keeps the runs and their
  prompts, and shows them in the thread list, but the transcript itself was the live log. Persisting
  frames needs a decision about which facts are worth a file, which is a bigger unit.
- **A thread's title is always `New conversation`.** The thread list shows the first prompt as the
  row's detail, which is what a person reads, but the record itself has no rename. A rename is one
  command in the Bot store.
- **The `files-surface` row's prose and the `type-gate` row's blind set.** U4.1's driver was updated
  for this unit's launcher line and its per-Bot workspace reads, and it passes 54/54 at this head;
  its committed artifact and row still date from U4.1, and the row's sentence about the launcher's
  workspace line names the wording that unit printed. The type gate's blind set gains
  `packages/ui/browser/shell.ts`, as U4.1 added the Library's module.
