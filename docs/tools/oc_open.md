# oc_open

This page covers `oc_open`: it opens a thread for one task.

The create path goes through `directory()`, so a subfolder must exist under the root. The tool
checks the budget before it creates the thread. With a `brief`, it arms a watch and posts the
prompt. With no `brief`, the thread exists and has no watch; the next `oc_send` arms one.

Call:

```
oc_open model="opencode-go/glm-5.3-flash" variant="max" title="refactor-parser" brief="Fix the parser and add a test."
```

Parameters: `model` (string, required), `variant` (string, optional; default `high` when the ladder
offers it), `title` (string, required), `brief` (string, optional), `directory` (string, optional),
`permissionsJson` (string, optional).

Receipt:

```
ses_…
brief sent, wake-up armed
```

With a compaction:

```
ses_…
brief sent, wake-up armed
compact ordered at 612k
```

No brief: the receipt is the session id alone. `permissionsJson` is a JSON ruleset, for example `[{"action":"*","resource":"*","effect":"ask"}]`.

React to `brief failed: <message>`: the thread id stays, and the brief did not land. A 4xx drops the
watch; a timeout keeps it, because the service may still run the prompt. A failed compaction does
not stop the prompt; `compact ordered at N` means the bridge sent the order and did not wait for a
result.

Limits: the tool fails when the model is not on the list, the id is ambiguous, the variant is not on
the ladder, the directory is missing or outside the root, the budget ceiling refuses the open, the
watch ceiling refuses the arm, or the brief POST fails. Invalid `permissionsJson` returns a refusal
before the create.
