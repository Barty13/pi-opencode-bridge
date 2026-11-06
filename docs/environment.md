# Environment

This page lists every environment variable that the bridge and its helper scripts read, with its
reader, default, and effect.

The bridge reads 14 of these variables. The rest belong to `oc-rpc.ts`, `oc-panes`, and the check
scripts. The reader column names the file that reads the variable.

| Variable | Reader | Default | Effect |
| --- | --- | --- | --- |
| `OC_ROOT` | bridge | `process.cwd()` | Thread root. The code uses the working directory at Pi start. Set it to the tree that threads may write. |
| `OC_SERVICE_FILE` | bridge, oc-panes | `~/.config/opencode/service.json` | File with the service password. |
| `OC_RETENTION` | bridge | `{}` | JSON map from a model id suffix to a display label. `oc_models` shows the label. A broken value gives no labels. |
| `OC_DEBOUNCE_MS` | bridge | `400` | Batch window for wake-ups, in ms. |
| `OC_BACKSTOP_MS` | bridge | `5000` | Gap between backstop polls, in ms. |
| `OC_STREAM_GAP_MS` | bridge | `90000` | Silent stream gap before the reader reconnects, in ms. |
| `OC_WATCH_TTL_S` | bridge | `1800` | Watch life, in seconds. |
| `OC_WAIT_MAX_S` | bridge | `300` | Ceiling for `oc_wait`, in seconds. |
| `OC_COMPACT_TOKENS` | bridge | `500_000` | Thread size above which a send orders a compaction first. `0` turns the gate off. |
| `OC_BUDGET_PCT` | bridge | `0` | Refuse open and send while the Go rolling meter is at or above this percent. `0` turns the ceiling off. |
| `OC_BUDGET_TOKENS` | bridge | `0` | Cap the token total of delegated threads. `0` turns the cap off. |
| `OC_MAX_THREADS` | bridge | `32` | Ceiling for in-flight watches and for a fan-out, judge included. |
| `OC_HUD` | bridge | `on` | `0` removes the footer and the thread table. |
| `OC_PANES` | bridge | `oc-panes next to the extension` | Path to the pane script. `0` turns columns off. |
| `OC_RPC_MODEL` | oc-rpc | `""` | Model id for the RPC check. Set it to an id from `oc_models`. |
| `OC_RPC_SCENARIO` | oc-rpc | `wake` | RPC case: `wake`, `send`, `wait`, `stop`, or `since`. |
| `OC_RPC_DEADLINE_MS` | oc-rpc | `240_000` | Deadline for the RPC check, in ms. |
| `OC_EXTENSION` | oc-rpc | `opencode-bridge.ts next to oc-rpc.ts` | Extension file that the RPC check loads. |
| `OC_PANES_FONT` | oc-panes | `13` | Font size in a new pane. |
| `OC_CHECK_MODEL` | checks | `required` | Model id for `check-tui.sh` and `check-reload.sh`. |
| `BRIDGE` | checks | `the repo's opencode-bridge.ts` | Build under test. The bridge checks import it; `check-12-docs` reads it as a docs bundle. |

`CASE` selects a `check-3` case. It is not part of the bridge contract.
