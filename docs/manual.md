# Bridge manual

This manual gives the rules that connect the tables in `README.md`. It covers the watch, the wake-up, the tools and commands, the budget, and the environment. Every claim matches the shipped code in this repository.

## What the bridge is

Pi drives OpenCode threads over HTTP. A tool call sends a brief to the local OpenCode service and returns before the thread finishes. The bridge holds its own SSE connection to the service and waits for a settle event. When the thread settles, the bridge opens a later Pi turn with one message that carries the answer. A wake-up is that message. Pi does not hold a turn open to poll the thread; a backstop poll covers dropped frames, and the main Pi turn stays free.

## Install and enable

The package loads `opencode-bridge.ts` from its root. `package.json` names that file in `pi.extensions`. Install the package with `pi install npm:@barty13/pi-opencode-bridge`, or with a git URL, or with a path to a clone. A running Pi keeps the code that it loaded, so restart Pi or resume the session after an update.

The OpenCode service must run. Start it with `opencode serve --service`. The command `opencode service status` prints the URL, for example `http://127.0.0.1:49374`. The bridge reads the URL from that command when it first connects, and again after a connection failure.

The password sits in `~/.config/opencode/service.json`, key `password`. `OC_SERVICE_FILE` points at another file. The bridge sends HTTP Basic auth as `opencode:<password>` on every request. It never reads a provider key.

The bridge does not use `opencode api`. That command makes one request and exits. `GET /api/event` through it returns nothing, so it cannot hold a stream. The bridge opens `/api/event` itself with `accept: text/event-stream`, asks for the event types that it needs, and reconnects after a clean end or an error. A reconnect rescans the open asks and sweeps the armed threads, because the stream can drop frames.

Pi 1.4 or newer is required. The live columns need macOS and Ghostty 1.3 or newer; set `OC_PANES=0` to turn them off. Print, JSON, and RPC runs never open a column.

## Thread root sandbox

`OC_ROOT` sets the thread root. The code default is the working directory at Pi start (`process.cwd()`). The examples use `~/Pi`; set `OC_ROOT` to the tree that you want. The bridge resolves the root with `realpathSync` at load. A missing root does not stop the load; a call that needs the root reports the missing directory.

Two checks keep threads inside the root. `directory()` handles a create path. It joins the input to the root, refuses a path outside the root, requires the path to exist, and compares the real path. `oc_open` and `oc_fanout` use it. `assertLocal()` handles a thread id. It reads the thread's `location.directory`, compares the real path, refuses a thread outside the root, and remembers the result for that thread. Every tool that takes a session id calls it. `oc_attach` reads the thread row for `underRoot()` first, then calls `assertLocal()`; every other session tool calls `assertLocal()` before any other service call. `oc_models` takes no session id.

A thread outside the root is refused with `Thread ses_… sits in <dir>, outside <root>.` `directory()` and `assertLocal()` compare real paths, so a symlink cannot pass a thread outside the root. The list in `/oc` and the delete pass in `/oc-clean` filter the raw reported directory with `underRoot()`.

The root must be a git repository for `oc_rewind` to restore files. The bridge does not check this; the service does. In a root without git, the stage answers HTTP 200 with `files: []`, the working tree does not move, and the receipt says `no git history for this root, messages reverted, files untouched: <paths>` when the digest named paths; with no paths it says `files restored: none`. The message half still works: `commit` removes the run's messages after the target, `clear` drops the stage, and `branch` forks. The digest still names the paths that the run touched. Make the root a git repository before the run if you need file restore. This machine uses `~/Pi`, a git repository since 2026-11-05 (`655bfb9`).

Threads can write files. Point `OC_ROOT` at a scratch tree that you own.

## The watch lifecycle

A watch is the bridge's promise of one wake-up. It holds a floor, a deadline, and a steer count. The bridge arms a watch before it posts a prompt, because a run can settle in milliseconds. The floor is the wall-clock time at the arm. The deadline is that time plus `OC_WATCH_TTL_S`. A new send replaces the watch and resets the steer count. The bridge holds at most 32 watches; an arm at the ceiling throws `32 threads in flight; wait for one to settle with oc_wait.`

`oc_attach` arms a running thread with a floor of `time.busy - 1`, so the answer row of the run in flight is inside the window. An idle thread gets no watch. `oc_wait` on a running thread with no watch arms it with a floor of `time.idle`, or 0 when the thread has no idle row.

OpenCode keeps the old `time.idle` when a new run starts. Therefore `busy > idle` is the only in-flight signal. A run is live when `Number(row.time.busy) > Number(row.time.idle)`. Any other test reports the previous run, or calls a live run idle. The bridge uses this test in attach, steer, restore, `/oc-budget`, and `/oc-clean`.

The settle window takes rows with `time.created` strictly greater than the floor, and at most `time.idle + 1`. A row that carries the floor is out. This is why a floor set on a row drops that row. The `+1` keeps the idle row that carries the run. The bridge finds the newest assistant row for the answer, the idle row for the outcome, and the first row with an error as a fallback for the error line. A compaction hides the context before it, so the digest starts after the newest compaction row.

The event stream reports `session.execution.succeeded`, `session.execution.failed`, and `session.execution.interrupted`. The bridge claims the thread, reads the window, and drops the watch on a real settle. A backstop poll reads each armed thread every `OC_BACKSTOP_MS` and covers a dropped frame. A read that finishes after a new send or a stop does not spend the new watch. A thread with no settle in the window keeps the watch.

A watch that passes its deadline settles as unknown. It does not report a running outcome or an empty ask list. The report is:

```
outcome: unknown (watch expired; restart with oc_send to read the record)

error: none

answer: (none)

open asks: unreadable
```

`steers N` appears when the watch counted at least one steer. The watch is dropped after the report. The record stays on the service: `oc_read` reads it, and `oc_send` starts a new run with a new watch. Arm only a thread that can settle.

A Pi reload restores watches from the `oc-armed` session entry. The entry holds `fanSeq` and one row per watch: `session`, `floor`, `steers`, and `attached`. On start, the bridge reads the thread. A failed read keeps the watch, because the read may hide a live run. A real idle row drops the watch, because the run settled while Pi was down. A real busy row restores the watch with the saved floor and a fresh TTL. The fan-out counter also restores, so a `fan_<n>` id does not repeat.

`oc_stop` drops the watch and interrupts the run. `oc_stop` with `detach: true` drops the watch and leaves the run going. A rewind refuses while a watch is armed.

## Anatomy of a wake-up

The bridge sends one message per debounced batch. `OC_DEBOUNCE_MS` sets the batch window. Two settles inside the window produce one message. The message is a follow-up, so Pi queues it for the next turn when a run is active. A run that the human aborted holds the batch until the next human-started run settles; the head then says `settled while the run was cancelled`. A compaction holds the batch until the compaction ends. Print and JSON modes do not send a wake-up. A reload drops the in-memory batch and restores the watch from `oc-armed`; a settle that landed during the reload can have no wake-up when the thread is already idle at start. In those cases `oc_wait` collects the settle.

The message has this order:

| Block | Content |
| --- | --- |
| Head | `One OpenCode thread settled:`, `N OpenCode threads settled:`, or `Fan-out fan_<n> settled:`. |
| Entry | `- <session> <title>:` for each settle. The title is omitted when it is empty or equal to the session id. |
| Outcome | `outcome: <value>`. An expired watch adds ` (watch expired; restart with oc_send to read the record)`. |
| Error | `error: none`, or `error: <message>`. A `retryAfterMs` adds `, retry after N min`. |
| Steers | `steers N`, only when a live watch counted at least one steer. |
| Answer | `answer:` and the text, or `answer: (none)`. |
| Asks | `open asks:` and one block for each ask, `open asks: none`, or `open asks: unreadable`. |
| Digest | The run ledger, when the report read the wide window. |
| Tail | `Read a thread with oc_read, then continue the task that started it.` |

A full message:

```
One OpenCode thread settled:
- ses_… refactor-parser:
  outcome: succeeded

  error: none

  answer:
  The parser now accepts the new syntax. The test sits in test/parser.test.ts.

  open asks: none

  digest 5 calls (5 ok) · shell 5 · fails: none · files: none

Read a thread with oc_read, then continue the task that started it.
```

The answer body passes through `truncate`: it stops at 4000 characters and ends with `… truncated; read with oc_read offset=4000`. `oc_read` with `offset` reads the next part. A form detail has its own 4000-character cap; a permission detail stops at 1200 characters. The whole `oc_read` result stops at 24,000 characters.

`steers N` comes from the live watch. A record read with `since` and no live watch omits the count, because the bridge cannot know it. A fan-out report has no steer count.

`outcome` reads `unknown` when the fresh window has no idle row and the session row has no outcome, or when the watch expired. The bridge does not map an unknown outcome to `succeeded` or `failed`.

A fan-out report uses a different body: `outcome: fan-out N models`, then one section per member in caller order, then the judge verdict. Section 7 gives the shape.

### Digest line

The digest starts after the newer of the watch floor and the newest compaction row, so a compacted context does not show calls from before the compaction. The bridge reads the 200-row window once for the report. The line gives the call count and the ok/error split, the calls per tool name, the first five failures (tool name and first error line, each reason capped at 120 characters), the open ask count when it is above zero, and the touched paths (edits before reads, at most ten). A running call adds `unfinished: N`.

The line stays at or below 400 characters. The path list shrinks first, then the failure list. A last-resort cut keeps one failure. A watch that expires has no digest. On the backstop path, a wide read that fails falls back to the 8-row settle, so that report has no digest.

## Supervision

The bridge has two modes. `supervised` is the default. `unsupervised` sends each ask to the model in this Pi session. `/oc-auto` selects unsupervised and flushes queued asks. `/oc-accept` selects supervised. The flag `--oc-auto` starts a session in unsupervised mode. Every session start resets the mode to supervised and drops per-thread state, so an old run cannot answer for a new session.

| Ask | Supervised, TUI | Supervised, no UI | Unsupervised |
| --- | --- | --- | --- |
| Permission | Dialog with `Allow this request?`; the answer is `once` or `reject`. | Message to this session when idle; queue when busy. | Message to the model. |
| Form | Message to this session when idle; queue when busy. A form needs field values, so it never uses a yes/no dialog. | Message when idle; queue when busy. | Message to the model. |
| Rewind file stage | Dialog before the stage. | Error; nothing changes. | Posts through. |
| Rewind commit with `files: false` | Dialog at the commit. | Error; the stage stays. | Posts through. |

Unsupervised mode does not approve a request by itself. It sends the ask to the model, and the model must call `oc_reply` with a decision or a form answer. The ask message starts with `[opencode]` and uses `deliverAs: "steer"`. A settle uses `deliverAs: "followUp"`.

A file rewind asks before it stages because `POST /revert/stage` with `files: true` rewrites the working tree at once. The question names the target and the paths from the digest. A refusal calls no stage and changes nothing. The same question covers a requested commit, because a file stage and its commit are one decision. A `files: false` stage keeps the files and asks at the commit.

Without a UI, a supervised file stage stops with `supervised stage needs a decision in a Pi TUI; nothing changed`. A supervised commit stops with `the revert stays staged; the commit needs a decision in a Pi TUI`; for that commit, the stage stays staged. A permission or form ask still reaches the session through the message path when the session is idle; when the session is busy, it waits in the queue. The dialog path needs a TUI; a form never uses a yes/no dialog.

`permissionsJson` on `oc_open` sets a per-thread OpenCode ruleset. It does not change the bridge mode.

## Tools

### `oc_models`

Lists the models that the service serves for delegation. It runs `opencode models` and keeps ids with the `opencode-go/` prefix or the `-free` suffix. It reads `GET /api/model` for each variant ladder and list price. Read it before `oc_open`, because a model id must be on this list.

Parameters: none.

Receipt:

```
opencode-go/glm-5.3-flash  variants: low|high|max
opencode-go/deepseek-v4.1-flash  variants: low|high|max
opencode/an-example-free  variants: none
```

`variants: none` means the model takes no variant. `variants: unknown` means the ladder read failed. A `retention:` label appears when `OC_RETENTION` matches the id suffix.

Fails when `opencode models` fails; the tool returns the command error. A failed `/api/model` read is not fatal: the ladder prints `unknown`, and a requested variant is accepted because the ladder is undefined. A model that both providers serve is ambiguous; `oc_open` refuses it until the caller adds the provider prefix.

### `oc_open`

Opens a thread for one task. The create path goes through `directory()`, so a subfolder must exist under the root. The tool checks the budget before it creates the thread. With a `brief`, it arms a watch and posts the prompt. With no `brief`, the thread exists and has no watch; the next `oc_send` arms one.

Parameters: `model` (string, required), `variant` (string, optional), `title` (string, required), `brief` (string, optional), `directory` (string, optional), `permissionsJson` (string, optional).

Receipt:

```
ses_…
brief sent, wake-up armed
```

With a compaction:

```
ses_…
brief sent, wake-up armed
compact ordered at 612k
```

No brief: the receipt is the session id alone. `variant` defaults to `high` when the ladder offers it. A requested variant must be on the ladder; a model with no ladder accepts the request. `permissionsJson` is a JSON ruleset, for example `[{"action":"*","resource":"*","effect":"ask"}]`.

Fails when the model is not on the list, the id is ambiguous, the variant is not on the ladder, the directory is missing or outside the root, the budget ceiling refuses the open, the watch ceiling refuses the arm, or the brief POST fails. A failed brief keeps the thread id and returns `brief failed: <message>`. A 4xx drops the watch; a timeout keeps it, because the service may still run the prompt. A failed compaction does not stop the prompt. The receipt still says `compact ordered at N`; the bridge sent the order and did not wait for a result. Invalid `permissionsJson` throws before the create.

### `oc_send`

Hands an instruction to a thread and returns. It checks the budget, adds the thread to the delegated set, arms a watch, and posts the prompt. A successful send removes a pending batch entry for that thread, so an older settle does not wake the model after the new instruction. The settle opens a later turn.

Parameters: `session` (string, required), `text` (string, required).

Receipt:

```
sent; the settle will open a turn, keep working
```

With a compaction:

```
sent; the settle will open a turn, keep working
compact ordered at 612k
```

`compact ordered at N` appears when the newest answer size is above `OC_COMPACT_TOKENS`. The bridge posts `/compact` with `delivery: "steer"` before the prompt. A refused compaction does not stop the prompt.

Fails when the thread is outside the root, the budget ceiling refuses the send, the watch ceiling refuses the arm, or the prompt POST fails. A 404 drops the watch. A 4xx that is not 404 drops the watch when no earlier watch exists; a timeout keeps it, because the service may still run the prompt. A 409 from a run that the bridge did not arm leaves no watch.

### `oc_wait`

Collects a settle inside the current turn. Use it when no wake-up can arrive: print mode, JSON mode, a settle that landed during a reload, or a turn that needs the answer before it continues. It waits on the same detector as the wake-up, so a collected settle does not wake the model twice.

Parameters: `session` (string, required), `since` (number, optional), `timeoutSec` (number, optional). `timeoutSec` defaults to `OC_WAIT_MAX_S` and cannot exceed it.

Receipt:

```
outcome: succeeded

error: none

answer:
The parser now accepts the new syntax.

open asks: none

digest 5 calls (5 ok) · shell 4 · read 1 · fails: none · files: src/parser.ts
```

`since` reads the record after a Unix-ms point and does not wait. `0` reads the whole record. Omit `since` to start from the current watch. A thread with no watch and no `since` gets a watch when it is still running, so the call can wait for its settle; at the watch ceiling, the call reads the record instead.

`still running after Ns; the watch stays armed` means the timeout passed and the watch remains. `no settle after N; ...` means the record has no settle after that point. `already reported: ...` means the wake-up or an earlier `oc_wait` already carried that run; `oc_read` shows the record. `thread is gone` and `thread unreadable` are errors. `wait cancelled; the settle stays queued` means Pi aborted the call; the wake-up still carries the settle.

A fan-out member waits for the composite report. A `since` read does not wait; it returns the newest settle after the point, or `no settle after ...`.

### `oc_read`

Shows the latest messages. It skips `idle` status rows when other rows exist, so `limit: 1` returns the answer. `parts: "full"` adds reasoning and tool input, status, result, and error. Each message body stops at 4000 characters; `offset` skips characters in each body. The whole result stops at 24,000 characters.

Parameters: `session` (string, required), `limit` (number, optional; 1 to 25, default 6), `parts` (`text` or `full`, optional), `offset` (number, optional).

Receipt:

```
[user] Add a test for the parser.

[assistant stop] tokens in/out/reasoning 1200/300/0, cache 0, cost 0.0012
Done. The test sits in test/parser.test.ts.
```

With `parts: "full"`, a tool call reads `[tool read completed] input={"path":"src/parser.ts"} result=...`. A failed tool adds `error=<message>`.

Fails when the thread is outside the root or the message read fails. A body past the offset prints `(no text past offset N, body is M chars)`.

### `oc_steer`

Corrects a running thread in place. The steer applies at the next step boundary. The tool reads the thread first: if `busy <= idle`, it refuses and posts nothing. A busy thread with a watch accepts the steer and does not re-arm; the watch still gives one wake-up and counts the steer. A busy thread with no watch accepts the steer with no wake-up. The service accepts any number of steers; each applies at its own boundary.

Parameters: `session` (string, required), `text` (string, required).

Receipts:

```
steer admitted at 14:03:07 · applies at the next step boundary
steer admitted (no watch, no wake-up)
```

Fails with `run already settled; oc_send starts a new one` when the run is idle. The tool does not send a steer to an idle thread, even though the service would start a new run; use `oc_send`. Fails with `a send is in flight; retry oc_steer` when the thread has a watch and a prompt POST is open. `steer refused: HTTP 409; the run stays` means the service rejected the steer and the run continues. Any other service error is thrown. The settle body shows `steers N` when the watch counted at least one steer; a record read with no live watch omits it.

### `oc_reply`

Answers one open permission or form ask by id. The tool reads the open asks first, so it knows the kind. A permission needs `decision` (`once`, `always`, or `reject`). A form needs `answerJson`, a JSON object keyed by the form's field names.

Parameters: `session` (string, required), `id` (string, required), `decision` (string, optional), `answerJson` (string, optional).

Receipts:

```
permission per_… -> once
form frm_… answered
```

Fails with `<id> is not open on <session>. oc_wait lists its open asks.` when the id is not open, and `Cannot read the asks on <session>. Retry oc_reply.` when the ask read fails. A settled ask answers `<id> is already settled or gone. Read the thread with oc_read.` An invalid form answer prints the JSON error. A permission without a decision and a form without `answerJson` fail before any POST.

### `oc_stop`

Interrupts a running thread, or drops its watch. It removes the watch before the interrupt, so the interrupted event does not open a turn. A settle that the stream missed sits in the batch; this call carries it instead of losing it. If the interrupt POST fails, the watch and the queued settle go back.

Parameters: `session` (string, required), `detach` (boolean, optional).

Receipts:

```
interrupted
no run to interrupt
detached; the run keeps going
no watch to detach
```

With a queued settle:

```
no run to interrupt

The run had already settled:
outcome: succeeded
...
```

Fails when the thread is outside the root or the interrupt POST fails. `detach: true` never posts `/interrupt`; it drops the watch, drops a queued settle for that thread, and leaves the run going.

### `oc_attach`

Adopts a thread that the bridge did not open, for example a TUI thread or one from an earlier Pi session. It checks `underRoot` and `assertLocal`. A running thread gets a watch with the floor just behind its run; an idle thread gets no watch. The next `oc_send` arms an idle thread. A second attach on a watched thread returns `already armed: <session>` and does not change the watch.

Parameters: `session` (string, required).

Receipt:

```
attached ses_… "attach-probe"
model: opencode-go/glm-5.3-flash variant default · 8k tokens · open asks: none · running
```

An idle thread adds:

```
attached; idle, watch starts with your next oc_send
```

Fails when the thread is outside the root or the status read fails. An ask read failure prints `open asks: unreadable` instead of a count. `/oc` marks an adopted thread `attached`; a reload restores that mark.

### `oc_rewind`

Undoes the last run of a thread. It refuses while a watch is armed; stop the run with `oc_stop`, or drop the watch with `oc_stop detach: true`, then retry. The target is the oldest user row at or after `time.busy - 1` in the 200-row window. A steer writes a newer user row, so a steer is not the target. If the opening row is older than the window, the tool asks for `branch: true` or a shorter run; it does not stage a false target.

Parameters: `session` (string, required), `files` (boolean, optional; default true), `commit` (boolean, optional), `branch` (boolean, optional), `clear` (boolean, optional). `branch` conflicts with `commit` and `clear`; `commit` conflicts with `clear`.

Receipt:

```
rewound ses_… to msg_…
files restored: src/note.txt
digest 2 calls (1 ok, 1 err) · shell 1 · write 1 · fails: shell: exit 1 · files: src/note.txt
staged; clear restores these files, commit makes it permanent.
```

`files: false` keeps the files and prints `files kept (files:false)`; the tail reads `staged messages only; clear drops the stage, commit makes it permanent.` `commit: true` stages, then commits; the tail reads `committed; the run's messages after msg_… are gone.` `clear: true` on a stage that this Pi session made deletes the stage and prints `cleared the staged revert on ses_…; files are back at the run's state`. With no tracked stage it prints `no rewind staged in this session; nothing cleared` and makes no call.

`branch: true` forks before the target and attaches the child:

```
forked ses_… before msg_…: ses_…
attached ses_…
...
```

A file stage asks in supervised mode before the POST. A commit after a `files: false` stage asks at the commit. See section 6.

Fails when the thread is outside the root, a watch is armed, the service answers 409 because the run is live, or the opening row is outside the window. A file stage in a root without git answers 200 with no files. When the digest named paths, the receipt says `no git history for this root, messages reverted, files untouched: <paths>`; with no paths it says `files restored: none`. The tree does not move. The message revert still works. See section 3.

### `oc_fanout`

Sends one brief to N models, one thread each, in the same directory. It returns a receipt and the thread ids. Every started member resolves the model and variant, then arms a watch. One composite report arrives when every member reports or expires.

Parameters: `brief` (string, required), `models` (string array, required; unique), `variant` (string, optional), `judge` (string, optional), `directory` (string, optional), `ttl_s` (number, optional).

Receipt:

```
fan_1: 3 of 3 started
ses_…  opencode-go/glm-5.3-flash  variant max  brief sent
ses_…  opencode-go/deepseek-v4.1-flash  variant max  brief sent
ses_…  opencode/an-example-free  variant default  brief sent
judge: opencode-go/glm-5.3-flash variant max queued after the members
```

Report:

```
outcome: fan-out 3 models

model: opencode-go/glm-5.3-flash · variant: max · outcome: succeeded · 12k tokens · $0.0012
digest 5 calls (5 ok) · shell 4 · read 1 · fails: none · files: src/parser.ts
answer:
...

model: ...
...
```

The sections keep the caller order. A skipped member, a failed member, and an expired member keep a section. A member section with no run reads `outcome: skipped` or `outcome: failed`; an expired member reads `outcome: expired`. The judge appends `judge <model>: <answer>` after the sections.

The member deadline is `OC_WATCH_TTL_S * N`, capped at `OC_WAIT_MAX_S * N`. `ttl_s` sets every member deadline directly, still capped. A member that runs past its deadline holds an expired section; the report does not wait forever.

Fails before any create when the live count plus N exceeds 32: `fan-out refused: <live> live threads + <N> new exceed 32`. The text says live threads; the count is the larger of the active runs and the armed watches. Fails when a model is not on the list, a model is repeated, the token cap is crossed, or no member starts. A Go member is skipped when the rolling meter is at or above `OC_BUDGET_PCT`; the skip is in its section, and free members still run. A member create or send failure keeps its section. A Pi reload drops the composite grouping; the members settle as ordinary threads.

### Commands

#### `/oc`

Status: mode, service URL, armed count, served models, and up to eight threads under the root. Adopted threads come first and carry `attached`.

Receipt:

```
mode: supervised
service: http://127.0.0.1:49374
armed: 1
served: opencode-go/glm-5.3-flash, opencode-go/deepseek-v4.1-flash
ses_…  running  glm-5.3-flash  refactor-parser  attached
```

The `batched` part appears only when the batch is not empty. The thread line shows `id`, `status`, model id, title, and `attached`. `status` reads `running` while the thread is busy; otherwise it reads the stored outcome.

#### `/oc-budget` and `/oc_budget`

Quota meters, one line per live thread, and the console budgets. The command forces a meter read. See section 8.

Receipt:

```
ses_…  opencode-go/glm-5.3-flash max  1400k tok  ~$0.8500
go rolling 45% · resets 21:40 · weekly 45% · monthly 23%
budget org_…: $1.25 / $10.00 · opencode-go/glm-5.3-flash $0.40
```

With no live thread the first line reads `live threads: none`. With no meter the meter line reads `quota: unreadable`. `/oc_budget` is an alias.

#### `/oc-attach`

`/oc-attach <ses_…>` adopts a thread. It uses the same checks and receipt as `oc_attach`. A bad argument prints `usage: /oc-attach <ses_...>`; a refused thread prints `attach failed: <message>`.

#### `/oc-auto`

Sets unsupervised mode and flushes queued asks. Receipt: `OpenCode bridge: auto — model questions go to this session's model`.

#### `/oc-accept`

Sets supervised mode. Receipt: `OpenCode bridge: supervised — you answer every request`.

#### `/oc-kill`

`/oc-kill <ses_…>` interrupts a thread. Receipt: `interrupted <session>` or `no run to interrupt in <session>`. A queued settle is appended after `The run had already settled:`. A bad argument prints `usage: /oc-kill <ses_...>`.

#### `/oc-clean`

`/oc-clean` lists finished threads under the root and keeps busy threads. `/oc-clean force` deletes them. A dry run prints `dry run: N under <root>, M busy kept`, one line per thread, and `run /oc-clean force to delete these`. A force run re-reads each thread, skips one that started a run, and prints `oc-clean: deleted N, kept M busy`. With no finished thread it prints `oc-clean: nothing to delete, M busy kept`.

#### `/oc-panes`

`/oc-panes open`, `/oc-panes close`, and `/oc-panes list` control the Ghostty columns; no argument means `list`. The command needs a TUI and a pane script. It prints `OpenCode columns: off outside a terminal`, `OpenCode columns: off (OC_PANES=0)`, `OpenCode columns: missing <path>`, or `usage: /oc-panes open | close | list`.

## Budget

The quota route is `GET /api/experimental/usage/limits`. It returns `data.go.rolling`, `data.go.weekly`, and `data.go.monthly`. Each meter has a `percent`, a `limited` flag, and a `resetsAt` time. A meter prints as `go rolling 45%`, or `go rolling LIMITED` when `limited` is true. The rolling meter also prints `resets HH:MM` in local time.

The meter read is cached for 30 s. `oc_open`, `oc_send`, and `oc_fanout` call the cache; a read older than 30 s refreshes it. `/oc-budget` forces a read. The HUD timer and the backstop poll never ask the service; they show the last snapshot. A failed read keeps the last snapshot and retries after 30 s. The route has a 5 s timeout, so it cannot hold a send.

The footer carries the meter line and the armed count. Each HUD row carries the thread's `tok` and cost. Thread numbers come from `Session.Info` on detail reads that the bridge already makes, so a sweep adds no request.

`OC_BUDGET_PCT` reads the rolling meter, the shortest window. It refuses `oc_open` and `oc_send` while the rolling percent is at or above the value. The refusal names the percent, the setting, and the reset time. A fan-out skips a Go member at or above the value; a free member still runs, and the skip is in the member section. `0` turns the ceiling off.

`OC_BUDGET_TOKENS` caps the token total of threads that this Pi session delegated to. The total adds `input + cache.read + cache.write + output + reasoning` for each delegated thread. The numbers come from `Session.Info`, not from a new request. The cap refuses `oc_open`, `oc_send`, and `oc_fanout` when the total is at or above the value, and names the thread that crossed it. `0` turns the cap off.

The cap counts a thread from its `oc_open`, from its first `oc_send`, from a fan-out member, or from an `oc_steer`. A refused `oc_steer` still adds the thread, because the add runs before the busy check. `oc_attach` does not add a thread; the first `oc_send` on an adopted thread runs its budget check before the add, so the adopted history does not block that send, but later sends count it. `oc_steer` and `oc_reply` are not gated by the cap. The cap does not count threads outside this Pi session, and it does not count cost. `/oc-clean` and a settle read that finds the thread gone remove it from the set; a thread deleted outside the bridge can stay in the total until Pi restarts. A settled thread stays in the total until the bridge deletes it or the session ends.

A cost that `Session.Info` reports is exact and prints as `$0.0012`. When the service reports 0, the bridge prices the tokens from `GET /api/model` and marks the result with `~`, for example `~$0.8500`. With no price row, the line keeps its token count and prints no dollar figure. A console `budget` is exact and carries no `~`.

## Environment

The bridge reads 12 of these variables. The other 8 belong to `oc-rpc.ts`, `oc-panes`, and the check scripts. The reader column names the file that reads the variable.

| Variable | Reader | Default | Effect |
| --- | --- | --- | --- |
| `OC_ROOT` | bridge | `process.cwd()` | Thread root. The code uses the working directory at Pi start. Set it to the tree that threads may write. |
| `OC_SERVICE_FILE` | bridge, oc-panes | `~/.config/opencode/service.json` | File with the service password. |
| `OC_RETENTION` | bridge | `{}` | JSON map from a model id suffix to a display label. `oc_models` shows the label. A broken value gives no labels. |
| `OC_DEBOUNCE_MS` | bridge | `400` | Batch window for wake-ups, in ms. |
| `OC_BACKSTOP_MS` | bridge | `5000` | Gap between backstop polls, in ms. |
| `OC_WATCH_TTL_S` | bridge | `1800` | Watch life, in seconds. |
| `OC_WAIT_MAX_S` | bridge | `300` | Ceiling for `oc_wait`, in seconds. |
| `OC_COMPACT_TOKENS` | bridge | `500_000` | Thread size above which a send orders a compaction first. `0` turns the gate off. |
| `OC_BUDGET_PCT` | bridge | `0` | Refuse open and send while the Go rolling meter is at or above this percent. `0` turns the ceiling off. |
| `OC_BUDGET_TOKENS` | bridge | `0` | Cap the token total of delegated threads. `0` turns the cap off. |
| `OC_HUD` | bridge | `on` | `0` removes the footer and the thread table. |
| `OC_PANES` | bridge | `oc-panes next to the extension` | Path to the pane script. `0` turns columns off. |
| `OC_RPC_MODEL` | oc-rpc | `""` | Model id for the RPC check. Set it to an id from `oc_models`. |
| `OC_RPC_SCENARIO` | oc-rpc | `wake` | RPC case: `wake`, `send`, `wait`, `stop`, or `since`. |
| `OC_RPC_DEADLINE_MS` | oc-rpc | `240_000` | Deadline for the RPC check, in ms. |
| `OC_EXTENSION` | oc-rpc | `opencode-bridge.ts next to oc-rpc.ts` | Extension file that the RPC check loads. |
| `OC_PANES_FONT` | oc-panes | `13` | Font size in a new pane. |
| `OC_PANES_COLS` | oc-panes | `0` | Column width. `0` lets Ghostty split evenly. |
| `OC_CHECK_MODEL` | checks | `required` | Model id for `check-tui.sh` and `check-reload.sh`. |
| `BRIDGE` | checks | `the repo's opencode-bridge.ts` | Build under test. The bridge checks import it; `check-12` reads it as the manual path. |

`CASE` selects a `check-3` case. It is not part of the bridge contract.

On this machine, `~/.zshrc` sets `OC_WATCH_TTL_S=3600`, because the default 1800 expires before a long build. Threads sit in `~/Pi` on this machine; the code default is the working directory at start.

## Checks and controls

The bridge checks start a stub `pi` and a stub OpenCode service, load the extension, and drive tool calls. `bun run typecheck` checks the types. `bun run check` runs every model-free check and its control. Run one check directly:

```
bun run checks/check-10-budget.ts
CASE=stale bun run checks/check-3-unit.ts
```

`BRIDGE` points a check at another build. The gate uses it to run a control:

```
BRIDGE=$PWD/.control-budget.ts bun run checks/check-10-budget.ts   # must fail
```

`checks/README.md` holds the generator for the controls. The python blocks read the source, remove the fix for each stage, and write `.control-*.ts` copies; the stage-12 block reads this manual. Run the blocks from the package root, then run the control line. A control must exit non-zero. A control must restore every defect of its stage: each case targets one defect, and a control that leaves one fix in place lets that case pass and hides a regression in the check.

`check-12-manual.ts` guards this file. It has four cases:

| Case | What it proves |
| --- | --- |
| `inventory` | Every tool in `opencode-bridge.ts` has a heading, every `OC_*` or `BRIDGE` variable has a table row, and the manual names no unknown tool or variable. |
| `commands` | Every registered command appears. |
| `env` | Every table row names a code variable, and its default matches the code. |
| `links` | `README.md` links this file, and all eleven section headings are present. |

The stage-12 control is a copy of this manual with two defects: the `oc_fanout` section is gone, and `OC_DEBOUNCE_MS` reads `500`. The generator writes `.control-manual.ts`. Run:

```
bun run checks/check-12-manual.ts
BRIDGE=$PWD/.control-manual.ts bun run checks/check-12-manual.ts   # must fail
```

`check-12` reads `BRIDGE` as a path to the manual under test, not as a TypeScript build. The other TypeScript checks import the build that `BRIDGE` names.

The TUI checks need a real model: `OC_CHECK_MODEL=<id from oc_models> bash checks/check-tui.sh`. The RPC check needs `OC_RPC_MODEL=<id from oc_models>` and costs tokens. `OC_RPC_SCENARIO` selects its case. CI runs `bun run check`; the TUI and RPC checks stay out of CI.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No wake-up arrives. | Print or JSON mode has no active turn; a reload dropped the batch; an aborted run holds the batch; a compaction holds it; a 4xx prompt dropped the watch. | Use `oc_wait` or `oc_read`. Send a new instruction with `oc_send` to arm a new run. Wait for the compaction to end. Send a human message to release a held batch. |
| `outcome: unknown (watch expired; restart with oc_send to read the record)` | The run passed `OC_WATCH_TTL_S` with no settle. | Read the record with `oc_read`. Raise `OC_WATCH_TTL_S` and restart Pi for long runs. Use `oc_send` to start a new run with a new watch. |
| `run already settled; oc_send starts a new one` | `oc_steer` found `busy <= idle`; the run is over. | Use `oc_send` for a new run. Use `oc_read` for the answer. |
| `already armed: ses_…` | `oc_attach` found a live watch. | Use the watch with `oc_read` or `oc_wait`. To replace it, run `oc_stop detach: true`, then attach again. |
| `no git history for this root, messages reverted, files untouched: <paths>` | The root is not a git repository, so the stage returned no files. | Make the root a git repository before the run. The messages are already reverted. |
| `files restored: none` | The run made no file edits, or the target has no file changes. | Accept the message revert. `files: false` prints `files kept (files:false)`. |
| A budget refusal names a ceiling with quota left. | `OC_BUDGET_TOKENS` sums the whole history of every delegated thread; `OC_BUDGET_PCT` reads the rolling meter, not the weekly or monthly meter; the meter snapshot can be 30 s old. | Run `/oc-budget` to force a read. Delete or clean heavy threads. Raise the cap or set it to `0`, then restart Pi. Wait for the reset. |
| `OpenCode service not reachable` | The service is down, the port changed, or the password file is wrong. | Run `opencode service status` and `opencode serve --service`. Check `OC_SERVICE_FILE`. Restart the service. |
| `open asks: unreadable` | The ask read failed during the settle. | Read the thread with `oc_read`. Retry `oc_wait` or `oc_reply`. |
| `rewind refused: ses_… has an armed watch` | A watch is live. | Run `oc_stop`, or `oc_stop detach: true`, then retry the rewind. |
