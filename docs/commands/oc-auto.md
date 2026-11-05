# /oc-auto

This page covers `/oc-auto`: it sends the asks to the model in this Pi session.

Syntax: `/oc-auto`

Example:

```
> /oc-auto
OpenCode bridge: auto — model questions go to this session's model
```

The command selects unsupervised mode and flushes queued asks. A session start resets the mode to
supervised. [supervision.md](../supervision.md) gives the ask rules.
