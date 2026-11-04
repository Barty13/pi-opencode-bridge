# Bridge checks

Model-free checks run against a stub `pi` and a stub service. Each has a control: a build with the
fix removed, which must fail. Generate the controls, then run.

```sh
python3 - <<'PY'
src = open('opencode-bridge.ts').read()
pairs = [
 ("      if (mine.armed.get(session) !== w || mine.sending.has(session)) {\n        mine.claimed.delete(session);  // or detect/sweep skip it until the 30 min TTL (:701, :732)\n        continue;\n      }", "      if (mine.armed.get(session) !== w || mine.sending.has(session)) continue;"),
 ("      else if (/HTTP 4\\d\\d/.test(String(error))) dropThread(session);\n", ""),
 ('session, title: "", outcome: "unknown", error: null, answer: "", asks: [],\n          asksUnknown: true, idleAt: Date.now(), steers: w.steers, expired: true,', 'session, title: "", outcome: "running", error: null, answer: "", asks: [], idleAt: Date.now(), steers: w.steers, expired: true,'),
 ("      markReported(settle.asks);\n      // This message is the report for these runs; a later oc_wait must not repeat them.\n      mine.reportedRun.set(settle.session, settle.idleAt);", "      markReported(settle.asks);"),
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
PY
```

Run from this directory. `BRIDGE` points a check at a control build.

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

`check-5-live.ts` costs one real turn on a free model. It finds the largest idle thread above
`OC_COMPACT_TOKENS`, sends one short instruction through the bridge, and proves on the wire that the
compaction row precedes the reply and the size dropped. It prints `SKIP` when no thread qualifies.

`check-tui.sh` and `check-reload.sh` drive a real pi TUI through tmux, one pane snapshot per second,
and need a model, so they take `OC_CHECK_MODEL=<id from oc_models>`. They set `OC_ROOT` to a
temporary directory. `OC_PANES=0` keeps them out of Ghostty. Item 25 (pane columns only for armed
threads) has no check: a fake `HOME` does not move `os.homedir()` in bun, so a stub pane script
cannot be installed safely. Read the `oc_open` and `oc_send` bodies in `opencode-bridge.ts` instead.
