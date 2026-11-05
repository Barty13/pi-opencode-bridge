# Anatomy of a wake-up

This page covers the anatomy of a wake-up: the batch rules, the message blocks, and the digest line.

The bridge sends one message per debounced batch. `OC_DEBOUNCE_MS` sets the batch window. Two
settles inside the window produce one message. The message is a follow-up, so Pi queues it for the
next turn when a run is active. A run that the human aborted holds the batch until the next
human-started run settles; the head then says `settled while the run was cancelled`. A compaction
holds the batch until the compaction ends. Print and JSON modes do not send a wake-up. A reload
drops the in-memory batch and restores the watch from `oc-armed`; a settle that landed during the
reload can have no wake-up when the thread is already idle at start. In those cases `oc_wait`
collects the settle.

The message has this order:

| Block | Content |
| --- | --- |
| Head | `One OpenCode thread settled:`, `N OpenCode threads settled:`, or `Fan-out fan_<n> settled:`. |
| Entry | `- <session> <title>:` for each settle. The title is omitted when it is empty or equal to the session id. |
| Outcome | `outcome: <value>`. An expired watch adds ` (watch expired; restart with oc_send to read the record)`. |
| Error | `error: none`, or `error: <message>`. A `retryAfterMs` adds `, retry after N min`. |
| Steers | `steers N`, only when a live watch counted at least one steer. |
| Answer | `answer:` and the text, or `answer: (none)`. |
| Asks | `open asks:` and one block for each ask, `open asks: none`, or `open asks: unreadable`. |
| Digest | The run ledger, when the report read the wide window. |
| Tail | `Read a thread with oc_read, then continue the task that started it.` |

A full message:

```
One OpenCode thread settled:
- ses_… refactor-parser:
  outcome: succeeded

  error: none

  answer:
  The parser now accepts the new syntax. The test sits in test/parser.test.ts.

  open asks: none

  digest 5 calls (5 ok) · shell 5 · fails: none · files: none

Read a thread with oc_read, then continue the task that started it.
```

The answer body passes through the read cap that [tools/oc_read.md](tools/oc_read.md) states;
`oc_read` with `offset` reads the next part. A form detail uses the same cap. A permission detail
stops at 1200 characters. The whole `oc_read` result has its own cap in the same tool page.

`steers N` comes from the live watch. A record read with `since` and no live watch omits the count,
because the bridge cannot know it. A fan-out report has no steer count.

`outcome` reads `unknown` when the fresh window has no idle row and the session row has no outcome,
or when the watch expired. The bridge does not map an unknown outcome to `succeeded` or `failed`.

A fan-out report uses a different body: `outcome: fan-out N models`, then one section per member in
caller order, then the judge verdict. [tools/oc_fanout.md](tools/oc_fanout.md) gives the shape.

## Digest line

The digest starts after the newer of the watch floor and the newest compaction row, so a compacted
context does not show calls from before the compaction. The bridge reads the 200-row window once for
the report. The line gives the call count and the ok/error split, the calls per tool name, the first
five failures (tool name and first error line, each reason capped at 120 characters), the open ask
count when it is above zero, and the touched paths (edits before reads, at most ten). A running call
adds `unfinished: N`.

The line stays at or below 400 characters. The path list shrinks first, then the failure list. A
last-resort cut keeps one failure. A watch that expires has no digest. On the backstop path, a wide
read that fails falls back to the 8-row settle, so that report has no digest.
