# /oc-kill

This page covers `/oc-kill`: it stops a thread.

Syntax: `/oc-kill <ses_…>`

Example:

```
> /oc-kill ses_…
interrupted ses_…
```

The command prints `interrupted <session>` or `no run to interrupt in <session>`. A queued settle is
appended after `The run had already settled:`. A bad argument prints `usage: /oc-kill <ses_...>`.

The command changes no mode. [tools/oc_stop.md](../tools/oc_stop.md) gives the watch rule.
