#!/usr/bin/env bash
# TUI checks 19, 21, 6 through tmux. OC_PANES=0 keeps the bridge out of Ghostty.
# Snapshots of the pane go to $OUT, one per second, for reading afterwards.
set -u
# Real model, so the id comes from the operator: any id that `oc_models` lists.
MODEL="${OC_CHECK_MODEL:?set OC_CHECK_MODEL to a model id from oc_models}"
EXT="${EXT:-$(cd "$(dirname "$0")/.." && pwd)/opencode-bridge.ts}"
OUT=/tmp/oc-tui-$(date +%s); mkdir -p "$OUT"
run="OC_PANES=0 OC_HUD=1 OC_ROOT=$OUT/threads pi --no-session --no-extensions --extension $EXT --approve"

snap() { for i in $(seq 1 "$1"); do tmux capture-pane -t "$2" -p > "$OUT/$3-$(printf %03d $i).txt" 2>/dev/null; sleep 1; done; }

echo "out=$OUT"

# --- A: HUD tick (19) and watch durability across /reload (21)
tmux new-session -d -s ocA -x 200 -y 50 "$run"
sleep 12
tmux send-keys -t ocA -l 'call oc_open with model $MODEL, title tick, and brief: Write the numbers 1 to 400, one per line, no tools.'
tmux send-keys -t ocA Enter
snap 30 ocA A
tmux send-keys -t ocA -l '/reload'
tmux send-keys -t ocA Enter
sleep 6
snap 8 ocA A-post
tmux send-keys -t ocA -l 'call oc_wait on the OpenCode session id from before the reload, then reply with its first two lines'
tmux send-keys -t ocA Enter
snap 50 ocA A-wait
tmux kill-session -t ocA 2>/dev/null

# --- B: an ask that lands with no human input in flight (6)
tmux new-session -d -s ocB -x 200 -y 50 "$run"
sleep 12
tmux send-keys -t ocB -l 'call oc_open with model $MODEL, title ask, permissionsJson [{"action":"*","resource":"*","effect":"ask"}], and brief: run the shell command ls with your bash tool. then reply OPENED'
tmux send-keys -t ocB Enter
snap 70 ocB B
tmux kill-session -t ocB 2>/dev/null
echo done
