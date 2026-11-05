# The watch lifecycle

This page covers the watch lifecycle: the floor, the deadline, the backstop poll, and the reload behaviour.

A watch is the bridge's promise of one wake-up. It holds a floor, a deadline, and a steer count. The
bridge arms a watch before it posts a prompt, because a run can settle in milliseconds. The floor is
the wall-clock time at the arm. The deadline is that time plus `OC_WATCH_TTL_S`. A new send replaces
the watch and resets the steer count. The bridge holds a watch ceiling from `OC_MAX_THREADS`; an arm
at the ceiling throws `<n> threads in flight; wait for one to settle with oc_wait.`, where `<n>` is
the configured value.

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
