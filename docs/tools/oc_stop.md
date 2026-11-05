# oc_stop

This page covers `oc_stop`: it interrupts a running thread, or drops its watch.

The tool removes the watch before the interrupt, so the interrupted event does not open a turn. A
settle that the stream missed sits in the batch; this call carries it instead of losing it. If the
interrupt POST fails, the watch and the queued settle go back.

Call:

```
oc_stop session="ses_…" detach=true
```

Parameters: `session` (string, required), `detach` (boolean, optional).

Receipts:

```
interrupted
no run to interrupt
detached; the run keeps going
no watch to detach
```

With a queued settle:

```
no run to interrupt

The run had already settled:
outcome: succeeded
...
```

`detach: true` never posts `/interrupt`; it drops the watch, drops a queued settle for that thread,
and leaves the run going.

Limits: the tool fails when the thread is outside the root or the interrupt POST fails.
