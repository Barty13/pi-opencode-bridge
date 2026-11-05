@@ docs/README.md
# Bridge documentation

This index lists every bridge page in reading order.

## Start here

- [lifecycle.md](lifecycle.md) — the watch lifecycle, the floor, the backstop poll, and reload behaviour.
- [wake-up.md](wake-up.md) — the anatomy of a wake-up, the digest line, and the batch rules.
- [supervision.md](supervision.md) — supervised and auto mode, `--oc-auto`, the asks, and what a session start resets.
- [sandbox.md](sandbox.md) — `OC_ROOT`, the path checks, the symlink rule, and the git-backed root for rewind.
- [budget.md](budget.md) — the quota meters, the cost display rules, and the two ceilings.
- [environment.md](environment.md) — every `OC_*` name, its reader, its default, and its effect.
- [checks.md](checks.md) — the model-free checks, the controls, and the live checks.
- [troubleshooting.md](troubleshooting.md) — each symptom, its cause, and its fix.

## Tools

- [oc_models](tools/oc_models.md) — lists the models that the service serves for delegation.
- [oc_open](tools/oc_open.md) — opens a thread for one task.
- [oc_attach](tools/oc_attach.md) — adopts a thread that the bridge did not open.
- [oc_send](tools/oc_send.md) — hands an instruction to a thread and returns.
- [oc_steer](tools/oc_steer.md) — corrects a running thread in place.
- [oc_rewind](tools/oc_rewind.md) — undoes the last run.
- [oc_wait](tools/oc_wait.md) — collects a settle inside the current turn.
- [oc_read](tools/oc_read.md) — shows the latest messages.
- [oc_reply](tools/oc_reply.md) — answers an open permission or form ask.
- [oc_stop](tools/oc_stop.md) — interrupts a run or drops its watch.

## Commands

- [/oc](commands/oc.md) — prints the bridge status.
- [/oc-budget](commands/oc-budget.md) — prints the quota meters and the thread costs.
- [/oc-attach](commands/oc-attach.md) — adopts an existing thread.
- [/oc-auto](commands/oc-auto.md) — sends the asks to the model in this Pi session.
- [/oc-accept](commands/oc-accept.md) — sends the asks to you.
- [/oc-kill](commands/oc-kill.md) — stops a thread.
- [/oc-clean](commands/oc-clean.md) — lists or deletes finished threads.
- [/oc-panes](commands/oc-panes.md) — controls the Ghostty columns.
@@ docs/budget.md
# Budget

This page covers the quota meters, the cost display rules, and the two budget ceilings.

The quota route is `GET /api/experimental/usage/limits`. It returns `data.go.rolling`,
`data.go.weekly`, and `data.go.monthly`. Each meter has a `percent`, a `limited` flag, and a
`resetsAt` time. A meter prints as `go rolling 45%`, or `go rolling LIMITED` when `limited` is true.
The rolling meter also prints `resets HH:MM` in local time.

The meter read is cached for 30 s. `oc_open`, `oc_send`, and `oc_fanout` call the cache; a read older
than 30 s refreshes it. `/oc-budget` forces a read. The HUD timer and the backstop poll never ask the
service; they show the last snapshot. A failed read keeps the last snapshot and retries after 30 s.
The route has a 5 s timeout, so it cannot hold a send.

The footer carries the meter line and the armed count. Each HUD row carries the thread's `tok` and
cost. Thread numbers come from `Session.Info` on detail reads that the bridge already makes, so a
sweep adds no request.

`OC_BUDGET_PCT` reads the rolling meter, the shortest window. It refuses `oc_open` and `oc_send`
while the rolling percent is at or above the value. The refusal names the percent, the setting, and
the reset time. A fan-out skips a Go member at or above the value; a free member still runs, and the
skip is in the member section. A zero value turns the ceiling off.

`OC_BUDGET_TOKENS` caps the token total of threads that this Pi session delegated to. The total adds
`input + cache.read + cache.write + output + reasoning` for each delegated thread. The numbers come
from `Session.Info`, not from a new request. The cap refuses `oc_open`, `oc_send`, and `oc_fanout`
when the total is at or above the value, and names the thread that crossed it. A zero value turns
the cap off.

The cap counts a thread from its `oc_open`, from its first `oc_send`, from a fan-out member, or from
an `oc_steer`. A refused `oc_steer` still adds the thread, because the add runs before the busy
check. `oc_attach` does not add a thread; the first `oc_send` on an adopted thread runs its budget
check before the add, so the adopted history does not block that send, but later sends count it.
`oc_steer` and `oc_reply` are not gated by the cap. The cap does not count threads outside this Pi
session, and it does not count cost. `/oc-clean` and a settle read that finds the thread gone remove
it from the set; a thread deleted outside the bridge can stay in the total until Pi restarts. A
settled thread stays in the total until the bridge deletes it or the session ends.

A cost that `Session.Info` reports is exact and prints as `$0.0012`. When the service reports 0, the
bridge prices the tokens from `GET /api/model` and marks the result with `~`, for example
`~$0.8500`. With no price row, the line keeps its token count and prints no dollar figure. A console
`budget` is exact and carries no `~`.
@@ docs/checks.md
# Checks and controls

This page covers the checks: the model-free suite, the control builds, and the live checks that need
a real model.

Model-free checks run against a stub `pi` and a stub service. Each has a control: a build with the
fix removed, which must fail. Generate the controls, then run.

```sh
python3 - <<'PY'
src = open('opencode-bridge.ts').read()
pairs = [
 ("      if (mine.armed.get(session) !== w || mine.sending.has(session)) {\n        mine.claimed.delete(session);  // or detect/sweep skip it until the 30 min TTL (:701, :732)\n        continue;\n      }", "      if (mine.armed.get(session) !== w || mine.sending.has(session)) continue;"),
 ("      else if (/HTTP 4\\d\\d/.test(String(error))) dropThread(session);\n", ""),
 ('session, title: "", outcome: "unknown", error: null, answer: "", asks: [],\n          asksUnknown: true, idleAt: Date.now(), steers: w.steers, expired: true,', 'session, title: "", outcome: "running", error: null, answer: "", asks: [], idleAt: Date.now(), steers: w.steers, expired: true,'),
 ("      markReported(settle.asks);\n      for (const section of settle.fan ?? []) markReported(section.asks);\n      // This message is the report for these runs; a later oc_wait must not repeat them.\n      for (const run of settle.runs ?? [{ session: settle.session, idleAt: settle.idleAt }]) {\n        mine.reportedRun.set(run.session, run.idleAt);\n      }", "      markReported(settle.asks);\n      for (const section of settle.fan ?? []) markReported(section.asks);"),
]
out = src
for pat, rep in pairs:
    assert pat in out, pat[:40]
    out = out.replace(pat, rep, 1)
open('.control-bridge.ts','w').write(out)
gate = "    if (mine.compacting) return;  // keep the batch; afterCompact re-arms the flush\n"
assert gate in src
open('.control-compact.ts','w').write(src.replace(gate, ""))
ceiling = "const COMPACT_TOKENS = Number(process.env.OC_COMPACT_TOKENS ?? 500_000);"
assert ceiling in src
open('.control-nogate.ts','w').write(src.replace(ceiling, "const COMPACT_TOKENS = 0;  // CONTROL: gate off"))
digest = "  const digestRows = fresh.filter((entry: any) => Number(entry?.time?.created ?? 0) > Math.max(floor, compactAt));"
assert digest in src
open('.control-digest.ts','w').write(src.replace(digest, "  const digestRows = fresh.filter((entry: any) => Number(entry?.time?.created ?? 0) > floor);"))
steer = "          // A steer must not re-arm: the watch floor, deadline, claim, and report stay.\n          await postPrompt(params.session, { text: params.text, delivery: \"steer\" });"
assert steer in src
busy = "  return Number(row?.time?.busy ?? 0) > Number(row?.time?.idle ?? 0);"
assert busy in src
control = src.replace(busy, "  return Boolean(row?.time?.busy) && !row?.time?.idle;")
claimed = "        if (state.sending.has(params.session)) {"
assert claimed in src
control = control.replace(claimed, "        if (state.claimed.has(params.session)) {\n          return {\n            content: [{ type: \"text\", text: \"the run is settling; no steer sent\" }],\n            details: { session: params.session, steered: false },\n            isError: true,\n          };\n        }\n" + claimed)
open('.control-steer.ts','w').write(control.replace(steer, "          armThread(params.session);\n" + steer))
floor = """    const running = busy(row);
    // `busy` marks the start of the run in flight; one ms behind it includes the answer row that
    // carries the run. An idle thread's floor sits at its last idle and excludes the old run.
    const floor = running ? Number(row?.time?.busy ?? 0) - 1 : Number(row?.time?.idle ?? 0);"""
assert floor in src
control = src.replace(floor, """    const running = busy(row);
    const newest = (await api<any>("GET", `/api/session/${session}/message?order=desc&limit=1`)).data?.[0];
    const floor = Number(newest?.time?.created ?? 0);""", 1)
arm = "    if (running) armThread(session, floor);"
assert arm in control
control = control.replace(arm, "    armThread(session, floor);", 1)
restore = """      if (mine !== state) return;
      // A failed read may hide a live run, so keep the watch. Only a real idle row drops it.
      if (!readFailed && !busy(current)) return;"""
assert restore in control
control = control.replace(restore, "      if (mine !== state || readFailed) return;", 1)
open('.control-attach.ts','w').write(control)
rewind_target = """        const current = (await api<any>("GET", `/api/session/${session}`)).data;
        noteThread(state, current);
        // The run opener is the oldest user row at or after busy; a steer writes a newer user row.
        const floor = Number(current?.time?.busy ?? 0) - 1;
        const rows = (await api<any>("GET", `/api/session/${session}/message?order=desc&limit=${DIGEST_ROWS}`)).data ?? [];
        const at = rows.findLastIndex((row: any) =>
          row.type === "user" && Number(row?.time?.created ?? 0) >= floor
        );
        if (at < 0) {
          throw new Error(
            `the opening user row of the last run sits older than the ${DIGEST_ROWS}-row window; fork with branch:true, or rewind a shorter run`,
          );
        }"""
assert rewind_target in src
control = src.replace(rewind_target, """        // The newest user row opens the last run; the rows newer than it carry that run's tools.
        const rows = (await api<any>("GET", `/api/session/${session}/message?order=desc&limit=${DIGEST_ROWS}`)).data ?? [];
        const at = rows.findIndex((row: any) => row.type === "user");
        if (at < 0) throw new Error(`thread ${session} has no user message to rewind`);""", 1)
rewind_clear = """        if (params.clear) {
          // Only a stage this session made can be cleared; the service answers 204 even with nothing staged.
          const tracked = state.staged.get(session);
          if (!tracked) {
            return {
              content: [{ type: "text", text: "no rewind staged in this session; nothing cleared" }],
              details: { session, rewound: false, target: "", branch: "", files: false },
            };
          }
          await revert("DELETE", `/api/session/${session}/revert`);
          state.staged.delete(session);
          return {
            content: [{ type: "text", text: `cleared the staged revert on ${session}; files are back at the run's state` }],
            details: { session, rewound: false, target: "", branch: "", files: true },
          };
        }"""
assert rewind_clear in control
control = control.replace(rewind_clear, """        if (params.clear) {
          await revert("DELETE", `/api/session/${session}/revert`);
          return {
            content: [{ type: "text", text: `cleared the staged revert on ${session}; files are back at the run's state` }],
            details: { session, rewound: false, target: "", branch: "", files: true },
          };
        }""", 1)
rewind_ask = """        // The stage rewrites files at once, so the human decision comes before the POST.
        if (!kept && !(await confirmStage(session, target, digestLabel, params.commit === true))) {
          return {
            content: [{ type: "text", text: "stage refused; nothing changed." }],
            details: { session, rewound: false, target: "", branch: "", files: false },
            isError: true,
          };
        }
        const stage = await revert("POST", `/api/session/${session}/revert/stage`, { messageID: target, files: !kept });
        const paths = pathsOf(stage);
        state.staged.set(session, target);"""
assert rewind_ask in control
control = control.replace(rewind_ask, """        const stage = await revert("POST", `/api/session/${session}/revert/stage`, { messageID: target, files: !kept });
        const paths = pathsOf(stage);
        state.staged.set(session, target);
        if (!kept && !(await confirmStage(session, target, digestLabel, params.commit === true))) {
          return {
            content: [{ type: "text", text: "stage refused; nothing changed." }],
            details: { session, rewound: false, target: "", branch: "", files: false },
            isError: true,
          };
        }""", 1)
rewind_noui = '      throw new Error("the revert stays staged; the commit needs a decision in a Pi TUI");'
assert rewind_noui in control
control = control.replace(rewind_noui, '      throw new Error("supervised commit needs a terminal dialog; run /oc-auto for this session, then retry");', 1)
rewind_nogit = """          if (!paths.length) {
            if (named.length) {
              return `no git history for this root, messages reverted, files untouched: ${named.join(", ")}`;
            }
            return "files restored: none";
          }"""
assert rewind_nogit in control
control = control.replace(rewind_nogit, '          if (!paths.length) return "files restored: none";', 1)
open('.control-rewind.ts','w').write(control)
budget_meter = "  const meter = limits?.data?.go?.rolling;"
assert budget_meter in src
control = src.replace(budget_meter, "  const meter = limits?.data?.go?.weekly;", 1)
budget_no_price = '  if (!price) return "";'
assert budget_no_price in control
control = control.replace(budget_no_price, '  if (!price) return "$0";', 1)
budget_attach = """    state.known.add(session);
    state.attached.add(session);
    // Adopt is not delegation: leave the thread out of the OC_BUDGET_TOKENS census."""
assert budget_attach in control
control = control.replace(budget_attach, """    state.known.add(session);
    state.attached.add(session);
    state.delegated.add(session);""", 1)
open('.control-budget.ts','w').write(control)
fan_hold = """    // A fan-out member is held until every member is terminal: one report per fan-out.
    const fanId = mine.fanMember.get(settle.session);
    if (fanId) {
      const fan = mine.fanouts.get(fanId);
      if (fan) {
        await acceptFanout(mine, fan, settle);
        return;
      }
    }
"""
assert fan_hold in src
fan = src.replace(fan_hold, "", 1)
fan_cap = """        const active = await api<any>("GET", "/api/session/active");
        // Active runs and this bridge's own armed watches are both live; the larger count wins.
        const live = Math.max(Object.keys(active?.data ?? {}).length, state.armed.size);
        if (live + requested.length > MAX_THREADS) {
          return {
            content: [{
              type: "text",
              text: `fan-out refused: ${live} live threads + ${requested.length} new exceed ${MAX_THREADS}`,
            }],
            details: { fanout: "", sessions: [] as string[] },
            isError: true,
          };
        }
"""
assert fan_cap in fan
fan = fan.replace(fan_cap, "", 1)
fan_skip = """          const skip = memberRefusal(limits, plan.providerID, plan.id);
          const member: FanMember = {
            session: "",
            model,
            variant,
            settle: null,
            skip: skip ? skip : null,
            fail: null,
            deadline: Date.now() + ttlMs,
          };
          fan.members.push(member);
          if (skip) {
            lines.push(`${model}  variant ${variant}  skipped: ${skip}`);
            continue;
          }
"""
assert fan_skip in fan
fan = fan.replace(fan_skip, """          const member: FanMember = {
            session: "",
            model,
            variant,
            settle: null,
            skip: null,
            fail: null,
            deadline: Date.now() + ttlMs,
          };
          fan.members.push(member);
""", 1)
fan_judge = """      if (fan.judgeModel) {
        fan.phase = "judge";
        await startJudge(mine, fan);
        return;
      }
"""
assert fan_judge in fan
fan = fan.replace(fan_judge, "", 1)
fan_seq = """    if (!Array.isArray(savedEntry) && typeof savedEntry?.fanSeq === "number") {
      state.fanSeq = Math.max(0, Math.floor(savedEntry.fanSeq));
    }
"""
assert fan_seq in fan
fan = fan.replace(fan_seq, "", 1)
open('.control-fanout.ts','w').write(fan)
PY

# Stage 12: the docs control carries two defects.
python3 - <<'PY'
import re
from pathlib import Path

pages = sorted(Path('docs').rglob('*.md'))
parts = []
for page in pages:
    parts.append(f'@@ {page.as_posix()}\n')
    parts.append(page.read_text())
text = ''.join(parts)

# Defect 1: remove the oc_fanout page and its index line.
start = re.search(r'^@@ docs/tools/oc_fanout\.md$', text, re.M)
assert start
end = re.search(r'^@@ ', text[start.end():], re.M)
text = text[:start.start()] + (text[start.end() + end.start():] if end else '')
text = re.sub(r'^- \[oc_fanout\]\(tools/oc_fanout\.md\)[^\n]*\n', '', text, count=1, flags=re.M)

# Defect 2: make the environment table disagree with the code.
text, n = re.subn(
    r'(?m)^(\| `OC_DEBOUNCE_MS` \| bridge \| `)[^`]+(` \|)',
    r'\g<1>500\g<2>',
    text,
    count=1,
)
assert n == 1
open('.control-docs.ts', 'w').write(text)
PY
```

Run from the package root. `BRIDGE` points a check at a control build.

```sh
for c in 4xx nowatch expire stale dup; do CASE=$c bun run checks/check-3-unit.ts; done
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
```

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

The control carries four defects: the newest-row floor (`live`), the unconditional arm (`idle`), the blind restore (`restore`), and the dropped watch on a failed read (`readfail`).

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
| `noui` | no UI keeps the stage staged, says the commit needs a Pi TUI, and does not advise `/oc-auto` |

The control carries five defects: the stage ask after the stage (`ask`), the newest-user-row target (`steered`), the untracked clear (`clear`), the no-UI advice (`noui`), and the plain no-files line in place of the no-git wording (`nogitroot`).

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
| `cap` | 30 live threads plus 3 new is refused with the count, before any create or prompt |
| `quota` | rolling 90 at `OC_BUDGET_PCT=80` skips the Go member, still creates and prompts both free members, and names the skip |
| `judge` | the judge thread receives all three answers, and its verdict joins the same report |

The control carries five defects: the fan-out hold, so every member wakes alone (`merge`, `fail`); the live-thread cap (`cap`); the Go-member quota skip (`quota`); the judge (`judge`); and the counter restore (`reload`).

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

The `env` case covers the twenty `OC_*` and `BRIDGE` names in the Environment table: twelve for the bridge, four for `oc-rpc.ts`, two for `oc-panes`, and two for the check scripts. `CASE`, `PATH`, and other check-local selectors are out of scope on purpose.

`check-5-live.ts` costs one real turn on a free model. It finds the largest idle thread above
`OC_COMPACT_TOKENS`, sends one short instruction through the bridge, and proves on the wire that the
compaction row precedes the reply and the size dropped. It prints `SKIP` when no thread qualifies.

`check-tui.sh` and `check-reload.sh` drive a real pi TUI through tmux, one pane snapshot per second,
and need a model, so they take `OC_CHECK_MODEL=<id from oc_models>`. They set `OC_ROOT` to a
temporary directory. `OC_PANES=0` keeps them out of Ghostty. Item 25 (pane columns only for armed
threads) has no check: a fake `HOME` does not move `os.homedir()` in bun, so a stub pane script
cannot be installed safely. Read the `oc_open` and `oc_send` bodies in `opencode-bridge.ts` instead.
@@ docs/commands/oc-accept.md
# /oc-accept

This page covers `/oc-accept`: it sends the asks to you.

Syntax: `/oc-accept`

Example:

```
> /oc-accept
OpenCode bridge: supervised — you answer every request
```

The command selects supervised mode. A session start resets the mode to supervised.
[supervision.md](../supervision.md) gives the ask rules.
@@ docs/commands/oc-attach.md
# /oc-attach

This page covers `/oc-attach`: it adopts an existing thread under `OC_ROOT`.

Syntax: `/oc-attach <ses_…>`

Example:

```
> /oc-attach ses_…
attached ses_… "attach-probe"
model: opencode-go/glm-5.3-flash variant default · 8k tokens · open asks: none · running
```

The command uses the same checks and receipt as `oc_attach`. A bad argument prints `usage: /oc-attach <ses_...>`; a refused thread prints `attach failed: <message>`.

The command changes no mode. [tools/oc_attach.md](../tools/oc_attach.md) gives the watch rule.
@@ docs/commands/oc-auto.md
# /oc-auto

This page covers `/oc-auto`: it sends the asks to the model in this Pi session.

Syntax: `/oc-auto`

Example:

```
> /oc-auto
OpenCode bridge: auto — model questions go to this session's model
```

The command selects unsupervised mode and flushes queued asks. A session start resets the mode to
supervised. [supervision.md](../supervision.md) gives the ask rules.
@@ docs/commands/oc-budget.md
# /oc-budget

This page covers `/oc-budget`: it prints the quota meters and the thread costs. `/oc_budget` is an
alias.

Syntax: `/oc-budget` or `/oc_budget`

Example:

```
> /oc-budget
ses_…  opencode-go/glm-5.3-flash max  1400k tok  ~$0.8500
go rolling 45% · resets 21:40 · weekly 45% · monthly 23%
budget org_…: $1.25 / $10.00 · opencode-go/glm-5.3-flash $0.40
```

The command forces a meter read. It prints one line per live thread, then the Go meters, then the
console budgets. With no live thread the first line reads `live threads: none`. With no meter the
meter line reads `quota: unreadable`. [budget.md](../budget.md) gives the meter and cost rules.
@@ docs/commands/oc-clean.md
# /oc-clean

This page covers `/oc-clean`: it lists or deletes finished threads under the root.

Syntax: `/oc-clean` or `/oc-clean force`

Example:

```
> /oc-clean
dry run: 2 under /home/you/Pi, 1 busy kept
ses_…  glm-5.3-flash  succeeded  12m  out 300  refactor-parser
run /oc-clean force to delete these
```

A dry run lists finished threads and keeps busy threads. A force run re-reads each thread, skips one
that started a run, and prints `oc-clean: deleted N, kept M busy`. With no finished thread it prints
`oc-clean: nothing to delete, M busy kept`.

The `force` argument changes the command from a list to a delete.
@@ docs/commands/oc-kill.md
# /oc-kill

This page covers `/oc-kill`: it stops a thread.

Syntax: `/oc-kill <ses_…>`

Example:

```
> /oc-kill ses_…
interrupted ses_…
```

The command prints `interrupted <session>` or `no run to interrupt in <session>`. A queued settle is
appended after `The run had already settled:`. A bad argument prints `usage: /oc-kill <ses_...>`.

The command changes no mode. [tools/oc_stop.md](../tools/oc_stop.md) gives the watch rule.
@@ docs/commands/oc-panes.md
# /oc-panes

This page covers `/oc-panes`: it controls the Ghostty columns.

Syntax: `/oc-panes open`, `/oc-panes close`, `/oc-panes list`, or `/oc-panes` for `list`.

Example:

```
> /oc-panes open
OpenCode columns: open done
```

The command needs a TUI and a pane script. It prints `OpenCode columns: off outside a terminal`,
`OpenCode columns: off (OC_PANES=0)`, `OpenCode columns: missing <path>`, or `usage: /oc-panes open | close | list`.

The argument selects the pane action; no argument means `list`.
@@ docs/commands/oc.md
# /oc

This page covers `/oc`: it prints the bridge status.

Syntax: `/oc`

Example:

```
> /oc
mode: supervised
service: http://127.0.0.1:49374
armed: 1
served: opencode-go/glm-5.3-flash, opencode-go/deepseek-v4.1-flash
ses_…  running  glm-5.3-flash  refactor-parser  attached
```

The command prints the mode, the service URL, the armed count, the served models, and up to eight
threads under the root. Adopted threads come first and carry `attached`. The `batched` part appears
only when the batch is not empty. The thread line shows `id`, `status`, model id, title, and
`attached`; `status` reads `running` while the thread is busy, otherwise it reads the stored
outcome.

The command takes no argument and changes no mode.
@@ docs/environment.md
# Environment

This page lists every environment variable that the bridge and its helper scripts read, with its
reader, default, and effect.

The bridge reads 12 of these variables. The other 8 belong to `oc-rpc.ts`, `oc-panes`, and the check
scripts. The reader column names the file that reads the variable.

| Variable | Reader | Default | Effect |
| --- | --- | --- | --- |
| `OC_ROOT` | bridge | `process.cwd()` | Thread root. The code uses the working directory at Pi start. Set it to the tree that threads may write. |
| `OC_SERVICE_FILE` | bridge, oc-panes | `~/.config/opencode/service.json` | File with the service password. |
| `OC_RETENTION` | bridge | `{}` | JSON map from a model id suffix to a display label. `oc_models` shows the label. A broken value gives no labels. |
| `OC_DEBOUNCE_MS` | bridge | `500` | Batch window for wake-ups, in ms. |
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
| `BRIDGE` | checks | `the repo's opencode-bridge.ts` | Build under test. The bridge checks import it; `check-12-docs` reads it as a docs bundle. |

`CASE` selects a `check-3` case. It is not part of the bridge contract.
@@ docs/lifecycle.md
# The watch lifecycle

This page covers the watch lifecycle: the floor, the deadline, the backstop poll, and the reload behaviour.

A watch is the bridge's promise of one wake-up. It holds a floor, a deadline, and a steer count. The
bridge arms a watch before it posts a prompt, because a run can settle in milliseconds. The floor is
the wall-clock time at the arm. The deadline is that time plus `OC_WATCH_TTL_S`. A new send replaces
the watch and resets the steer count. The bridge holds a fixed watch ceiling; an arm at the ceiling
throws `32 threads in flight; wait for one to settle with oc_wait.`

`oc_attach` arms a running thread with a floor of `time.busy - 1`, so the answer row of the run in
flight is inside the window. An idle thread gets no watch. `oc_wait` on a running thread with no
watch arms it with a floor of `time.idle`, or 0 when the thread has no idle row.

OpenCode keeps the old `time.idle` when a new run starts. Therefore `busy > idle` is the only
in-flight signal. A run is live when `Number(row.time.busy) > Number(row.time.idle)`. Any other test
reports the previous run, or calls a live run idle. The bridge uses this test in attach, steer,
restore, `/oc-budget`, and `/oc-clean`.

The settle window takes rows with `time.created` strictly greater than the floor, and at most
`time.idle + 1`. A row that carries the floor is out. This is why a floor set on a row drops that
row. The `+1` keeps the idle row that carries the run. The bridge finds the newest assistant row for
the answer, the idle row for the outcome, and the first row with an error as a fallback for the error
line. A compaction hides the context before it, so the digest starts after the newest compaction row.

The event stream reports `session.execution.succeeded`, `session.execution.failed`, and
`session.execution.interrupted`. The bridge claims the thread, reads the window, and drops the watch
on a real settle. A backstop poll reads each armed thread every `OC_BACKSTOP_MS` and covers a
dropped frame. A read that finishes after a new send or a stop does not spend the new watch. A
thread with no settle in the window keeps the watch.

A watch that passes its deadline settles as unknown. It does not report a running outcome or an
empty ask list. The report is:

```
outcome: unknown (watch expired; restart with oc_send to read the record)

error: none

answer: (none)

open asks: unreadable
```

`steers N` appears when the watch counted at least one steer. The watch is dropped after the report.
The record stays on the service: `oc_read` reads it, and `oc_send` starts a new run with a new watch.
Arm only a thread that can settle.

A Pi reload restores watches from the `oc-armed` session entry. The entry holds `fanSeq` and one row
per watch: `session`, `floor`, `steers`, and `attached`. On start, the bridge reads the thread. A
failed read keeps the watch, because the read may hide a live run. A real idle row drops the watch,
because the run settled while Pi was down. A real busy row restores the watch with the saved floor
and a fresh TTL. The fan-out counter also restores, so a `fan_<n>` id does not repeat.

`oc_stop` drops the watch and interrupts the run. `oc_stop` with `detach: true` drops the watch and
leaves the run going. A rewind refuses while a watch is armed.
@@ docs/sandbox.md
# Thread root sandbox

This page covers the thread root sandbox: `OC_ROOT`, the path checks, the symlink rule, and the
git-backed root that rewind needs.

`OC_ROOT` sets the thread root. The code default is the working directory at Pi start
(`process.cwd()`); [environment.md](environment.md) lists it. The examples use `~/Pi`; set `OC_ROOT`
to the tree that you want. The bridge resolves the root with `realpathSync` at load. A missing root
does not stop the load; a call that needs the root reports the missing directory.

Two checks keep threads inside the root. `directory()` handles a create path. It joins the input to
the root, refuses a path outside the root, requires the path to exist, and compares the real path.
`oc_open` and `oc_fanout` use it. `assertLocal()` handles a thread id. It reads the thread's
`location.directory`, compares the real path, refuses a thread outside the root, and remembers the
result for that thread. Every tool that takes a session id calls it. `oc_attach` reads the thread row
for `underRoot()` first, then calls `assertLocal()`; every other session tool calls `assertLocal()`
before any other service call. `oc_models` takes no session id.

A thread outside the root is refused with `Thread ses_… sits in <dir>, outside <root>.` `directory()`
and `assertLocal()` compare real paths, so a symlink cannot pass a thread outside the root. The list
in `/oc` and the delete pass in `/oc-clean` filter the raw reported directory with `underRoot()`.

The root must be a git repository for `oc_rewind` to restore files. The bridge does not check this;
the service does. In a root without git, the stage answers HTTP 200 with `files: []`, the working
tree does not move, and the receipt says `no git history for this root, messages reverted, files untouched: <paths>` when the digest named paths; with no paths it says `files restored: none`. The
message half still works: `commit` removes the run's messages after the target, `clear` drops the
stage, and `branch` forks. The digest still names the paths that the run touched. Make the root a git
repository before the run if you need file restore.

Threads can write files. Point `OC_ROOT` at a scratch tree that you own.
@@ docs/supervision.md
# Supervision

This page covers supervision: supervised and unsupervised mode, `--oc-auto`, the asks that need a
decision, and what a session start resets.

The bridge has two modes. `supervised` is the default. `unsupervised` sends each ask to the model in
this Pi session. `/oc-auto` selects unsupervised and flushes queued asks. `/oc-accept` selects
supervised. The flag `--oc-auto` starts a session in unsupervised mode. Every session start resets
the mode to supervised and drops per-thread state, so an old run cannot answer for a new session.

| Ask | Supervised, TUI | Supervised, no UI | Unsupervised |
| --- | --- | --- | --- |
| Permission | Dialog with `Allow this request?`; the answer is `once` or `reject`. | Message to this session when idle; queue when busy. | Message to the model. |
| Form | Message to this session when idle; queue when busy. A form needs field values, so it never uses a yes/no dialog. | Message when idle; queue when busy. | Message to the model. |
| Rewind file stage | Dialog before the stage. | Error; nothing changes. | Posts through. |
| Rewind commit with `files: false` | Dialog at the commit. | Error; the stage stays. | Posts through. |

Unsupervised mode does not approve a request by itself. It sends the ask to the model, and the model
must call `oc_reply` with a decision or a form answer. The ask message starts with `[opencode]` and
uses `deliverAs: "steer"`. A settle uses `deliverAs: "followUp"`.

A file rewind asks before it stages because `POST /revert/stage` with `files: true` rewrites the
working tree at once. The question names the target and the paths from the digest. A refusal calls
no stage and changes nothing. The same question covers a requested commit, because a file stage and
its commit are one decision. A `files: false` stage keeps the files and asks at the commit.

Without a UI, a supervised file stage stops with `supervised stage needs a decision in a Pi TUI; nothing changed`. A supervised commit stops with `the revert stays staged; the commit needs a decision in a Pi TUI`; for that commit, the stage stays staged. A permission or form ask still
reaches the session through the message path when the session is idle; when the session is busy, it
waits in the queue. The dialog path needs a TUI; a form never uses a yes/no dialog.

`permissionsJson` on `oc_open` sets a per-thread OpenCode ruleset. It does not change the bridge mode.
@@ docs/tools/oc_attach.md
# oc_attach

This page covers `oc_attach`: it adopts a thread that the bridge did not open.

Use it for a TUI thread or a thread from an earlier Pi session. It checks `underRoot` and
`assertLocal`. A running thread gets a watch with the floor just behind its run; an idle thread gets
no watch. The next `oc_send` arms an idle thread. A second attach on a watched thread returns
`already armed: <session>` and does not change the watch.

Call:

```
oc_attach session="ses_…"
```

Receipt:

```
attached ses_… "attach-probe"
model: opencode-go/glm-5.3-flash variant default · 8k tokens · open asks: none · running
```

An idle thread adds:

```
attached; idle, watch starts with your next oc_send
```

React to `already armed: <session>`: the existing watch stays. An ask read failure prints
`open asks: unreadable` instead of a count. `/oc` marks an adopted thread `attached`; a reload
restores that mark.

Limits: the tool fails when the thread is outside the root or the status read fails.
@@ docs/tools/oc_models.md
# oc_models

This page covers `oc_models`: it lists the models that the service serves for delegation.

The tool runs `opencode models` and keeps ids with the `opencode-go/` prefix or the `-free` suffix.
It reads `GET /api/model` for each variant ladder and list price. Read it before `oc_open`, because a
model id must be on this list.

Call:

```
oc_models
```

Receipt:

```
opencode-go/glm-5.3-flash  variants: low|high|max
opencode-go/deepseek-v4.1-flash  variants: low|high|max
opencode/an-example-free  variants: none
```

`variants: none` means the model takes no variant. `variants: unknown` means the ladder read failed.
A `retention:` label appears when `OC_RETENTION` matches the id suffix.

Limits: the tool fails when `opencode models` fails and returns the command error. A failed
`/api/model` read is not fatal: the ladder prints `unknown`, and a requested variant is accepted
because the ladder is undefined. A model that both providers serve is ambiguous; `oc_open` refuses
it until the caller adds the provider prefix.
@@ docs/tools/oc_open.md
# oc_open

This page covers `oc_open`: it opens a thread for one task.

The create path goes through `directory()`, so a subfolder must exist under the root. The tool
checks the budget before it creates the thread. With a `brief`, it arms a watch and posts the
prompt. With no `brief`, the thread exists and has no watch; the next `oc_send` arms one.

Call:

```
oc_open model="opencode-go/glm-5.3-flash" variant="max" title="refactor-parser" brief="Fix the parser and add a test."
```

Parameters: `model` (string, required), `variant` (string, optional; default `high` when the ladder
offers it), `title` (string, required), `brief` (string, optional), `directory` (string, optional),
`permissionsJson` (string, optional).

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

No brief: the receipt is the session id alone. `permissionsJson` is a JSON ruleset, for example `[{"action":"*","resource":"*","effect":"ask"}]`.

React to `brief failed: <message>`: the thread id stays, and the brief did not land. A 4xx drops the
watch; a timeout keeps it, because the service may still run the prompt. A failed compaction does
not stop the prompt; `compact ordered at N` means the bridge sent the order and did not wait for a
result.

Limits: the tool fails when the model is not on the list, the id is ambiguous, the variant is not on
the ladder, the directory is missing or outside the root, the budget ceiling refuses the open, the
watch ceiling refuses the arm, or the brief POST fails. Invalid `permissionsJson` throws before the
create.
@@ docs/tools/oc_read.md
# oc_read

This page covers `oc_read`: it shows the latest messages of a thread.

The tool skips `idle` status rows when other rows exist, so `limit: 1` returns the answer. `parts: "full"` adds reasoning and tool input, status, result, and error. Each message body stops at 4000
characters; `offset` skips characters in each body. The whole result stops at 24,000 characters.

Call:

```
oc_read session="ses_…" limit=3 parts="full"
```

Parameters: `session` (string, required), `limit` (number, optional; 1 to 25, default `6`), `parts`
(`text` or `full`, optional), `offset` (number, optional).

Receipt:

```
[user] Add a test for the parser.

[assistant stop] tokens in/out/reasoning 1200/300/0, cache 0, cost 0.0012
Done. The test sits in test/parser.test.ts.
```

With `parts: "full"`, a tool call reads `[tool read completed] input={"path":"src/parser.ts"} result=...`. A failed tool adds `error=<message>`.

React to a body past the cap: it ends with `… truncated; read with oc_read offset=4000`, and the
next call with `offset=4000` reads the next part. A body past the offset prints `(no text past offset N, body is M chars)`.

Limits: the tool fails when the thread is outside the root or the message read fails.
@@ docs/tools/oc_reply.md
# oc_reply

This page covers `oc_reply`: it answers one open permission or form ask by id.

The tool reads the open asks first, so it knows the kind. A permission needs `decision` (`once`,
`always`, or `reject`). A form needs `answerJson`, a JSON object keyed by the form's field names.

Call:

```
oc_reply session="ses_…" id="per_…" decision="once"
```

Parameters: `session` (string, required), `id` (string, required), `decision` (string, optional),
`answerJson` (string, optional).

Receipts:

```
permission per_… -> once
form frm_… answered
```

React to `<id> is not open on <session>. oc_wait lists its open asks.`: the id is not open; read the
asks again. React to `Cannot read the asks on <session>. Retry oc_reply.`: the ask read failed. A
settled ask answers `<id> is already settled or gone. Read the thread with oc_read.` An invalid form
answer prints the JSON error.

Limits: the tool fails when the thread is outside the root. A permission without a decision and a
form without `answerJson` fail before any POST.
@@ docs/tools/oc_rewind.md
# oc_rewind

This page covers `oc_rewind`: it undoes the last run of a thread.

The tool refuses while a watch is armed; stop the run with `oc_stop`, or drop the watch with `oc_stop detach: true`, then retry. The target is the oldest user row at or after `time.busy - 1` in the
message window that [wake-up.md](../wake-up.md) states. A steer writes a newer user row, so a steer is
not the target. If the opening row is older than the window, the tool asks for `branch: true` or a
shorter run; it does not stage a false target.

Call:
```
oc_rewind session="ses_…"
```
Parameters: `session` (string, required), `files` (boolean, optional; default `true`), `commit`
(boolean, optional), `branch` (boolean, optional), `clear` (boolean, optional). `branch` conflicts
with `commit` and `clear`; `commit` conflicts with `clear`.

Receipt:
```
rewound ses_… to msg_…
files restored: src/note.txt
digest 2 calls (1 ok, 1 err) · shell 1 · write 1 · fails: shell: exit 1 · files: src/note.txt
staged; clear restores these files, commit makes it permanent.
```
`files: false` keeps the files and prints `files kept (files:false)`; the tail reads `staged messages only; clear drops the stage, commit makes it permanent.` `commit: true` stages, then commits; the tail
reads `committed; the run's messages after msg_… are gone.` `clear: true` on a stage that this Pi
session made deletes the stage and prints `cleared the staged revert on ses_…; files are back at the run's state`. With no tracked stage it prints `no rewind staged in this session; nothing cleared` and
makes no call.

`branch: true` forks before the target and attaches the child:
```
forked ses_… before msg_…: ses_…
attached ses_…
...
```
A file stage asks in supervised mode before the POST. A commit after a `files: false` stage asks at
the commit. [supervision.md](../supervision.md) gives the ask rules.
Limits: the tool fails when the thread is outside the root, a watch is armed, the opening row is
outside the window, or the service answers 409 because the run is live. The bridge maps that 409 to
`thread ses_… is busy; wait for its settle or stop it with oc_stop, then retry`. A file stage in a
root without git answers 200 with no files; [sandbox.md](../sandbox.md) gives the receipt.
@@ docs/tools/oc_send.md
# oc_send

This page covers `oc_send`: it hands an instruction to a thread and returns.

The tool checks the budget, adds the thread to the delegated set, arms a watch, and posts the
prompt. A successful send removes a pending batch entry for that thread, so an older settle does not
wake the model after the new instruction. The settle opens a later turn.

Call:

```
oc_send session="ses_…" text="Add a test for the parser."
```

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

`compact ordered at N` appears when the newest answer size is above `OC_COMPACT_TOKENS`. The bridge
posts `/compact` with `delivery: "steer"` before the prompt. OpenCode runs the compaction at the step
boundary, so the prompt lands on the compacted context. The bridge orders one compaction per send; a
refused compaction does not stop the prompt.

Limits: the tool fails when the thread is outside the root, the budget ceiling refuses the send, the
watch ceiling refuses the arm, or the prompt POST fails. A 404 drops the watch. A 4xx that is not 404
drops the watch when no earlier watch exists; a timeout keeps it, because the service may still run
the prompt. A 409 from a run that the bridge did not arm leaves no watch.
@@ docs/tools/oc_steer.md
# oc_steer

This page covers `oc_steer`: it corrects a running thread in place.

The steer applies at the next step boundary. The tool reads the thread first: if `busy <= idle`, it
refuses and posts nothing. A busy thread with a watch accepts the steer and does not re-arm; the
watch still gives one wake-up and counts the steer. A busy thread with no watch accepts the steer
with no wake-up. The service accepts any number of steers; each applies at its own boundary.

Call:

```
oc_steer session="ses_…" text="Use the existing parser, do not rewrite it."
```

Parameters: `session` (string, required), `text` (string, required).

Receipts:

```
steer admitted at 14:03:07 · applies at the next step boundary
steer admitted (no watch, no wake-up)
```

React to `run already settled; oc_send starts a new one`: the run is over; use `oc_send`. React to
`a send is in flight; retry oc_steer`: a prompt POST is open for that thread. `steer refused: HTTP 409; the run stays` means the service rejected the steer and the run continues; the code handles
409 defensively, but a steer on a busy thread normally answers 200 and applies at the step boundary.

The settle body shows `steers N` when the watch counted at least one steer; a record read with no
live watch omits it.

Limits: the tool fails when the thread is outside the root. The tool does not send a steer to an
idle thread, even though the service would start a new run; use `oc_send`. Any other service error
is thrown.
@@ docs/tools/oc_stop.md
# oc_stop

This page covers `oc_stop`: it interrupts a running thread, or drops its watch.

The tool removes the watch before the interrupt, so the interrupted event does not open a turn. A
settle that the stream missed sits in the batch; this call carries it instead of losing it. If the
interrupt POST fails, the watch and the queued settle go back.

Call:

```
oc_stop session="ses_…" detach=true
```

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

`detach: true` never posts `/interrupt`; it drops the watch, drops a queued settle for that thread,
and leaves the run going.

Limits: the tool fails when the thread is outside the root or the interrupt POST fails.
@@ docs/tools/oc_wait.md
# oc_wait

This page covers `oc_wait`: it collects a settle inside the current turn.

Use it when no wake-up can arrive: print mode, JSON mode, a settle that landed during a reload, or a
turn that needs the answer before it continues. It waits on the same detector as the wake-up, so a
collected settle does not wake the model twice.

Call:
```
oc_wait session="ses_…" timeoutSec=60
```
Parameters: `session` (string, required), `since` (number, optional), `timeoutSec` (number, optional; default `OC_WAIT_MAX_S`, which is also its ceiling).

Receipt:
```
outcome: succeeded

error: none

answer:
The parser now accepts the new syntax.

open asks: none

digest 5 calls (5 ok) · shell 4 · read 1 · fails: none · files: src/parser.ts
```
`since` reads the record after a Unix-ms point and does not wait. `0` reads the whole record. Omit
`since` to start from the current watch. A thread with no watch and no `since` gets a watch when it
is still running, so the call can wait for its settle; at the watch ceiling, the call reads the
record instead.

React to `still running after Ns; the watch stays armed`: the timeout passed and the watch remains.
`no settle after N; ...` means the record has no settle after that point. `already reported: ...`
means the wake-up or an earlier `oc_wait` already carried that run; `oc_read` shows the record.
`thread is gone` and `thread unreadable` are errors. `wait cancelled; the settle stays queued` means
Pi aborted the call; the wake-up still carries the settle.

A fan-out member waits for the composite report. A `since` read returns the newest settle after the
point, or `no settle after ...`.

Limits: the tool fails when the thread is outside the root or the record read fails.
@@ docs/troubleshooting.md
# Troubleshooting

This page maps each common symptom to its cause and its fix.

| Symptom | Cause | Fix |
| --- | --- | --- |
| No wake-up arrives. | Print or JSON mode has no active turn; a reload dropped the batch; an aborted run holds the batch; a compaction holds it; a 4xx prompt dropped the watch. | Use `oc_wait` or `oc_read`. Send a new instruction with `oc_send` to arm a new run. Wait for the compaction to end. Send a human message to release a held batch. |
| `outcome: unknown (watch expired; restart with oc_send to read the record)` | The run passed `OC_WATCH_TTL_S` with no settle. | Read the record with `oc_read`. Raise `OC_WATCH_TTL_S` and restart Pi for long runs. Use `oc_send` to start a new run with a new watch. |
| `run already settled; oc_send starts a new one` | `oc_steer` found `busy <= idle`; the run is over. | Use `oc_send` for a new run. Use `oc_read` for the answer. |
| `already armed: ses_…` | `oc_attach` found a live watch. | Use the watch with `oc_read` or `oc_wait`. To replace it, run `oc_stop detach: true`, then attach again. |
| `no git history for this root, messages reverted, files untouched: <paths>` | The root is not a git repository, so the stage returned no files. | Make the root a git repository before the run. The messages are already reverted. |
| `files restored: none` | The run made no file edits, or the target has no file changes. | Accept the message revert. `files: false` prints `files kept (files:false)`. |
| A budget refusal names a ceiling with quota left. | `OC_BUDGET_TOKENS` sums the whole history of every delegated thread; `OC_BUDGET_PCT` reads the rolling meter, not the weekly or monthly meter; the meter snapshot can be stale. | Run `/oc-budget` to force a read. Delete or clean heavy threads. Raise the cap or set it to `0`, then restart Pi. Wait for the reset. |
| `OpenCode service not reachable` | The service is down, the port changed, or the password file is wrong. | Run `opencode service status` and `opencode serve --service`. Check `OC_SERVICE_FILE`. Restart the service. |
| `open asks: unreadable` | The ask read failed during the settle. | Read the thread with `oc_read`. Retry `oc_wait` or `oc_reply`. |
| `rewind refused: ses_… has an armed watch` | A watch is live. | Run `oc_stop`, or `oc_stop detach: true`, then retry the rewind. |
@@ docs/wake-up.md
# Anatomy of a wake-up

This page covers the anatomy of a wake-up: the batch rules, the message blocks, and the digest line.

The bridge sends one message per debounced batch. `OC_DEBOUNCE_MS` sets the batch window. Two
settles inside the window produce one message. The message is a follow-up, so Pi queues it for the
next turn when a run is active. A run that the human aborted holds the batch until the next
human-started run settles; the head then says `settled while the run was cancelled`. A compaction
holds the batch until the compaction ends. Print and JSON modes do not send a wake-up. A reload
drops the in-memory batch and restores the watch from `oc-armed`; a settle that landed during the
reload can have no wake-up when the thread is already idle at start. In those cases `oc_wait`
collects the settle.

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

The answer body passes through the read cap that [tools/oc_read.md](tools/oc_read.md) states;
`oc_read` with `offset` reads the next part. A form detail uses the same cap. A permission detail
stops at 1200 characters. The whole `oc_read` result has its own cap in the same tool page.

`steers N` comes from the live watch. A record read with `since` and no live watch omits the count,
because the bridge cannot know it. A fan-out report has no steer count.

`outcome` reads `unknown` when the fresh window has no idle row and the session row has no outcome,
or when the watch expired. The bridge does not map an unknown outcome to `succeeded` or `failed`.

A fan-out report uses a different body: `outcome: fan-out N models`, then one section per member in
caller order, then the judge verdict. [tools/oc_fanout.md](tools/oc_fanout.md) gives the shape.

## Digest line

The digest starts after the newer of the watch floor and the newest compaction row, so a compacted
context does not show calls from before the compaction. The bridge reads the 200-row window once for
the report. The line gives the call count and the ok/error split, the calls per tool name, the first
five failures (tool name and first error line, each reason capped at 120 characters), the open ask
count when it is above zero, and the touched paths (edits before reads, at most ten). A running call
adds `unfinished: N`.

The line stays at or below 400 characters. The path list shrinks first, then the failure list. A
last-resort cut keeps one failure. A watch that expires has no digest. On the backstop path, a wide
read that fails falls back to the 8-row settle, so that report has no digest.
