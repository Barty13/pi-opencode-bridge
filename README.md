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

The bridge adds seven tools and six commands.

| Tool | What it does |
| --- | --- |
| `oc_models` | Lists the models the service serves for delegation, with each effort ladder |
| `oc_open` | Opens a thread for one self-contained task, returns its id |
| `oc_send` | Hands an instruction to a thread, returns at once |
| `oc_wait` | Collects the settle inside the current turn, when a wake-up cannot arrive |
| `oc_read` | Shows the latest messages, `parts: "full"` adds reasoning and tool calls |
| `oc_reply` | Answers an open permission or form ask by id |
| `oc_stop` | Interrupts a running thread, no wake-up follows |

| Command | What it does |
| --- | --- |
| `/oc` | Status: mode, service, live threads |
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

## Supervision

Every ask from a thread (a permission, a form) goes to you by default. `/oc-auto` hands asks to
the model in this Pi session, which answers with `oc_reply`. `/oc-accept` returns to you. `--oc-auto` starts a
session in auto mode. Each session start resets to supervised and drops per-thread state, so a
stale run stays safe.

## Boundary

Threads live under `OC_ROOT`. `oc_open` checks the create path, every other tool checks that
thread's own directory once. Real paths compare, so a symlink cannot escape the root. Threads can
write files, so point `OC_ROOT` at a scratch tree you own. Without `OC_ROOT` the root is the
working directory at start.

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
