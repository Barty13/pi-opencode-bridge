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
- [oc_fanout](tools/oc_fanout.md) — sends one brief to several models.
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
