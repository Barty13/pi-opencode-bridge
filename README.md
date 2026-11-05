# pi-opencode-bridge

[![CI](https://github.com/Barty13/pi-opencode-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/Barty13/pi-opencode-bridge/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@barty13/pi-opencode-bridge)](https://www.npmjs.com/package/@barty13/pi-opencode-bridge)
[![license MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![Pi on the left, two OpenCode threads on the right](assets/banner.png)

Delegate threads from a [Pi](https://github.com/badlogic/pi-mono) session to a local OpenCode
service. `oc_open` returns while the thread still runs. When the thread settles, Pi opens a new
turn with the answer. Your main session keeps working, and you keep the terminal.

```
$ pi install npm:@barty13/pi-opencode-bridge
```

Or from git:

```
$ pi install git:github.com/Barty13/pi-opencode-bridge
```

Then start Pi with the thread root set:

```
$ OC_ROOT=~/work/threads pi
```

```
> /oc
mode: supervised · service: http://127.0.0.1:… · threads: 0 armed
> oc_models
> oc_open  model: <id from oc_models>  title: refactor-parser  brief: …
```

## What it removes

Pi runs one turn at a time, and a turn is the unit that blocks. Delegation with a blocking call
holds that turn for the whole run of the other model. Here the send returns in milliseconds. The
finish arrives later, as one message, with the answer already inside it.

The bridge adds eleven tools and eight commands.

| Tool | What it does |
| --- | --- |
| `oc_models` | Lists the models the service serves for delegation, with each effort ladder |
| `oc_open` | Opens a thread for one self-contained task, returns its id |
| `oc_attach` | Adopts a thread the bridge did not open; arms a watch while it runs |
| `oc_fanout` | Sends one brief to N models; one merged report holds every section |
| `oc_send` | Hands an instruction to a thread, returns at once |
| `oc_steer` | Corrects a running thread in place; applies at the next step boundary |
| `oc_rewind` | Undoes the last run: stage a revert, commit it, fork before it, or clear a stage |
| `oc_wait` | Collects the settle inside the current turn, when a wake-up cannot arrive |
| `oc_read` | Shows the latest messages, `parts: "full"` adds reasoning and tool calls |
| `oc_reply` | Answers an open permission or form ask by id |
| `oc_stop` | Interrupts a running thread, or drops the watch with `detach: true` |

| Command | What it does |
| --- | --- |
| `/oc` | Status: mode, service, live threads; adopted threads marked `attached` |
| `/oc-budget` | Quota meters, live thread cost, and console budgets (`/oc_budget` also works) |
| `/oc-attach <ses_...>` | Adopts an existing thread under `OC_ROOT` |
| `/oc-auto` | The model in this Pi session answers the asks |
| `/oc-accept` | You answer the asks yourself |
| `/oc-kill <id>` | Stops a thread |
| `/oc-clean [force]` | Lists or deletes finished threads |
| `/oc-panes open\|close\|list` | Controls the Ghostty columns |

## Install

```bash
$ pi install npm:@barty13/pi-opencode-bridge      # or: pi install <path to a clone>
```

An update takes effect on the next restart or resume: a running pi keeps the code it loaded.

## Requirements

- **OpenCode already installed and signed in.** Free or licensed, your choice. The service must run:
  start it with `opencode serve --service`. The bridge only talks to that local service, on the
  port `opencode service status` prints, with the password in `~/.config/opencode/service.json`.
  It never installs, updates, or configures OpenCode, and it never reads your provider keys.
- **Ghostty 1.3 or newer**, for the live columns. Each live thread gets one column that runs
  `opencode --session <id>`, so you watch the thread work. Ghostty's AppleScript dictionary drives
  it, so this part is macOS only. Set `OC_PANES=0` if you do not want columns.
- Pi 1.4 or newer. Bun runs the extension; Pi bundles it.

## How a thread finishes

1. `oc_send` posts the prompt and returns. The thread is armed: the bridge now owes one wake-up.
2. The OpenCode event stream reports `session.execution.{succeeded,failed,interrupted}`. One detail
   request per armed thread every `OC_BACKSTOP_MS` covers dropped frames.
3. Detect claims the thread once, snapshots the answer, and releases one debounced message per
   batch. Two settles produce one message.
4. `oc_wait` waits on that same detector, so a collected answer never wakes the model twice.
5. A run already reported answers `already reported` instead of a second copy: the wake-up and
   `oc_wait` share one report per run. `oc_wait` with `since` and `oc_read` read the record freely.

A batch that lands while you type waits for you. A batch held by compaction waits for the compact
to end. An escape (abort) holds the batch, so a wake-up cannot reopen a conversation you dropped.

Print, JSON, and a Pi reload carry no wake-up. There `oc_wait` is the collector.

## Attach

`oc_attach` adopts a thread the bridge did not open, for example a TUI thread or one a previous Pi
session left. It reports the title, model, variant, size, open asks, and `running` or `idle`:

```
attached ses_… "attach-probe"
model: opencode-go/glm-5.3-flash variant default · 8k tokens · open asks: none · idle
```

A running thread gets one watch with the floor just behind its current run, so the answer it already
wrote is not lost, and an answer from an earlier run is not reported as a fresh settle. An idle
thread gets no watch; the next `oc_send` arms one. `/oc-attach <ses_...>` does the same from the
command line, and `/oc` marks adopted threads `attached`. A reload restores a watch only while the
thread still runs; a failed status read keeps it. `oc_stop` with `detach: true` drops the watch and
leaves the run going.

## Steering

`oc_steer` corrects a running thread in place. It asks the service first: an idle thread answers
`run already settled; oc_send starts a new one`. A busy thread with a watch accepts the steer; a busy
thread with no watch accepts it too, with `steer admitted (no watch, no wake-up)`. A watched run is
not re-armed, so it still gives one wake-up. The receipts are:

```
steer admitted at 14:03:07 · applies at the next step boundary
steer admitted (no watch, no wake-up)
```

Any number of steers are accepted; each applies at its own step boundary. The settle body reports
`steers N` when the run admitted at least one steer. A record read with no live watch omits the count,
because the bridge cannot know it. If the service answers HTTP 409, the receipt names the status and
the run stays.

## Rewind

`oc_rewind` undoes the last run of a thread. It takes the oldest `user` row at or after the run's
`busy` mark, so a steer row does not become the boundary. The default stage restores the run's file
edits at once; the receipt names the target message and the paths the digest saw:

```
rewound ses_… to msg_…
files restored: src/note.txt
digest 2 calls (1 ok, 1 err) · shell 1 · write 1 · fails: shell: exit 1 · files: src/note.txt
staged; clear restores these files, commit makes it permanent.
```

`files: false` stages the message revert and keeps the files. In supervised mode a file stage asks
before the rewrite; the question names the target and the digest paths, and says `clear` reverses the
stage. The same question covers a requested commit, which cannot be undone. Auto mode posts through.
A `files: false` commit asks at the commit. `commit: true` posts `/revert/commit`: the run's messages
after the target go away and the staged file changes stay.

`clear: true` drops a stage this Pi session made with `DELETE /revert`, so the files go back to the
run's state. With no tracked stage it makes no call and says nothing was cleared. Without a UI, a
supervised commit keeps the stage and says the decision needs a Pi TUI. A thread whose opening user
row sits below the 200-row window gets a fork hint instead of a false "no user message".

`branch: true` is the undo that keeps the history: it forks with `POST /fork {before}` and attaches
the child. There is no `unrevert` route, so a committed revert is final.

A thread with an armed watch refuses a rewind: stop it with `oc_stop`, or drop the watch with
`oc_stop detach: true`, then retry. The service answers 409 while a run is live, so a revert needs an
idle thread.

## Run digest

The settle body ends with one digest line when the bridge reports a settle. The backstop poll reads 8
rows; a reported settle reads the 200-row window once, and the digest comes from that read. It adds
no model call and no extra poll payload.

```
digest 5 calls (5 ok) · shell 5 · fails: none · files: none
```

The line gives the call count and the ok/error split, the calls per tool name, the first five
failures (tool name and first error line, each reason capped at 120 characters), the open ask count,
and the touched paths (edits before reads, at most ten). A call that is still running adds
`unfinished: N`. The path list shrinks first, then the failure list, and a last-resort cut keeps the
line at or below 400 characters. The window starts after the newer of the watch floor and the newest
compaction row, so a compacted context does not show calls from before the compaction.

## Context ceiling

A thread that grew past `OC_COMPACT_TOKENS` compacts before it takes your next instruction. The
bridge reads the newest assistant row of that thread (`input + cache.read + cache.write + output +
reasoning`), orders `POST /compact` with `delivery:"steer"`, then posts the prompt. OpenCode runs the
compaction at the step boundary, so the prompt lands on the compacted context. Measured on a 716k
thread: compact admitted in 77 ms, reply 98 s later, size down to 34k.

The receipt says so: `sent; ... compact ordered at 716k`. A thread whose newest compaction row
postdates its last answer reads 0, so one compaction never triggers the next. OpenCode answers a
second steer with 409, so parallel sends order one compaction. Your own `opencode.json` auto-compact
stays in charge below the ceiling.

## Budget

`/oc-budget` reads `GET /api/experimental/usage/limits` and prints one row per live thread (model,
variant, tokens, cost), then the Go meters, then any console `budgets[]` as `spent / limit` with
per-model spent:

```
ses_…  opencode-go/glm-5.3-flash max  1.4M tok  ~$0.85
go rolling 45% · resets 21:40 · weekly 45% · monthly 23%
budget org_…: $1.25 / $10.00 · opencode-go/glm-5.3-flash $0.40
```

The meter read is cached for 30 s. `oc_open` and `oc_send` check it before the run and reuse the
snapshot inside that window, so the footer shows the same numbers; `/oc-budget` refreshes it now.
The HUD timer and the backstop poll never ask. A meter with `limited: true` prints `LIMITED` in
place of its percent.

The footer carries the meters and the armed count. Each HUD row carries the thread's `tok` and cost.
Thread numbers come from `Session.Info` on detail reads the bridge already makes, so a sweep adds no
request. A cost the service reports prints as exact USD. When the service reports 0, the command
prices the tokens with `GET /api/model` and marks the estimate with `~`, because the console and the
model list disagree on some ids. With no model price row, the line keeps its token count and prints
no dollar figure. Console `budgets[]` are exact and carry no `~`.

Two ceilings, both off at `0`:

- `OC_BUDGET_PCT` refuses `oc_open` and `oc_send` while the Go rolling meter is at or above the
  percent, and names `resetsAt`.
- `OC_BUDGET_TOKENS` caps the tokens of threads this Pi session opened. A send that would cross the
  cap is refused and names the thread that crossed it. `oc_attach` does not add a thread's history
  to the cap; `/oc-budget` still lists adopted live threads with their cost.

## Fan-out

`oc_fanout` sends the same brief to N models, one thread each, in the same directory. It returns
at once with a receipt and the thread ids. Every member runs the `oc_models` check and the variant
ladder, then arms a watch. The thread ids sit under one fan-out id, `fan_<n>`.

When every member reports or expires, one wake-up carries one report. The sections keep the model
order the caller gave, and each section gives the model, variant, outcome, tokens, cost, digest
from the run ledger, then the answer. A member that fails, expires, or is skipped keeps its section,
so the report is always complete. Deleting a member outside the bridge leaves its watch to the
deadline, and the section reads `expired`.

```
fan_1: 3 of 3 started
ses_…  opencode-go/glm-5.3-flash  variant max   brief sent
ses_…  opencode-go/deepseek-v4.1-flash  variant max   brief sent
ses_…  opencode/an-example-free  variant high   brief sent
```

`judge: "<id>"` opens one more thread after the members finish. Its prompt carries the brief and
every answer, and its ranking appends to the same report. The judge is a member of the fan-out, so
one wake-up still covers the whole run.

The fan-out refuses before any create when the live threads on the service plus N exceed 32; the
receipt names both counts. When the Go rolling meter sits at or above `OC_BUDGET_PCT`, a Go member
is skipped with the ceiling and its reset time; free members still run, and the report names the
skip.

The member deadline is `OC_WATCH_TTL_S × N`, capped at `OC_WAIT_MAX_S × N`. `ttl_s` sets every
member's deadline directly, still capped at `OC_WAIT_MAX_S × N`. A member that runs past its deadline
holds an `expired` section instead of delaying the report forever.

## Supervision

Every ask from a thread (a permission, a form) goes to you by default. `/oc-auto` hands asks to
the model in this Pi session, which answers with `oc_reply`. `/oc-accept` returns to you. `--oc-auto` starts a
session in auto mode. Each session start resets to supervised and drops per-thread state, so a
stale run stays safe.

## Boundary

Threads live under `OC_ROOT`. `oc_open` checks the create path, `oc_attach` checks the adopted
thread's directory, and every other tool checks that thread's own directory once. Real paths compare,
so a symlink cannot escape the root. Threads can write files, so point `OC_ROOT` at a scratch tree you
own. Without `OC_ROOT` the root is the working directory at start.

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `OC_ROOT` | working directory | Thread root, all threads must sit under it |
| `OC_PANES` | `oc-panes` next to the extension | Path to the pane script, `0` turns columns off |
| `OC_PANES_FONT` | `13` | Font size in a new pane window |
| `OC_PANES_COLS` | `0` | Column width, `0` lets Ghostty split evenly |
| `OC_HUD` | on | `0` removes the footer and the thread table |
| `OC_DEBOUNCE_MS` | `400` | Batch window for wake-ups |
| `OC_BACKSTOP_MS` | `5000` | Poll gap between event frames |
| `OC_WATCH_TTL_S` | `1800` | How long an armed thread waits before it expires |
| `OC_WAIT_MAX_S` | `300` | Ceiling for `oc_wait` |
| `OC_COMPACT_TOKENS` | `500000` | Thread size in tokens above which a send orders a compaction first; `0` turns the gate off |
| `OC_BUDGET_PCT` | `0` | Refuse `oc_open` and `oc_send` while the Go rolling meter is at or above this percent; `0` turns the ceiling off |
| `OC_BUDGET_TOKENS` | `0` | Cap the tokens of threads this Pi session opened; a send past it names the thread that crossed; `0` turns the cap off |
| `OC_SERVICE_FILE` | `~/.config/opencode/service.json` | Where to read the local service password |
| `OC_RETENTION` | `{}` | Your own data-policy labels, JSON keyed by model id suffix, for example `{"<id>":"zero"}`. Display only. The bridge ships no model ids: read each policy from your provider and set it here. |

## Checks

Model-free checks run against a stub `pi` and a stub service. Each has a control build with the fix
removed, which must fail. See [checks/README.md](checks/README.md).

```
$ bun install
$ bun run typecheck
$ bun run check
```

Checks that need a real model drive a Pi TUI in tmux, and take `OC_CHECK_MODEL`:

```
$ OC_CHECK_MODEL=<id from oc_models> bash checks/check-tui.sh
$ OC_RPC_MODEL=<id from oc_models> bun run oc-rpc.ts   # wake-up path, costs tokens
```

## Limits

- One OpenCode service per bridge, no remote host, no proxy.
- Live columns need macOS plus Ghostty. They stay off in print, JSON, and RPC mode.
- 32 open threads at most. A watch older than `OC_WATCH_TTL_S` expires and reports itself.
- Message bodies cap at 4000 characters per read; `offset` pages past the cap.
- Deleting a thread outside the bridge does not cancel its armed watch, so its wake-up still fires.
  Clean up after the settle with `/oc-clean force`, not mid-run.

## Picture

`assets/banner.png` comes from `gallery/render.py`. Run `bash gallery/fetch.sh` first: it pulls the
producers' own screens, the Pi terminal screenshot from pi-mono and the OpenCode splash and working
screens from opencode. Trademarks belong to their owners. No operator screenshot appears in it.

## License

MIT. See [LICENSE](LICENSE). Report issues through [SECURITY.md](SECURITY.md).
