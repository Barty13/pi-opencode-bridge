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
for c in 4xx nowatch expire stale dup ceiling handle; do CASE=$c bun run checks/check-3-unit.ts; done
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

`check-13-panes.ts` runs the `oc-panes` input cases against a fake `osascript` on `PATH`:

| Case | What it proves |
| --- | --- |
| `live` | a benign `add` reaches `osascript`, so a silent run below means a rejection |
| `dir` | a directory with an apostrophe exits non-zero, prints one line, and calls no `osascript` |
| `state` | a corrupt pane id in the state file is dropped by `rm`, which still exits 0 and calls no `osascript` |

One run covers the three cases in that order, and the marker file is the only signal for whether `osascript` ran.
