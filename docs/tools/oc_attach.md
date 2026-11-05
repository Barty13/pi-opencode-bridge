# oc_attach

This page covers `oc_attach`: it adopts a thread that the bridge did not open.

Use it for a TUI thread or a thread from an earlier Pi session. It checks `underRoot` and
`assertLocal`. A running thread gets a watch with the floor just behind its run; an idle thread gets
no watch. The next `oc_send` arms an idle thread. A second attach on a watched thread returns
`already armed: <session>` and does not change the watch.

Call:

```
oc_attach session="ses_…"
```

Receipt:

```
attached ses_… "attach-probe"
model: opencode-go/glm-5.3-flash variant default · 8k tokens · open asks: none · running
```

An idle thread adds:

```
attached; idle, watch starts with your next oc_send
```

React to `already armed: <session>`: the existing watch stays. An ask read failure prints
`open asks: unreadable` instead of a count. `/oc` marks an adopted thread `attached`; a reload
restores that mark.

Limits: the tool fails when the thread is outside the root or the status read fails.
