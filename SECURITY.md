# Security

## What the bridge touches

- One local HTTP service, the port `opencode service status` prints. It sends no other request.
- `~/.config/opencode/service.json`, read at runtime for that service password. The value goes in
  one `Authorization` header. It is never logged, printed, written, or sent elsewhere.
- Your OpenCode CLI, for two read-only calls: `opencode service status` and `opencode models`.

The bridge installs nothing, and writes nothing to disk. Thread creation and deletion go through
the service API. It reads no provider key and no model id list from you: it asks the service.

## Where the risk sits

A delegated thread can write files. Two bounds hold it:

1. Every thread directory must resolve under `OC_ROOT`. Real paths compare, so a symlink cannot
   pass. A thread that reports a directory outside the root is dropped.
2. Every permission ask from a thread reaches you before it runs, unless you set `/oc-auto`.

Set `OC_ROOT` to a scratch tree you can afford to lose. Do not point it at a home directory or at
a tree with credentials.

## Data leaving your machine

A brief leaves your machine as a prompt to whatever model the thread uses. Set `OC_RETENTION` to
your own labels after you read each model's policy from your provider. Do not put secrets in a
brief.

## Report

Open a private security advisory on the repository. Do not open a public issue.
