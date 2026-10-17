# FreeBot UX

This is the product's page inventory and the flows that move a person between those pages. The reference is Grok Bot as the plan documents it in Part 1, from xAI's and Cursor's product documentation. Where this document says parity, Grok Bot's documented behavior is the spec. Where it says own, FreeBot chooses differently and the entry gives the reason.

Strings in backticks are text a user sees on screen. Phase tags come from the plan's roadmap in `/Users/yusufameri/.opencode/plan/freebot-plan.md` Part 6, whose phases are 0, 1, 1.5, 2, 3, 4, 5, 6, and 7. FreeBot calls Phase 1 MVP in this document, so the tag MVP means Phase 1.

Parity here means the interaction model, the page inventory, and the flow order. It does not mean copied assets, brand marks, or copy, and FreeBot keeps its own name and visual identity.

## How to read this

Each page gets the same six lines: purpose, regions, controls, states, the flows it owns, and the parity tag. A page whose surface divides along its own lines adds the sub-lines it needs under those names. The gap between this document and today's app is in "What exists today". The order the pages should be built in is in "Build order".

A page is only parity-verified when a reference capture of the Grok Bot equivalent exists and an image diff of the two passes. That capture set and its diff do not exist yet, so nothing in this document is parity-verified today. It is a specification, not a claim.

# The shell

Desktop is a three column layout. The sidebar holds Bots. The center column holds one conversation. The right pane holds details and the computer preview. The divider between center and right is draggable, and collapsing the right pane leaves a control to bring it back. Mobile has no right pane. It shows the Bot list, the conversation, and the Bot's profile as separate screens.

Sidebar, top to bottom:

- A search control and a new chat control, `+`.
- Pinned Bots, then the primary Bot, the starred one.
- A collapsible `Hidden Bots` group at the bottom.
- `Connect apps` in the footer.
- The account row. It opens the account menu with usage for the week, the plan, and a sign out item.

Right-clicking a sidebar row opens the same menu everywhere: `Pin`, and `Hide from sidebar`. Inside `Hidden Bots` the menu offers `Show in sidebar` instead of hide.

Own, and why. The sidebar's ordered rows, its user-created sections, which can be renamed or deleted, with an `Unassigned` group for Bots outside any section and a deleted section's Bots moved there, and the rest of the row menu, which is `Move to new section`, `Move to`, `Mark as unread`, `Rename Bot`, `Copy conversation ID`, and `Delete`, are FreeBot's own. Plan 1.1C documents pinning, hiding, and searching a conversation and says nothing about the sidebar's order or its section model. The rule that only the owner sees `Rename` is own in the same way, since the plan leaves ownership to the team edition.

Conversation header, left to right: the Bot's name, which opens conversation details, the share menu, and the computer preview.

Details pane tabs: `Computer`, `Details`, `Tasks`, `Library`, `Media`. Own, and why. Plan 1.1C documents the messaging surface and no pane tabs, so the split is FreeBot's own.

Two keyboard entry points exist at the shell level. `Cmd/Ctrl+K` opens the command palette, which matches Bots, settings, actions, and routines before it matches message text, and a quoted term restricts it to messages. `Cmd/Ctrl+Shift+F` searches Bots specifically. Both shortcuts are own, since the plan documents the search scopes, which are messages, Bots, group chats, files, and routines, and no key binding.

FreeBot owns one addition to the shell. The sidebar's footer carries the provider row, since a FreeBot install can hold several provider connections and the active one is worth showing at a glance.

# Pages

## 1. Welcome, then connect a provider

Phase: MVP. Parity: own.

Purpose. Get from an installed app to a running model, since FreeBot ships no subscription.

Regions. A short statement of what the app is. One primary control, `Connect a provider`. Below it, a quieter `Run in replay mode` for anyone who wants to see the product work before holding a key.

Controls. `Base URL`, `Model`, `API key`, `Save and test`. The test runs a real tool call through the model before it accepts the connection, which is where capability flags come from: whether the model calls tools, whether it needs a structured output fallback, and whether it can hold a multi turn conversation.

States. Empty, with `Connect a provider` as the only path forward. Testing, with the request shown as it runs. Passed, which shows the model's own reply from the test call. Failed, with the provider's own status code and message, since a 401, a 403, and a 429 mean three different things to a user.

Flows owned. Connect a provider.

Own, and why. Grok Bot bundles the model behind its own account, so it has a sign in page instead. FreeBot's first page has to establish a model, and the smoke test has to run before the first task rather than after the first failure.

## 2. First run

Phase: MVP. Parity: parity.

Purpose. Create the first Bot and start its computer.

Regions. A centered sequence with one question per screen. The Bot's name first, then what it is for, then a short list of suggested first tasks. The computer provisions in the background with `Starting your computer` and `Updating your computer` shown until it is ready.

Controls. `Create your own`, the suggested task chips, `Skip`.

States. Provisioning, ready, and failed, where failed offers `Try again` and `See the logs`.

Flows owned. Create a Bot.

## 3. Bots and the sidebar

Phase: MVP. Parity: parity.

Purpose. The list of everything a person owns, and the fastest way back into it.

Regions. The sidebar as described in the shell section.

Controls. Per row, the right-click menu above. Per row, an attention dot when a Bot needs an answer. A Bot row shows a working animation while its turn is in flight.

States. Empty, where the only row is the create control. Populated. Hidden, where rows only appear under `Hidden Bots`. Unread, where a Bot with unread activity carries a marker until it is opened.

Flows owned. None.

Own, and why. FreeBot shows a per Bot container state beside the name, because a Docker backed install can fail to start a container for reasons a user needs to see before they type. The attention dot on a row and the working animation while a turn is in flight are own too, since the plan documents neither.

## 4. New chat and the Bot picker

Phase: MVP. Parity: parity.

Purpose. Choose who to talk to, or make someone new.

Regions. A centered picker over the conversation column.

Controls. `Create new Bot`. Typing a name first turns the row into `Create "name" Bot`. Each existing Bot is a row. A `Search Bots` field filters once three characters are typed.

States. Idle, and `Creating...` on the row while the new Bot is made, without leaving the current conversation.

Flows owned. Create a Bot, Give a Bot a task.

Own, and why. The three character threshold before the search field filters, and the `Create "name" Bot` row that appears once a name is typed, are FreeBot's own. No plan section documents a picker's search threshold or its row labels.

## 5. The conversation

Phase: MVP. Parity: parity.

Purpose. The main page. Everything a Bot does shows up here.

Regions. The transcript, and the composer under it.

Transcript items, each one a card or a message:

- A user message, with attachments and their previews.
- The Bot's text, streamed as it arrives.
- A turn marker with what the Bot is doing: `Thinking it through`, `Working on your computer`, `Waiting on results`.
- A tool call card. The exact command, its status, and its output in a disclosure that opens when the result arrives.
- An approval card. See page 6.
- A file card or an image card, with a preview and a save control.
- A table that scrolls sideways when it is wider than the column.
- A code block with copy.
- A question card or a form card, when the Bot needs a value it cannot guess.
- A secret request card, which takes a value without putting it in the transcript.

Controls. In the composer, the text box, then `Send`, with `Shift+Enter` for a newline. `Attach`, which also accepts a paste and a drag and drop. `/` opens the skill picker. `@` opens the mention picker for Bots, groups, routines, and apps. A dictation control. A voice chat control, which only appears when the box is empty. `Stop now`, which ends the turn and any work the Bot handed to another Bot, and does not undo anything already done.

Controls. On a message, hover timestamps, reply, reactions, `Add to prompt` on a text selection, `Copy request ID`, `Download`, and `Scroll to bottom` when the transcript is long. A failed send offers `Resend` and `Delete`.

States. Idle. Working, which animates the Bot's avatar in a one to one chat. Needs attention, when a card is waiting. Unread. Done. Failed, with a reason and a retry control. Reconnecting, with a banner, after the event stream drops, and the transcript refills from where it left off.

Flows owned. Give a Bot a task, Read results and files, Stop a run.

Own, and why. The page keeps the current app's card vocabulary, since the run protocol already emits those facts. The gap is that today each fact renders twice, once on the card and once as a marker line below it. In the target, the card is the only place a fact appears. The turn marker's strings, `Thinking it through`, `Working on your computer`, and `Waiting on results`, are FreeBot's own copy rather than the reference's.

## 5b. Group chats

Phase: 4. Parity: own.

Purpose. Put more than one Bot in one conversation, so they can hand work to each other.

Regions. The group thread, a row per member, and the shared `/shared` path.

Controls. `Add a Bot`, per member `Remove` and `Pause`, and `Hand off`, which passes ownership of the turn to the named member.

States. Idle. Working, when one member holds the turn. Waiting on a Bot, when the turn is with a member that has not answered yet.

Flows owned. Start a group chat.

Own, and why. The plan decides multi-Bot coordination at Phase 3 and ships it at Phase 4, and it keeps each Bot in its own sandbox rather than the reference's one computer per account. FreeBot moves context between members through the group thread and the shared volume, which is why the page names `/shared` as a region.

## 6. Approval cards

Phase: MVP. Parity: parity.

Purpose. The gate. Nothing a model asks for runs until this card is answered.

Regions. Inside the transcript, at the point the Bot reached. The card shows what is proposed in plain words, the exact command behind a `View the full request` disclosure, and the scope.

Controls. `Allow once` and `Deny`, which are the MVP answers. `Always allow`, which writes a rule and shows `Rule added` with `Edit rule` beside it, is the phase 5 answer. When an ask-first rule caused the stop, the card says so.

States. Pending. Resolved with the decision recorded on the card. Expired, when an unattended run asked and nobody answered, which records that it did not run and may offer `Always allow this in the future` at phase 5. Pending approvals also surface as an attention dot in the sidebar and as a notification if that Bot has notifications on.

Flows owned. Approve or deny an action.

Own, and why. Grok Bot's card limits a decision to the proposed action. Plan 1.1I states that approvals govern the proposed action, not work already done. FreeBot keeps that, and adds a visible countdown when the run will time out, since the current app models an expiry and never shows it.

## 7. Bot details, including the soul

Phase: MVP for the soul, 3 for memory. Parity: own for the soul, parity for the rest.

Purpose. Everything about one Bot that is not the conversation.

Regions. The right pane, opened from the Bot's name or the sidebar menu.

Controls. The name, editable in place. An optional label under it. An avatar picker with `Bot`, `Generate`, and `Upload`. A notifications switch. The soul. Memory. A model override, which defaults to the account's active provider. A tool allowlist.

The soul is a text box holding the Bot's standing instructions: who it is, how it talks, what it always asks about, and what it never does. It is versioned, each save keeps the previous text, and the pane shows a diff against the last version with `Revert`. Rules that a user writes here and rules that `Always allow` writes are kept apart, because one is what the person wants and the other is what they once permitted.

States. Empty soul, with a suggested starter. Edited but unsaved. Saved, with the version count.

Flows owned. Set or edit the soul, Edit a Bot's memory.

Own, and why. Grok Bot's Bots carry a role and personality, and the plan documents no editable system prompt. That works when the model is the product's own. FreeBot's users bring a model and expect to edit the system prompt directly, so the soul is a first class field, and the chat path still works too, so a sentence in the transcript like `From now on, ask before sending any email` offers `Save to soul` on the message.

## 7b. Memory

Phase: 3. Parity: own.

Purpose. What one Bot carries forward between runs.

Regions. A list inside the details pane, grouped as `Facts`, `Preferences`, and `Work summaries`, each row editable and deletable.

Controls. `Add`, per row `Edit` and `Delete`, and `Clear memory`. A row shows what wrote it and when.

States. Empty. Populated. A write that a review rule held for approval, marked `Waiting on you`.

Flows owned. Edit a Bot's memory.

Own, and why. Plan Part 6 scopes memory to pgvector at Phase 3, and plan 5.2 finding 35 calls a memory write a persistent injection channel, so FreeBot shows each memory's origin and gates writes from a tainted turn. Grok Bot documents per-Bot durable memory and no surface for reading it.

## 8. Routines

Phase: 3. Parity: parity.

Purpose. Give one Bot a job on a schedule.

Regions. A `Routines` tab on the Bot, one row per routine, and a detail view per routine.

Controls. On the list, a per row switch for pause and resume. The right-click menu repeats `Pause`, `Resume`, `Test`, `Edit`, `Delete routine`.

Controls. On the detail, `Instruction`, which is what to do. `When to run`, which renders the schedule and any trigger in words. `Webhook`, when it exists, with the URL, the key, and the header, each clickable to copy. `Pause` and `Resume`. `Test`, which runs now, does real work, and consumes usage. `Edit`, which opens a message in the composer starting with `Edit your routine:`. `Delete routine` with a confirmation.

Run history. The last 20 runs per routine, each with its state, `Running`, `Succeeded`, or `Failed`, the failure reason when it failed, and when it ran.

Limits the page must show. 50 routines per Bot, 20 retained runs each, and schedules at least five minutes apart.

States. Empty, reading `Ask in chat to set a routine`. Populated. Paused. Running, with the test button reading `Running...`.

Flows owned. Schedule a routine.

Own, and why. A first run waits for the next scheduled time rather than running immediately, since a first run at the scheduled time keeps a routine's cost predictable.

## 9. Skills

Phase: 3. Parity: parity.

Purpose. Procedures written once and used by any Bot.

Regions. A library page, and an editor per skill.

Controls. The editor asks for when to use the skill, what it needs access to, the steps, how to check the result, what the output looks like, and where it must stop for approval. `Teach a task` opens a recorder that watches the computer's browser for up to ten minutes with no microphone capture, then drafts a skill from what it saw. The draft goes to a test run before it can be scheduled.

States. Empty. Draft, from teaching or from writing. Tested. Published. Paused.

Flows owned. None.

## 10. The computer

Phase: 2. Parity: parity.

Purpose. See what the Bot is doing on its machine, and step in when a step needs a human.

Regions. A preview in the right pane, and a full screen view from it. The full screen shows the desktop, with tabs for `Desktop`, `Files`, `Terminal`, `Browser`, and `Apps`. The five tabs are FreeBot's own arrangement, since plan 1.1D lists the desktop, the filesystem, the terminal, the apps, and a browser as capabilities of the computer rather than as tabs.

Controls. `Take control`, which flips the view out of `Watching` and gives the human the keyboard and mouse. `I'm done`, which hands it back. `Skip`, which declines the step. `Teach a task`, which records a demonstration. `Wake`, when the computer is asleep. `Skip` and `Wake` are own, since the plan documents no such controls.

When a person should take control. Passwords, passkeys, two factor prompts, CAPTCHAs, payment and identity checks. These are the steps FreeBot must never attempt, and the card that asks for help says which one it hit. Plan 1.1D lists password, 2FA, CAPTCHA, payment, and identity checks and not passkeys, so adding passkeys is FreeBot's own call.

States. `Connecting`, `Watching`, `Reconnecting`, `Couldn't reach the computer`, `Bot failed to respond`, `Update still running`, `Continue in background`. Recovery, in order: `Retry`, restart the app, `Recover computer`, `Update computer`, then `Reset computer`, which rebuilds from the last saved data and is the last resort since it discards what was installed since. The state strings and the recovery order are own copy, since plan 1.1D supports `Recover`, `Update`, and `Reset` and no other wording or order.

Flows owned. Watch the computer, then take it over.

Own, and why. Grok Bot runs one computer per account shared by all Bots. FreeBot's plan runs one sandbox per Bot by default with an optional shared volume, because the sandbox is a pluggable interface and per Bot isolation is cheaper to reason about. The page looks the same either way. What changes is the label, which reads `This Bot's computer` or `Shared computer`.

## 11. Files and workspace

Phase: MVP for the file list, 2 for previews. Parity: parity.

Purpose. The durable output of a run, in one place.

Regions. The `Library` tab, grouped as `Today`, `This week`, and `Older`. A file view. Inside a Bot's computer, the `/workspace` path is the durable area and it is pinned at the top of the file list.

Controls. Open a preview, download one file, `Download all`, and copy a path. A file can be sent to another Bot as an attachment.

States. Empty. Loading. A preview that cannot render, which offers a download instead.

Flows owned. Read results and files.

## 12. Apps and connectors

Phase: 5. Parity: parity.

Purpose. Let a Bot reach services without clicking around a browser.

Regions. A gallery page, and a detail page per app.

Controls. On the gallery, a search field that matches descriptions as well as names, category chips, a `Recommended for you` row, a `Team apps` section when a team exists, and a `Your apps` section split into `Installed` and `Private skills`.

Controls. On a detail page, `Add`, which starts sign in when the service needs it. `Authorize`, `Reconnect`, `Reopen`, and `Retry`, one per failure shape. `Remove`. `Accounts`, with `Add another account`. Per tool switches.

States. `Added` but not signed in. `Connected`. `Disconnected`. `Needs auth`. `Disabled by team admin`, which is not fixable by the user.

Secrets. A Bot can hold named values. `Add secret` takes a variable name, a description, and a value. The list shows the name and the description and never the value, and `Replace value` is the only way to change one.

Flows owned. Connect an app and add a secret.

Own, and why. The gallery's `Recommended for you` row, its `Team apps` and `Your apps` sections, the `Installed` and `Private skills` split, the failure controls one per shape, and the five connection states are FreeBot's own. Plan 1.1E documents `Connect apps` and OAuth authentication and no gallery layout or state list.

## 13. Rules and the approvals ledger

Phase: 5. Parity: parity.

Purpose. Show what a person has already permitted, and let them take it back.

Regions. A list of rules, each one the sentence it came from, the Bot it applies to, and when it was added.

Controls. A switch per rule. `Delete rule`. An `Automatic review` switch, with a rule list where each line is either `Ask first` or `Allow automatically`. `Ask first` wins every conflict. A rule a team admin set reads `Required by your admin` and cannot be edited.

States. Empty, which is the safe default. Populated. Conflicted, where the page marks the losing rule and says which rule won.

Flows owned. None.

Own, and why. FreeBot keeps the ledger as a first class page because the current run protocol already emits grant states, and a user who has just chosen `Always allow` needs to find that decision again. The `Required by your admin` string is own copy, since plan 1.1L documents enforced team rules and no wording for them.

## 14. Settings

Phase: MVP for providers and notifications, 1.5 and later for the rest. Parity: parity for the layout, own for the provider pane.

Purpose. One place for the install, the providers, and the account.

Regions. The panes, in order. `Providers`, `General`, `Computer`, `Usage`, `Notifications`, `Updates`, `Danger zone`. The seven panes and their order are FreeBot's own, since no plan section documents a settings layout.

Controls. Named for each pane below.

States. A pane opens on its saved values. A provider key that failed its test reads `Untested` before it is used for a run.

Flows owned. None.

Providers. One row per connection: name, base URL, model, the capability flags the test found, `Test again`, `Set as active`, `Remove`. A key that fails its test is marked before it is used for a run.

General. Theme, accent, language, time zone. `Execution on this computer`, with `Ask every time`, `Always allow`, and `Never allow`, kept separate from automatic review. A security key control.

Computer. `Update computer`, `Reset computer`, `Remove computer`, and whether traffic routes through this machine.

Usage. Cost so far, the cap, and what happens at the cap. `packages/core/src/run-usage.ts` already computes a cost per token and holds the cap check. The store records usage events (`packages/core/src/run-store.ts:331`) and nothing in the run loop consults the cap check yet, so the pane reads from that once it is wired.

Notifications. Which events notify: approvals, routine results, run finishes, Bot replies, and voice memos.

Danger zone. Delete all data, with the exact list of what goes and what survives.

## 15. Search and the command palette

Phase: MVP for the palette, 1.5 for full search. Parity: parity.

Purpose. Reach anything without knowing where it lives.

Controls. `Cmd/Ctrl+K` for the palette, which matches Bots, settings, actions, and routines before messages, and treats a quoted term as a message search. `Cmd/Ctrl+Shift+F` for Bots. The full search page scopes results as `Messages`, `Bots`, `Group chats`, `Files`, `Routines`, and `All`.

States. Empty query. Results with the matched term marked. No results.

Flows owned. Find something.

## 16. Notifications and attention

Phase: MVP. Parity: parity.

Purpose. Tell a person when a Bot needs an answer, without pulling them back for anything else.

Regions. Notices above the composer, dismissible one at a time or all at once, each with `Copy request ID` where the notice came from a failed request. Usage and cap banners with `Set credit limit` and `Raise the cap`.

Controls. Per notice, `Dismiss` and `Copy request ID` where the notice came from a failed request, plus `Dismiss all`. On a cap banner, `Set credit limit` and `Raise the cap`.

States. Quiet, with no notice. A notice shown. Dismissed. Capped, when the spend cap stops a run. Separately, the attention states a Bot can hold are working, waiting for you, unread activity, and idle.

Flows owned. None.

Own, and why. Grok Bot bills through its own usage meter. FreeBot's cap is a local spend ceiling over the provider the person already pays, so the banner raises that ceiling and there is nothing to upgrade.

## 17. Activity log

Phase: 1.5. Parity: own.

Purpose. Answer what happened to a run, after the fact.

Regions. A table of runs and decisions with the time, the Bot, the run id, the status, the cost, and the decision count.

Controls. Filter by Bot, by status, and by date. Open a run to its own page with the full transcript of frames and the reason it ended.

States. Empty. Populated. Run open.

Flows owned. None.

Own, and why. Grok Bot keeps this in an admin console for teams and in `Run history` per Bot for routines. A local single user product needs the run history somewhere a person can reach it, and the protocol already keeps an ordered log per run.

## 18. Later, for teams

Phase: 5 and 7. Parity: parity.

Purpose. The pages the reference has that wait for a team edition.

Regions. Team member management, connector policy, network policy with an allowlist, team secrets, enforced review rules, an audit log with export, and per member usage.

Controls. The admin controls plan 1.1L documents, which are the network policy allowlist, the connector policy, team secrets, the enforced review rules, and the MCP allowlist.

States. Empty. Enforced, where a rule a team admin set reads `Required by your admin` and cannot be edited.

Flows owned. None.

Own, and why. The seam to leave open now is that every rule and every Bot carries an owner, so a team edition is a filter rather than a rewrite.

## 19. Mobile and the second surface

Phase: 6. Parity: parity.

Purpose. The same Bots and threads on a phone, without the desktop's panes.

Regions. Three screens, which are the Bot list, the conversation, and the Bot's profile. A thread opened on one surface is the same thread on the other, and it resumes where it was left. Push arrives through the opt-in relay at Phase 6, and with no relay the in-app badge carries the notice.

Controls. The composer, the approval cards, and the profile's own controls. The right pane and the full screen computer view stay desktop-only, along with some advanced controls and teach-by-demonstration, per plan 1.1N.

States. Foreground. Backgrounded. No network, where the thread shows what it last held and picks up when the connection returns.

Flows owned. None.

# Flows

## A. Connect a provider

1. The app opens on `Connect a provider` when no provider is saved.
2. The person types a base URL, a model, and a key. The key goes to the vault path and never to the process environment.
3. `Save and test` sends one request with a tool definition and reads the reply.
4. A tool call in the reply marks the connection capable and stores the flags. A reply with no tool call stores the weaker capability and offers a structured output fallback.
5. A refusal shows the provider's status code and message, and the connection is saved but marked untested.
6. The first Bot is offered immediately after a passing test.

## B. Create a Bot

1. `+` in the sidebar, or `Cmd/Ctrl+N`.
2. `Create new Bot`, or type a name and take `Create "name" Bot`.
3. The Bot opens with an empty conversation and introduces itself.
4. The person gives it a job in the first message, or edits the soul first.
5. Name, label, and avatar are set from the details pane.

## C. Give a Bot a task

1. Open the Bot from the sidebar.
2. Type in the composer. Reference a skill with `/` and another Bot, routine, or app with `@`. Attach files, paste, or drag them in.
3. Send.
4. The sidebar shows the Bot working, and the transcript shows the turn marker.
5. Sending another message redirects the turn. `Stop now` ends it and does not undo completed actions.
6. Results arrive as cards: files, images, tables, links, or a question when the Bot needs a value.

## D. Approve or deny an action

1. The Bot stops and posts an approval card naming the command in plain words.
2. The person reads the scope, or opens `View the full request` for the exact call.
3. `Allow once` issues a grant for that call only. `Always allow`, which arrives at phase 5, writes a rule and shows `Rule added`. `Deny` records the refusal with `user_denied` and the call does not run.
4. An allowed call runs in the computer and its output appears on the card.
5. A denied call leaves the card showing the refusal, and the run continues to its end.
6. A pending approval older than its window expires and records that it did not run.

## E. Set or edit the soul

1. Open the Bot's details from its name in the header.
2. Edit the soul text, or take a suggestion offered by `Save to soul` on a sentence in the transcript.
3. `Save` writes a new version and shows the diff against the last one. `Revert` restores it.
4. The next run uses the new text. Runs already finished keep the version they ran with.

## F. Schedule a routine

1. Ask the owning Bot in chat: `Every weekday at 08:00, run this and post the result here. Do not contact customers.`
2. The Bot creates the routine and reports the next run and who receives the output.
3. The person reviews the owner, the schedule and its time zone, the input, the output, and the approval boundary.
4. The routine appears under the Bot's `Routines` tab, where the switch pauses or resumes it.
5. `Test` runs it now. It does real work and counts against usage.
6. A webhook routine shows its URL, key, and header, each clickable to copy.

## G. Connect an app and add a secret

1. `Connect apps` from the sidebar footer, or follow a `Connect` card inside a conversation.
2. Search or pick from a category. `Add` starts sign in when the service needs it.
3. Finish the provider's sign in in the browser. The app returns and the row reads `Connected`.
4. A stall offers `Reopen`, then `Reconnect`, then `Retry`.
5. For a value the Bot needs but a person must keep, `Add secret` takes a name, a description, and the value. The value never appears in the transcript or the log.

## H. Watch the computer, then take it over

1. The preview in the right pane shows the desktop while a run is in flight.
2. Open it full screen to keep watching.
3. When the run needs a human step, the card names it and offers `Take control`.
4. Complete the step. Press `I'm done` to hand the machine back.
5. Tell the Bot to continue, or let it continue on its own.

## I. Read results and files

1. Result cards in the transcript preview what the Bot produced.
2. `Download` takes one file, `Download all` takes the set.
3. The `Library` tab groups everything by day. The file list inside the computer pins `/workspace`.

## J. Find something

1. `Cmd/Ctrl+K` and type. Bots, actions, and routines rank above messages.
2. Quote a term to search messages only.
3. Open a result and land in the conversation at that point.

## K. Stop a run

1. `Stop now` ends the current turn and any work it handed off.
2. The run reaches `cancelled` and the transcript keeps what happened before the stop.
3. Work already completed stays done. Only the unfinished part is abandoned.

## L. Edit a Bot's memory

1. Open the Bot's details from its name in the header, then its memory list.
2. `Add` a row, or `Edit` or `Delete` one that is already there.
3. A write a review rule holds for approval stays in the list marked `Waiting on you` until it is answered.
4. The next run reads the new set; runs already finished keep what they read.

## M. Start a group chat

1. `+`, then choose `New group chat` and pick the Bots that join.
2. The group thread opens with one row per member, and `@` mentions any of them.
3. `Hand off` passes the turn to a named member, and the sidebar shows which Bot is working.
4. `Add a Bot` and `Remove` change the membership without ending the thread, and `Pause` takes one member out of the rotation.

# Vocabulary

| Word | Meaning |
| --- | --- |
| Bot | A named agent with its own instructions, memory, and computer. |
| Primary Bot | The starred Bot. It is the one an outside mention routes to. |
| Soul | The Bot's standing instructions. The system prompt, in one editable field. |
| Thread | One conversation with one Bot. |
| Group chat | One thread with more than one Bot. Members share context through it. |
| Run | One execution from a prompt to a terminal state. |
| Turn | One model response inside a run, including the calls it asked for. |
| Approval | A gate on a proposed call. It has three answers. |
| Rule | A standing permission written by `Always allow`, or a limit written by a person. |
| Grant | The one time permission an allow produces. It is consumed by the call it was issued for. |
| Computer | The sandbox container a Bot works in. |
| Take control | Handing the keyboard and mouse from the Bot to the person. |
| Skill | A reusable procedure, shared across Bots. |
| Routine | A skill on a schedule for one Bot. |
| Trigger | An event that starts a routine. |
| Connector, or app | An integration a Bot can call. |
| Secret | A named value the Bot can use and never display. |
| Workspace | `/workspace` inside the computer. The durable file area. |

# What exists today

The app is one page serving one conversation. It works end to end for a single run, and it is roughly page 5 of this document with the rest missing. The concrete limits, with their locations:

| Today | Where | The target |
| --- | --- | --- |
| One bot, hard coded as `bot-local` | `apps/server/src/run-service.ts:187` | Bots are records a user creates and names. |
| A fresh thread per run, named `thread-<runId>` | `apps/server/src/run-service.ts:186` | A thread holds many runs and lasts. |
| One event log shared by every run, with no thread scoping | `apps/server/src/run-service.ts:90` | One log per thread, and the page subscribed to its thread alone. The range it requests already works, since `apps/server/src/api-server.ts:108` parses `last_seen_seq` and `apps/server/src/run-service.ts:150` streams from it, with `log.since(cursor)` at `:158`. |
| No way to start a second conversation | `apps/web/host/index.html:119` | A Bot list and many threads. |
| No cancel control, though the route exists | `apps/server/src/router.ts:41` | `Stop now` in the composer. |
| No follow up turn in the same run | `apps/web/host/main.ts:53` | A composer that keeps taking messages. |
| Each fact renders twice, on the card and as a marker line | `packages/ui/browser/render.ts:119-269` | The card is the only place a fact appears. |
| An approval expiry that is never shown | `packages/ui/src/thread.ts:44` | A visible countdown. |
| No attachments, no search, no settings, no routines, no computer view | none | Pages 1 through 19 above. |
| Product copy that still says no model is attached | `apps/web/host/index.html:105` | Copy that matches what the app does. |

# Parity verification

The reference for parity is a capture set, not a description. Before any page is built to match, the corresponding Grok Bot screen has to be captured, and the capture becomes the baseline that an image diff runs against. The visual parity playbook in the poteto-mode skill states the rule, which is no baseline, no parity claim. The research behind this document came from documentation rather than screenshots, and the documentation is silent on spacing, color, typography, and iconography. Those details need capture.

Two standing orders already apply to every page built from this document. Every user-visible change gets a recording, not only a screenshot. Every PR carries screenshots of each key state the change touches.

# Build order

The order below follows the dependency chain rather than the page order. Each step is a unit with its own evidence.

1. Bots and threads as records. This is what makes the sidebar, the picker, and page 5 real, and it is the blocker for everything else. The current hard coded bot and per run thread are the two lines to delete.
2. The shell, with a sidebar, a Bot switcher, and a thread list, keeping the existing conversation rendering.
3. The soul, with versions and a diff, plus the details pane.
4. Routine records and the scheduler, with the routines tab, run history, and the caps.
5. The computer view, once a person can watch and take over.
6. Apps, secrets, and the rules ledger.
7. Search, notifications, and the activity log.
8. Skills, then teaching. Then the team pages, which are a filter over owners rather than a new model.
