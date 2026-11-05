# oc_fanout

This page covers `oc_fanout`: it sends one brief to several models, one thread each, in the same directory.

The tool returns a receipt and the thread ids. Every started member resolves the model and variant,
then arms a watch. One composite report arrives when every member reports or expires.

Call:
```
oc_fanout brief="Fix the parser and add a test." models=["opencode-go/glm-5.3-flash","opencode-go/deepseek-v4.1-flash"]
```
Parameters: `brief` (string, required), `models` (string array, required; unique), `variant` (string,
optional), `judge` (string, optional), `directory` (string, optional), `ttl_s` (number, optional).

Receipt:
```
fan_1: 3 of 3 started
ses_…  opencode-go/glm-5.3-flash  variant max  brief sent
ses_…  opencode-go/deepseek-v4.1-flash  variant max  brief sent
ses_…  opencode/an-example-free  variant default  brief sent
judge: opencode-go/glm-5.3-flash variant max queued after the members
```
Report:
```
outcome: fan-out 3 models

model: opencode-go/glm-5.3-flash · variant: max · outcome: succeeded · 12k tokens · $0.0012
digest 5 calls (5 ok) · shell 4 · read 1 · fails: none · files: src/parser.ts
answer:
...
```
The sections keep the caller order. A skipped member, a failed member, and an expired member keep a
section. A member section with no run reads `outcome: skipped` or `outcome: failed`; an expired
member reads `outcome: expired`. The judge appends `judge <model>: <answer>` after the sections.
The member deadline is `OC_WATCH_TTL_S * N`, capped at `OC_WAIT_MAX_S * N`. `ttl_s` sets every member
deadline directly, still capped. A member that runs past its deadline holds an expired section; the
report does not wait forever.

Limits: the tool fails before any create when the live count plus N exceeds the watch ceiling; the
refusal names the live count, the new count, and the ceiling. It also fails when a model is not on the
list, a model is repeated, the token cap is crossed, or no member starts. A Go member is skipped when
the rolling meter is at or above `OC_BUDGET_PCT`; the skip is in its section, and free members still
run. A member create or send failure keeps its section. A Pi reload drops the composite grouping;
the members settle as ordinary threads.
