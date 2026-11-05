# Supervision

This page covers supervision: supervised and unsupervised mode, `--oc-auto`, the asks that need a
decision, and what a session start resets.

The bridge has two modes. `supervised` is the default. `unsupervised` sends each ask to the model in
this Pi session. `/oc-auto` selects unsupervised and flushes queued asks. `/oc-accept` selects
supervised. The flag `--oc-auto` starts a session in unsupervised mode. Every session start resets
the mode to supervised and drops per-thread state, so an old run cannot answer for a new session.

| Ask | Supervised, TUI | Supervised, no UI | Unsupervised |
| --- | --- | --- | --- |
| Permission | Dialog with `Allow this request?`; the answer is `once` or `reject`. | Message to this session when idle; queue when busy. | Message to the model. |
| Form | Message to this session when idle; queue when busy. A form needs field values, so it never uses a yes/no dialog. | Message when idle; queue when busy. | Message to the model. |
| Rewind file stage | Dialog before the stage. | Error; nothing changes. | Posts through. |
| Rewind commit with `files: false` | Dialog at the commit. | Error; the stage stays. | Posts through. |

Unsupervised mode does not approve a request by itself. It sends the ask to the model, and the model
must call `oc_reply` with a decision or a form answer. The ask message starts with `[opencode]` and
uses `deliverAs: "steer"`. A settle uses `deliverAs: "followUp"`.

A file rewind asks before it stages because `POST /revert/stage` with `files: true` rewrites the
working tree at once. The question names the target and the paths from the digest. A refusal calls
no stage and changes nothing. The same question covers a requested commit, because a file stage and
its commit are one decision. A `files: false` stage keeps the files and asks at the commit.

Without a UI, a supervised file stage stops with `supervised stage needs a decision in a Pi TUI; nothing changed`. A supervised commit stops with `the revert stays staged; the commit needs a decision in a Pi TUI`; for that commit, the stage stays staged. A permission or form ask still
reaches the session through the message path when the session is idle; when the session is busy, it
waits in the queue. The dialog path needs a TUI; a form never uses a yes/no dialog.

`permissionsJson` on `oc_open` sets a per-thread OpenCode ruleset. It does not change the bridge mode.
