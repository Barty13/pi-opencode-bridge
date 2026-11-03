# Bridge checks

Model-free checks run against a stub `pi` and a stub service. Each has a control: a build with the
fix removed, which must fail. Generate the controls, then run.

```sh
python3 - <<'PY'
src = open('opencode-bridge.ts').read()
pairs = [
 ("      if (mine.armed.get(session) !== w || mine.sending.has(session)) {\n        mine.claimed.delete(session);  // or detect/sweep skip it until the 30 min TTL (:701, :732)\n        continue;\n      }", "      if (mine.armed.get(session) !== w || mine.sending.has(session)) continue;"),
 ("      else if (/HTTP 4\\d\\d/.test(String(error))) dropThread(session);\n", ""),
 ('session, title: "", outcome: "unknown", error: null, answer: "", asks: [],\n          asksUnknown: true, idleAt: Date.now(), expired: true,', 'session, title: "", outcome: "running", error: null, answer: "", asks: [], idleAt: Date.now(), expired: true,'),
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
PY
```

Run from this directory. `BRIDGE` points a check at a control build.

```sh
for c in 4xx nowatch expire stale dup; do CASE=$c bun run checks/check-3-unit.ts; done
bun run checks/check-1-compact.ts
BRIDGE=file://$PWD/.control-bridge.ts CASE=stale bun run checks/check-3-unit.ts   # must fail
BRIDGE=file://$PWD/.control-bridge.ts CASE=dup bun run checks/check-3-unit.ts     # must fail
BRIDGE=file://$PWD/.control-compact.ts bun run checks/check-1-compact.ts          # must fail
```

`check-tui.sh` and `check-reload.sh` drive a real pi TUI through tmux, one pane snapshot per second,
and need a model, so they take `OC_CHECK_MODEL=<id from oc_models>`. They set `OC_ROOT` to a
temporary directory. `OC_PANES=0` keeps them out of Ghostty. Item 25 (pane columns only for armed
threads) has no check: a fake `HOME` does not move `os.homedir()` in bun, so a stub pane script
cannot be installed safely. Read the `oc_open` and `oc_send` bodies in `opencode-bridge.ts` instead.
