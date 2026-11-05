# oc_steer

This page covers `oc_steer`: it corrects a running thread in place.

The steer applies at the next step boundary. The tool reads the thread first: if `busy <= idle`, it
refuses and posts nothing. A busy thread with a watch accepts the steer and does not re-arm; the
watch still gives one wake-up and counts the steer. A busy thread with no watch accepts the steer
with no wake-up. The service accepts any number of steers; each applies at its own boundary.

Call:

```
oc_steer session="ses_…" text="Use the existing parser, do not rewrite it."
```

Parameters: `session` (string, required), `text` (string, required).

Receipts:

```
steer admitted at 14:03:07 · applies at the next step boundary
steer admitted (no watch, no wake-up)
```

React to `run already settled; oc_send starts a new one`: the run is over; use `oc_send`. React to
`a send is in flight; retry oc_steer`: a prompt POST is open for that thread. `steer refused: HTTP 409; the run stays` means the service rejected the steer and the run continues; the code handles
409 defensively, but a steer on a busy thread normally answers 200 and applies at the step boundary.

The settle body shows `steers N` when the watch counted at least one steer; a record read with no
live watch omits it.

Limits: the tool fails when the thread is outside the root. The tool does not send a steer to an
idle thread, even though the service would start a new run; use `oc_send`. Any other service error
is thrown.
