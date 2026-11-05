# oc_reply

This page covers `oc_reply`: it answers one open permission or form ask by id.

The tool reads the open asks first, so it knows the kind. A permission needs `decision` (`once`,
`always`, or `reject`). A form needs `answerJson`, a JSON object keyed by the form's field names.

Call:

```
oc_reply session="ses_…" id="per_…" decision="once"
```

Parameters: `session` (string, required), `id` (string, required), `decision` (string, optional),
`answerJson` (string, optional).

Receipts:

```
permission per_… -> once
form frm_… answered
```

React to `<id> is not open on <session>. oc_wait lists its open asks.`: the id is not open; read the
asks again. React to `Cannot read the asks on <session>. Retry oc_reply.`: the ask read failed. A
settled ask answers `<id> is already settled or gone. Read the thread with oc_read.` An invalid form
answer prints the JSON error.

Limits: the tool fails when the thread is outside the root. A permission without a decision and a
form without `answerJson` fail before any POST.
