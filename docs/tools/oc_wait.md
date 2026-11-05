# oc_wait

This page covers `oc_wait`: it collects a settle inside the current turn.

Use it when no wake-up can arrive: print mode, JSON mode, a settle that landed during a reload, or a
turn that needs the answer before it continues. It waits on the same detector as the wake-up, so a
collected settle does not wake the model twice.

Call:
```
oc_wait session="ses_…" timeoutSec=60
```
Parameters: `session` (string, required), `since` (number, optional), `timeoutSec` (number, optional; default `OC_WAIT_MAX_S`, which is also its ceiling).

Receipt:
```
outcome: succeeded

error: none

answer:
The parser now accepts the new syntax.

open asks: none

digest 5 calls (5 ok) · shell 4 · read 1 · fails: none · files: src/parser.ts
```
`since` reads the record after a Unix-ms point and does not wait. `0` reads the whole record. Omit
`since` to start from the current watch. A thread with no watch and no `since` gets a watch when it
is still running, so the call can wait for its settle; at the watch ceiling, the call reads the
record instead.

React to `still running after Ns; the watch stays armed`: the timeout passed and the watch remains.
`no settle after N; ...` means the record has no settle after that point. `already reported: ...`
means the wake-up or an earlier `oc_wait` already carried that run; `oc_read` shows the record.
`thread is gone` and `thread unreadable` are errors. `wait cancelled; the settle stays queued` means
Pi aborted the call; the wake-up still carries the settle.

A fan-out member waits for the composite report. A `since` read returns the newest settle after the
point, or `no settle after ...`.

Limits: the tool fails when the thread is outside the root or the record read fails.
