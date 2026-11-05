# oc_read

This page covers `oc_read`: it shows the latest messages of a thread.

The tool skips `idle` status rows when other rows exist, so `limit: 1` returns the answer. `parts: "full"` adds reasoning and tool input, status, result, and error. Each message body stops at 4000
characters; `offset` skips characters in each body. The whole result stops at 24,000 characters.

Call:

```
oc_read session="ses_…" limit=3 parts="full"
```

Parameters: `session` (string, required), `limit` (number, optional; 1 to 25, default `6`), `parts`
(`text` or `full`, optional), `offset` (number, optional).

Receipt:

```
[user] Add a test for the parser.

[assistant stop] tokens in/out/reasoning 1200/300/0, cache 0, cost 0.0012
Done. The test sits in test/parser.test.ts.
```

With `parts: "full"`, a tool call reads `[tool read completed] input={"path":"src/parser.ts"} result=...`. A failed tool adds `error=<message>`.

React to a body past the cap: it ends with `… truncated; read with oc_read offset=4000`, and the
next call with `offset=4000` reads the next part. A body past the offset prints `(no text past offset N, body is M chars)`.

Limits: the tool fails when the thread is outside the root or the message read fails.
