# Troubleshooting

This page maps each common symptom to its cause and its fix.

| Symptom | Cause | Fix |
| --- | --- | --- |
| No wake-up arrives. | Print or JSON mode has no active turn; a reload dropped the batch; an aborted run holds the batch; a compaction holds it; a 4xx prompt dropped the watch. | Use `oc_wait` or `oc_read`. Send a new instruction with `oc_send` to arm a new run. Wait for the compaction to end. Send a human message to release a held batch. |
| `outcome: unknown (watch expired; restart with oc_send to read the record)` | The thread stopped answering, or every read failed, for `OC_WATCH_TTL_S`. A run that stays busy renews its deadline instead. | Read the record with `oc_read`. Raise `OC_WATCH_TTL_S` and restart Pi for long runs. Use `oc_send` to start a new run with a new watch. |
| `run already settled; oc_send starts a new one` | `oc_steer` found `busy <= idle`; the run is over. | Use `oc_send` for a new run. Use `oc_read` for the answer. |
| `already armed: ses_…` | `oc_attach` found a live watch. | Use the watch with `oc_read` or `oc_wait`. To replace it, run `oc_stop detach: true`, then attach again. |
| `no git history for this root, messages reverted, files untouched: <paths>` | The root is not a git repository, so the stage returned no files. | Make the root a git repository before the run. The messages are already reverted. |
| `files restored: none` | The run made no file edits, or the target has no file changes. | Accept the message revert. `files: false` prints `files kept (files:false)`. |
| A budget refusal names a ceiling with quota left. | `OC_BUDGET_TOKENS` sums the whole history of every delegated thread; `OC_BUDGET_PCT` reads the rolling meter, not the weekly or monthly meter; the meter snapshot can be stale. | Run `/oc-budget` to force a read. Delete or clean heavy threads. Raise the cap or set it to `0`, then restart Pi. Wait for the reset. |
| `OpenCode service not reachable` | The service is down, the port changed, or the password file is wrong. | Run `opencode service status` and `opencode serve --service`. Check `OC_SERVICE_FILE`. Restart the service. |
| `open asks: unreadable` | The ask read failed during the settle. | Read the thread with `oc_read`. Retry `oc_wait` or `oc_reply`. |
| `rewind refused: ses_… has an armed watch` | A watch is live. | Run `oc_stop`, or `oc_stop detach: true`, then retry the rewind. |
