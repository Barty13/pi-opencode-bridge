#!/usr/bin/env bash
# Item 21: an armed watch must survive /reload. The thread must still be running when /reload lands,
# so the brief is a sleep, and /reload comes 8s after the send.
set -u
MODEL="${OC_CHECK_MODEL:?set OC_CHECK_MODEL to a model id from oc_models}"
EXT="${EXT:-$(cd "$(dirname "$0")/.." && pwd)/opencode-bridge.ts}"
OUT=/tmp/oc-reload-$(date +%s); mkdir -p "$OUT"
snap() { for i in $(seq 1 "$1"); do tmux capture-pane -t "$2" -p > "$OUT/$3-$(printf %03d $i).txt"; sleep 1; done; }
echo "out=$OUT"
tmux new-session -d -s ocR -x 200 -y 50 "OC_PANES=0 OC_HUD=1 OC_ROOT=$OUT/threads pi --no-session --no-extensions --extension $EXT --approve"
sleep 12
tmux send-keys -t ocR -l 'call oc_open with model $MODEL, title reload, and brief: run the shell command: sleep 90. then reply OPENED'
tmux send-keys -t ocR Enter
sleep 8
snap 3 ocR pre
tmux send-keys -t ocR -l '/reload'
tmux send-keys -t ocR Enter
snap 12 ocR post
tmux send-keys -t ocR -l 'call oc_wait on the OpenCode session id from before the reload, then reply with its first line only'
tmux send-keys -t ocR Enter
snap 45 ocR wait
tmux kill-session -t ocR 2>/dev/null
echo done
