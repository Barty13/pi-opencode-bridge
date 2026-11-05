# Checks and controls

This page covers the checks: the model-free suite, the control builds, and the live checks that need
a real model.

Model-free checks run against a stub `pi` and a stub service. Each has a control: a build with the
fix removed, which must fail. Generate the controls, then run.

The controls are generated from `opencode-bridge.ts` by `checks/make-controls.ts`. Each control
applies its named defects to the current source. A missing anchor stops the generator, and a control
step skips when its file is absent.

```sh
bun run checks/make-controls.ts
```

Run from the package root. `BRIDGE` points a check at a control build.

```sh
for c in 4xx 5xx nowatch expire stale dup ceiling handle flush streamgap envparse perms loopback known askfail rootfile ceilenv abortlist panemode busyexp expirepane reply kill readbounds; do CASE=$c bun run checks/check-3-unit.ts; done
bun run checks/check-1-compact.ts
BRIDGE=file://$PWD/.control-bridge.ts CASE=stale bun run checks/check-3-unit.ts   # must fail
BRIDGE=file://$PWD/.control-bridge.ts CASE=dup bun run checks/check-3-unit.ts     # must fail
BRIDGE=file://$PWD/.control-compact.ts bun run checks/check-1-compact.ts          # must fail
bun run checks/check-4-gate.ts
BRIDGE=$PWD/.control-nogate.ts bun run checks/check-4-gate.ts                     # must fail
bun run checks/check-6-digest.ts
BRIDGE=$PWD/.control-digest.ts bun run checks/check-6-digest.ts                   # must fail
bun run checks/check-7-steer.ts
BRIDGE=$PWD/.control-steer.ts bun run checks/check-7-steer.ts                     # must fail
bun run checks/check-8-attach.ts
BRIDGE=$PWD/.control-attach.ts bun run checks/check-8-attach.ts                   # must fail
bun run checks/check-9-rewind.ts
BRIDGE=$PWD/.control-rewind.ts bun run checks/check-9-rewind.ts                   # must fail
bun run checks/check-10-budget.ts
BRIDGE=$PWD/.control-budget.ts bun run checks/check-10-budget.ts                  # must fail
bun run checks/check-11-fanout.ts
BRIDGE=$PWD/.control-fanout.ts bun run checks/check-11-fanout.ts                  # must fail
bun run checks/check-12-docs.ts
BRIDGE=$PWD/.control-docs.ts bun run checks/check-12-docs.ts                      # must fail
bun run checks/check-13-panes.ts
```

`check-3-unit.ts` runs the bridge cases against a stub `pi` and a stub service; `CASE` picks one:

| Case | What it proves |
| --- | --- |
| `4xx` | a send refused with HTTP 402 leaves no watch behind |
| `5xx` | a send refused with HTTP 500 leaves no watch behind |
| `flush` | a failed `pi.sendUserMessage` restores the batch and the retry carries the run |
| `streamgap` | a full buffer and a silent stream both close the reader, which reconnects and rescans |
| `expire` | an expired watch reports `outcome: unknown` and `open asks: unreadable` |
| `nowatch` | `oc_wait` with `since` names the missing watch instead of inventing one |
| `stale` | a sweep read that loses its watch releases the claim, so the next settle wakes the model |
| `dup` | a run the batch already reported is not handed out again |
| `ceiling` | `oc_wait` at the watch ceiling uses the busy row's idle as its floor |
| `handle` | an HTTP answer keeps the service handle, and failures rediscover once |
| `envparse` | a non-numeric `OC_BACKSTOP_MS` falls back to the 5000 ms default |
| `perms` | a malformed `permissionsJson` returns the budget-gate refusal, not a `SyntaxError` |
| `loopback` | a non-loopback service URL is refused before any request and any password |
| `known` | `oc_read` does not add a rescan target, and an empty rescan drops the thread |
| `askfail` | a settled run reports `settled: true` with `asksReadable: false` |
| `rootfile` | `OC_ROOT` at a file is refused as a directory |
| `ceilenv` | `OC_MAX_THREADS` replaces the hardcoded watch ceiling |
| `abortlist` | a finished wait removes its abort listener |
| `panemode` | a switch from TUI to print closes the old columns |
| `busyexp` | a busy run keeps its watch past the TTL and reports its real settle once |
| `expirepane` | an expired watch leaves its column open |
| `reply` | `oc_reply` accepts a permission and refuses a form without `answerJson` |
| `kill` | `/oc-kill` interrupts the thread and drops its watch |
| `readbounds` | `oc_read` caps the limit at 25 and names an offset past the end |

`check-6-digest.ts` runs the settle ledger cases against a stub service:

| Case | What it proves |
| --- | --- |
| `poll` | N sweeps with no settle make no 200-row read; one settle makes exactly one |
| `plain` | 5 shell calls print `digest 5 calls (5 ok) · shell 5 · fails: none · files: none` |
| `compact` | an edit before the newest compaction row does not appear |
| `fail` | the first error line lands in `fails`, and an open ask adds `asks: 1` |
| `long` | 5 fails with 240-char reasons: each reason caps at 120 chars, the line stays ≤400, one fail and `unfinished`/`asks` survive |
| `wide` | 300 rows with long paths: the path list shrinks, 5 failures survive, `unfinished: 1` shows, line ≤ 400 |

The control drops the compaction floor, so the `compact` case must fail.

`check-7-steer.ts` runs the steer cases against a stub service:

| Case | What it proves |
| --- | --- |
| `one` | a steer mid-run gives one wake-up and `steers 1` |
| `rerun` | a second turn with `busy` newer than the earlier `idle` accepts the steer |
| `twice` | two steers mid-run give `steers 2` and one wake-up |
| `late` | a settled thread refuses the steer and posts nothing |
| `nowatch` | a busy thread with no watch accepts the steer and names the missing wake-up |
| `polling` | a steer inside a held backstop poll is admitted, counted once, one wake-up |

The control restores three defects: the steer re-arm (`one`), the old `busy` predicate (`rerun`), and the `claimed` guard (`polling`).

`check-8-attach.ts` runs the attach cases against a stub service:

| Case | What it proves |
| --- | --- |
| `old` | an idle thread attaches with no watch; the settled run stays silent; `/oc` marks it `attached` |
| `idle` | a short TTL passes with no wake-up: an idle attach arms nothing |
| `live` | a mid-run thread with `busy > idle` attaches; its only assistant row sits at the floor and one wake-up carries its answer; a second attach says `already armed` |
| `detach` | `oc_stop detach: true` drops the watch, keeps the run, and never posts `/interrupt` |
| `escape` | a thread outside `OC_ROOT` is refused; nothing is armed; the command reports the failure |
| `restore` | a reload restores a watch for a busy saved row only; an idle saved row gets none |
| `readfail` | a failed status read during restore keeps the watch; `/oc` still counts it |
| `clean` | a dry run lists the idle thread, keeps the busy and adopted ones, and `force` deletes only the idle thread |

The control carries five defects: the newest-row floor (`live`), the unconditional arm (`idle`), the blind restore (`restore`), the dropped watch on a failed read (`readfail`), and a restored run missing from the token census (`restore delegated`). It also deletes adopted threads in `/oc-clean` (`clean`).

`check-9-rewind.ts` runs the rewind cases against a stub service:

| Case | What it proves |
| --- | --- |
| `stage` | the default posts `{messageID, files:true}` at the run opener and names the target, paths, and digest; `files:false` keeps the files with no ask |
| `steered` | a steer user row does not become the target; no user row at or after `busy` gives the window wording and no stage call |
| `clear` | a tracked stage deletes with `DELETE /revert`; a second clear makes no call and reports no file change |
| `ask` | a supervised file stage asks before the stage, one question covers a commit, refusal calls no stage, and `files:false` keeps the commit ask |
| `commit` | auto mode posts stage then commit, in that order, with no ask |
| `branch` | the fork body carries `before`, the child is attached, and `/oc` marks it |
| `armed` | an armed watch refuses the rewind with zero service calls |
| `batch` | a settle waiting in the batch rides in the receipt and does not wake the model after the rewind |
| `noui` | no UI keeps the stage staged, says the commit needs a Pi TUI, and does not advise `/oc-auto` |

The control carries six defects: the stage ask after the stage (`ask`), the newest-user-row target (`steered`), the untracked clear (`clear`), the no-UI advice (`noui`), the plain no-files line in place of the no-git wording (`nogitroot`), and a dropped batched settle (`batch`).

`check-10-budget.ts` runs the budget cases against a stub service:

| Case | What it proves |
| --- | --- |
| `ok` | one open reads the meters once, the footer names rolling/weekly/monthly and the reset time, and the HUD row carries `tok` and a `~` estimate |
| `cache` | two sends inside 30 s reuse one meter read; the request count in the stub stays at one |
| `poll` | backstop sweeps read session detail but add zero meter requests |
| `limited` | `limited: true` prints `LIMITED` in place of the percent in the notice and the footer |
| `ceiling` | rolling 90 refuses both `oc_open` and `oc_send` at `OC_BUDGET_PCT=80`, names the reset time, and posts no prompt |
| `tokens` | with 6k on the first thread and 10k on the second, `OC_BUDGET_TOKENS=15000` refuses the second and names the thread that crossed |
| `usd` | a thread priced from `/api/model` carries `~`; a console budget prints exact `spent/limit` and per-model spent without `~` |
| `noprice` | with `/api/model` empty the line keeps `6k tok` and has no `$` at all |
| `attachcap` | an adopted heavy thread stays out of the token census: its first send goes through, and `/oc-budget` still lists it with cost |

The control carries three defects: the weekly percent gate (`ceiling`), the `$0` no-price fallback (`noprice`), and the attached-thread census (`attachcap`).

`check-11-fanout.ts` runs the fan-out cases against a stub service:

| Case | What it proves |
| --- | --- |
| `reload` | the counter rides in `oc-armed`: `fan_1`, shutdown, start, then `fan_2` |
| `merge` | three staggered members give one wake-up, sections in caller order, with tokens, cost, digest, and answer |
| `fail` | one failed member and one expired member keep their sections in the same single report |
| `race` | a failed member's later run settles alone; the fan-out report still waits for the other member |
| `cap` | 30 live threads plus 3 new is refused with the count, before any create or prompt |
| `quota` | rolling 90 at `OC_BUDGET_PCT=80` skips the Go member, still creates and prompts both free members, and names the skip |
| `judge` | the judge thread receives all three answers, and its verdict joins the same report |
| `stop` | a fan-out report that names a stopped member rides in the stop receipt and never wakes the model |

The control carries seven defects: the fan-out hold, so every member wakes alone (`merge`, `fail`); the live-thread cap (`cap`); the Go-member quota skip (`quota`); the judge (`judge`); the counter restore (`reload`); a serial create loop (`parallel`); and an untruncated judge prompt (`judge prompt cap`).

`check-12-docs.ts` runs the doc-rot cases against the `docs/` tree:

| Case | What it proves |
| --- | --- |
| `inventory` | every tool and command has a page, and every tool or command page has a tool or command behind it |
| `commands` | every registered slash command appears in its own command page |
| `index` | `docs/README.md` links every page, links no missing file, and the root README links the index |
| `env` | every environment table row names a code variable, its default matches the code, and every `OC_*` or `BRIDGE` variable has a row in `docs/environment.md` |
| `manual` | `docs/manual.md` does not exist |
| `budget` | every tool page is under 45 lines and every command page is under 25 lines |

The control carries two defects: the `oc_fanout` page is gone (`inventory`), and `OC_DEBOUNCE_MS` reads `500` (`env`). Both cases must fail. The stage-12 control is a docs bundle, not a build of the extension; `BRIDGE` names the bundle under test.

The `env` case covers the twenty-one `OC_*` and `BRIDGE` names in the Environment table: fourteen for the bridge, four for `oc-rpc.ts`, one for `oc-panes`, and two for the check scripts. `CASE`, `PATH`, and other check-local selectors are out of scope on purpose.

`check-5-live.ts` costs one real turn on a free model. It finds the largest idle thread above
`OC_COMPACT_TOKENS`, sends one short instruction through the bridge, and proves on the wire that the
compaction row precedes the reply and the size dropped. It prints `SKIP` when no thread qualifies.

`check-tui.sh` and `check-reload.sh` drive a real pi TUI through tmux, one pane snapshot per second,
and need a model, so they take `OC_CHECK_MODEL=<id from oc_models>`. They set `OC_ROOT` to a
temporary directory. `OC_PANES=0` keeps them out of Ghostty. Item 25 (pane columns only for armed
threads) has no check: a fake `HOME` does not move `os.homedir()` in bun, so a stub pane script
cannot be installed safely. Read the `oc_open` and `oc_send` bodies in `opencode-bridge.ts` instead.

`check-13-panes.ts` runs the `oc-panes` input cases against a fake `osascript` on `PATH`:

| Case | What it proves |
| --- | --- |
| `live` | a benign `add` reaches `osascript`, so a silent run below means a rejection |
| `dir` | a directory with an apostrophe exits non-zero, prints one line, and calls no `osascript` |
| `state` | a corrupt pane id in the state file is dropped by `rm`, which still exits 0 and calls no `osascript` |
| `id` | a `tab-group-…` window id, a UUID anchor id, and a UUID pane id pass; an id with an apostrophe is refused before `osascript` |
| `prune` | the live set spans every cursor page, a tab with no `sessionID` stays, and a non-loopback URL gets no request |

One run covers those cases in order, and the marker file is the only signal for whether `osascript` ran. The `prune` case starts a stub service; `PANES` points the run at a control script.
