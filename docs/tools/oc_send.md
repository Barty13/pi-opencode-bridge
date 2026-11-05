# oc_send

This page covers `oc_send`: it hands an instruction to a thread and returns.

The tool checks the budget, adds the thread to the delegated set, arms a watch, and posts the
prompt. A successful send removes a pending batch entry for that thread, so an older settle does not
wake the model after the new instruction. The settle opens a later turn.

Call:

```
oc_send session="ses_…" text="Add a test for the parser."
```

Parameters: `session` (string, required), `text` (string, required).

Receipt:

```
sent; the settle will open a turn, keep working
```

With a compaction:

```
sent; the settle will open a turn, keep working
compact ordered at 612k
```

`compact ordered at N` appears when the newest answer size is above `OC_COMPACT_TOKENS`. The bridge
posts `/compact` with `delivery: "steer"` before the prompt. OpenCode runs the compaction at the step
boundary, so the prompt lands on the compacted context. The bridge orders one compaction per send; a
refused compaction does not stop the prompt.

Limits: the tool fails when the thread is outside the root, the budget ceiling refuses the send, the
watch ceiling refuses the arm, or the prompt POST fails. A 404 drops the watch. A 4xx that is not 404
drops the watch when no earlier watch exists; a timeout keeps it, because the service may still run
the prompt. A 409 from a run that the bridge did not arm leaves no watch.
