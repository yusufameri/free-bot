# The files surface (U4.1)

The Library tab shows the files a Bot's runs produced. It reads them through two contract arms,
`list_files` and `read_file`, which landed behind the one run service. Every byte it shows came from
the Bot's own directory on this computer, written by a container the run has already destroyed.

## What a Bot's computer is, and what survives it

A run owns one container and destroys it on every path, success included (`run-service.ts`). A file a
run writes to `/workspace` would go with it, so the workspace is not inside the container. It is a
host directory:

```
<freebot home>/bots/bot-local/workspace     the Bot's workspace, one per Bot
```

The run service creates it once, resolves its real path, and bind-mounts it at `/workspace` into
every container that Bot runs. The container's `/workspace` and that host directory are the same
bytes, which is what makes the Library's list a list of what the computer produced rather than a
copy taken at some other moment.

So the honest claim, and the one the page makes, is narrow. Files under `/workspace` outlive the run.
The computer does not: the container, anything installed into it, its `/tmp`, and every path outside
`/workspace` are destroyed when the run ends. The Library's own note reads:

> This Bot's workspace is kept on this computer, so the files here outlive the run that wrote them.
> Every run mounts it at /workspace.

`UX.md` section 11 is why this shape was chosen over the alternative. It calls the Library "the
durable output of a run in one place" and names `/workspace` as "the durable area". A surface that
showed the last run's captured outputs would be named `Recent output`; the spec names a Library. The
smallest change that makes the spec true is one host directory and one mount: no new sandbox method,
no scheduler, no snapshot, no sync step. Anything larger would be scope this unit does not need.

Three costs are worth stating plainly.

- The model can write to that host directory, because it is the sandbox's `/workspace`. The reader
  confines what the surface reads; it cannot confine what the model writes inside the mount.
- Every run of the Bot shares one directory. Two runs started at once write the same files.
- The mount needs the freebot home to be inside Docker Desktop's shared paths. On this Mac it is
  (`/Users`), and a path outside them fails at container creation with Docker's own error rather than
  silently writing nowhere.

Follow-ups, named and not done: the directory becomes per-Bot for real once bots are plural (the
server has one, `bot-local`); a Docker volume or a sync at run end would isolate the host filesystem
from the model where that matters; and a run that is `SIGKILL`ed still leaks its container
(`docs/one-run-path.md`), which the workspace makes less painful but does not fix.

## The two arms

| surface | contract | handler | reads |
| --- | --- | --- | --- |
| `list_files` | `listFilesInput` -> `listFilesOutput` (`dto.ts`) | `router.ts` | `RunService.listFiles` -> the workspace reader |
| `read_file` | `readFileInput` -> `readFileOutput` (`dto.ts`) | `router.ts` | `RunService.readFile` -> the workspace reader |

`packages/protocol/src/api.ts` wires the two DTOs into `apiContract` and declares each refusal as an
error code with its status. The Zod shapes in `dto.ts` are unchanged; only the arms that answer them
are new. Both reads reach the same `RunService` the runs run behind, so there is no second copy of a
Bot's files to drift.

The page consumes them with the oRPC client (`RPCLink`) against `${location.origin}/rpc`, carrying
the operator token the page already reads from the URL fragment. A refusal arrives as an `ORPCError`
whose `code` is the refusal's name, and the Library renders that name rather than parsing a sentence.

## Path scoping

`apps/server/src/workspace-files.ts` owns the rules. Every read is lstat'd, resolved, and checked for
containment against the workspace's real root before a byte is returned. A refusal raises
`WorkspaceReadError`, and the router maps its name onto the wire.

| refusal | when | wire code | status |
| --- | --- | --- | --- |
| `absolute_path` | the path starts with `/` | `absolute_path` | 400 |
| `parent_traversal` | the path has a `..` segment | `parent_traversal` | 400 |
| `symlink_escape` | the resolved real path is outside the workspace | `symlink_escape` | 403 |
| `path_not_found` | nothing is there | `path_not_found` | 404 |
| `not_a_directory` | `list_files` on a file | `not_a_directory` | 400 |
| `not_a_file` | `read_file` on a directory | `not_a_file` | 400 |
| `binary_file` | NUL bytes, or bytes that are not UTF-8 | `binary_file` | 415 |

`workspacePathSchema` in `dto.ts` already refuses an absolute path and a `..` segment before any
handler runs, and its landed tests assert that. The reader refuses both again under the names above,
because a boundary that fires once is a boundary a caller below it does not have.

A symlink that stays inside the workspace is read like the file it names. A symlink that resolves
outside is listed, as a file with no size, and refused on open. Stat'ing its outside target to learn
its kind would leak that target's size and type, and the read refuses the entry by name anyway.

One limit is worth naming. The reader resolves the real path and then opens it, so a symlink swapped
between those two calls could still be followed. Closing that window needs an `openat`-style handle
check the Node API does not expose. The window is inside the Bot's own workspace, which only the
Bot's own runs write to.

`read_file` returns at most 256 KiB and sets `truncated` when the file is larger, with `size` always
the bytes on disk. A binary file is refused rather than mangled.

## The evidence

`bun packages/verify/scripts/files-surface.ts` writes
`packages/verify/artifacts/files-surface/<short-sha>/` with `assert.txt` and one PNG per asserted
state: the empty Library, the populated Library, one file open, and a refused read.

| Real | Pinned |
| --- | --- |
| the launcher, the model from the vault (`mode auto`, key present), the gate, the loop, the container from the pinned image and its destruction | the sandbox image, `freebot-sandbox:u0.6` |
| the workspace directory the container mounts, and the file inside it | |
| the page, its stream, the oRPC route surface, the three refusals | |

The prompt asks the model to write a line carrying a nonce the driver minted at start, so the bytes
read back cannot have existed before this run and no committed fixture can hold them. Four further
facts are read outside the browser:

- the launcher's own line naming the workspace it mounted, which is the directory the driver made;
- the container that holds the run while it is parked, and its absence once the run has ended, one
  `docker ps` label census before, during, and after;
- the file's bytes as read by the driver directly from the host workspace;
- the literal request and response of `POST /rpc/list_files` and `POST /rpc/read_file`, with the
  bearer token redacted.

The refused state opens a symlink the driver made with `ln -s`, with the command recorded in the
artifact. Asking a live model to plant an escape is not this driver's to ask; the refusal it proves
is the same one a model's own symlink would meet.

## What remains

- **No download, no `Download all`, no copy path, no send-to-another-Bot.** `UX.md` section 11 names
  all four. This unit lands the read path they would build on.
- **Text only.** A file that is not UTF-8 text is refused by name; a preview that can render one is
  the Phase 2 half of that section.
- **No breadcrumb.** Opening a directory lists it with the pinned row still at the top, and there is
  no way back except the pinned row. One level of navigation is what the spec's controls ask for.
- **Grouping is by mtime.** `Today`, `This week`, and `Older` are computed from the file's own
  timestamp, so a file touched today moves to `Today`.
