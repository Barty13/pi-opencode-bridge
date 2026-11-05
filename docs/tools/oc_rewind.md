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
