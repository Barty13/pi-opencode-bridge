# /oc-attach

This page covers `/oc-attach`: it adopts an existing thread under `OC_ROOT`.

Syntax: `/oc-attach <ses_…>`

Example:

```
> /oc-attach ses_…
attached ses_… "attach-probe"
model: opencode-go/glm-5.3-flash variant default · 8k tokens · open asks: none · running
```

The command uses the same checks and receipt as `oc_attach`. A bad argument prints `usage: /oc-attach <ses_...>`; a refused thread prints `attach failed: <message>`.

The command changes no mode. [tools/oc_attach.md](../tools/oc_attach.md) gives the watch rule.
