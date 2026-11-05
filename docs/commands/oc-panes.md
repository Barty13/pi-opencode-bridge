# /oc-panes

This page covers `/oc-panes`: it controls the Ghostty columns.

Syntax: `/oc-panes open`, `/oc-panes close`, `/oc-panes list`, or `/oc-panes` for `list`.

Example:

```
> /oc-panes open
OpenCode columns: open done
```

The command needs a TUI and a pane script. It prints `OpenCode columns: off outside a terminal`,
`OpenCode columns: off (OC_PANES=0)`, `OpenCode columns: missing <path>`, or `usage: /oc-panes open | close | list`.

The argument selects the pane action; no argument means `list`.
