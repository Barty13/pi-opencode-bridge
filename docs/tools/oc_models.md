# oc_models

This page covers `oc_models`: it lists the models that the service serves for delegation.

The tool runs `opencode models` and keeps ids with the `opencode-go/` prefix or the `-free` suffix.
It reads `GET /api/model` for each variant ladder and list price. Read it before `oc_open`, because a
model id must be on this list.

Call:

```
oc_models
```

Receipt:

```
opencode-go/glm-5.3-flash  variants: low|high|max
opencode-go/deepseek-v4.1-flash  variants: low|high|max
opencode/an-example-free  variants: none
```

`variants: none` means the model takes no variant. `variants: unknown` means the ladder read failed.
A `retention:` label appears when `OC_RETENTION` matches the id suffix.

Limits: the tool fails when `opencode models` fails and returns the command error. A failed
`/api/model` read is not fatal: the ladder prints `unknown`, and a requested variant is accepted
because the ladder is undefined. A model that both providers serve is ambiguous; `oc_open` refuses
it until the caller adds the provider prefix.
