# The thread transcript

A thread's conversation outlives the process that streamed it. Every frame a thread's log is given is
also written to one file, and the next boot rebuilds the log from that file, so the page a person
comes back to holds the conversation they were reading.

## Where it lives

One file per thread, beside that thread's run journal:

```
~/.freebot/bots/
  bot-local/
    threads/
      thread-1/runs.jsonl          the run records, one command per line
      thread-1/transcript.jsonl    the frames, one record per line
```

The path is decided in one place, `threadTranscriptPath` in `apps/server/src/run-service.ts`:

```ts
export function threadTranscriptPath(root: string, botId: string, threadId: string): string {
  return join(root, botId, "threads", threadId, "transcript.jsonl");
}
```

The storage key is the thread, not the Bot and not the run: `<botsRoot>/<botId>/threads/<threadId>/`.
One file per thread is what makes a conversation's seq space its own — the same choice the in-memory
log already made — so a transcript can never hold two threads' frames interleaved.

## The line

One frame per line, the seq beside it:

```json
{"seq":1,"frame":{"v":1,"seq":1,"ts":1792403352965,"runId":"run-1","type":"run.started","payload":{"prompt":"run one gated command"}}}
```

The frame is the landed `EventMessage` envelope the stream already serves, unchanged. The record
around it adds nothing but the seq, because the frame already carries its own; the driver asserts
both agree on every line so a reader may trust either.

`packages/core/src/jsonl.ts` is the file, `packages/core/src/transcript-store.ts` is the store.
The store is a `SeqLog` rather than something holding one, and that is load-bearing: `append` asks
the log's own rule what it would do with the frame, writes the file when the answer is to take it,
and only then moves the log's tail. A duplicate, a gap or a frame the log would reject never reaches
the disk, and a write that throws leaves the log where it was, so the copy in memory cannot come out
ahead of the copy on disk. There is no second path that can append a frame the page would lose on
the next restart, and `createLogPort` kept its own single call site.

The file is the same append-with-`fsync` JSONL the run journal uses, so `RunStore` was moved onto
the same `JsonlFile` rather than the rules being written twice.

## What a boot does with it

Every thread the registry holds is opened at boot, and opening one replays its transcript into that
thread's log. Three things follow.

- **A client's cursor means the same thing on either side of a restart.** `last_seen_seq` is a seq in
  the thread's log, and the log's tail after a replay is the file's tail. A client that had read to 16
  asks for 17 whether the process that wrote 16 is still up or not.
- **Streaming continues the same seq space.** `createLogPort` takes `log.lastSeq + 1`, so the first
  frame of the first run after a restart continues the hydrated space instead of restarting at 1.
  Nothing renumbers and nothing is replayed twice.
- **Reading a transcript repairs it.** A last line with no newline is a write the process never
  reported applied, so it is dropped and the file is rewritten from the records that survive. A line
  that parses but that the log refuses stops the replay at the last record it kept, truncates the
  file there, and reports
  `{line, reason}` on the store's `loadReport` rather than throwing: a transcript that is partly
  readable is a conversation worth showing, and the alternative is a server that will not boot. The
  request path is unaffected either way, because nothing is read from the store until a client asks.
  A rewrite goes through a neighbour file that is fsynced and then renamed over the transcript, so a
  crash in the middle of one cannot take records an earlier append already fsynced with it.

## A run the last process was holding

The record survives a restart; the loop driving it does not. Left alone, such a run stays `running`
forever and the page replays a conversation that will never gain another frame. The boot pass
(`settleAbandoned`) ends it at the code the taxonomy already declares for this, so no call site
invents a reason:

| Code | Run | Wire kind | UI copy |
| --- | --- | --- | --- |
| `server_restart` | failed | `run.failed` | FreeBot stopped while this run was in flight. |

`queued`, `running` and `awaiting_approval` are settled: each one means a loop is, or just was,
driving this run. A `paused` run is left alone, because the taxonomy parks a run that can be
rejoined, so its status is a wait rather than an ending, and a restart is not evidence that the wait
ended.

The two ending frames (`run.failed` carrying the taxonomy's copy, then `run.status failed`) are
appended **before** the record is failed, and each one is asked for on its own:

- The frames go first because the transcript is what the page reads. A crash between the two writes
  then leaves a conversation that already ends, and the next boot finishes the record rather than
  showing a run still in flight.
- Each frame is checked separately, because a crash can land between them. A boot that finds the
  `run.failed` frame and not the status frame writes the status frame and nothing else, and the
  reverse is the same, so booting twice is not two endings.
- A run the taxonomy already failed at this code is repaired the same way, because a record can be
  failed while the transcript is still short of a frame it was failed for.

An approval card the abandoned run left parked is closed by the renderer, not left answerable: it
carries `data-decision="failed"` and the words `run failed`, and its buttons are disabled. A click
there would reach no parked call.

## Evidence

`bun packages/verify/scripts/transcript-restart.ts` is `live-ui-verified`. Five launches of
`bun run up --no-open --replay` over two homes the driver made, driven from the page in headless
Chrome:

- **A** drives a run to done from the page's own composer and leaves a torn last line in the
  transcript behind it;
- **B** boots over the same home, reads the conversation back off the disk fact for fact, drops and
  repairs the torn line, and starts a second run whose first frame is the hydrated tail plus one;
- **C** boots again and shows the run B was still holding as `failed` at `server_restart`, with the
  card it left behind closed and the first run's frames untouched;
- **D** boots the settled home once more and appends nothing;
- **E** is the negative control — a home with no transcript shows the empty state and the file is not
  created by reading — followed by one run driven to done, which is what shows live streaming is
  unchanged.

Four states are committed as PNGs with `assert.txt`. The key scan asserts the driver's placeholder
key is in no artifact and in no file the runs wrote.

`packages/core/src/transcript-store.test.ts` covers the store directly: append and read, order,
`lastSeq` after a reconnect, the torn tail, a refused line, and reusing one file across two stores.

## Limits and follow-ups

- **One writer per thread is the assumption.** Nothing locks a transcript, so two `bun run up`
  processes on one home can interleave lines, exactly as they can in `index.jsonl` and a thread's
  `runs.jsonl`. A single-user local app is the assumption and it is not enforced.
- **The transcript grows without bound.** There is no compaction, rotation or ceiling, and every
  frame of every run of a thread stays. The file a long conversation produces is a real cost this
  unit does not bound.
- **A refused line is reported, not surfaced.** `TranscriptStore.loadReport` carries
  `{line, reason}`, and nothing in `apps/server` reads it, so a repair is silent from the outside. A
  boot line naming what was dropped is the obvious follow-up.
- **`docs/bots-and-threads.md` still says frames are the live log.** Its "Where the records live" and
  "Limits and follow-ups" sections describe the behaviour before this unit, including the sentence
  "The frames of a finished conversation are not persisted." They are superseded by this document.
  The same unit's row in `docs/VERIFICATION.md` closes with the same claim ("a restart brings back
  the runs and not the transcript"), and its driver `packages/verify/scripts/bots-and-threads.ts`
  checks the post-restart frame count against `0`, which a restart now fills. That row, that driver
  and that page belong to the unit that wrote them; naming them here is what makes a claim the code
  has outgrown findable, and this unit may not edit another unit's driver.
