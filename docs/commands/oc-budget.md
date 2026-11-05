# /oc-budget

This page covers `/oc-budget`: it prints the quota meters and the thread costs. `/oc_budget` is an
alias.

Syntax: `/oc-budget` or `/oc_budget`

Example:

```
> /oc-budget
ses_…  opencode-go/glm-5.3-flash max  1400k tok  ~$0.8500
go rolling 45% · resets 21:40 · weekly 45% · monthly 23%
budget org_…: $1.25 / $10.00 · opencode-go/glm-5.3-flash $0.40
```

The command forces a meter read. It prints one line per live thread, then the Go meters, then the
console budgets. With no live thread the first line reads `live threads: none`. With no meter the
meter line reads `quota: unreadable`. [budget.md](../budget.md) gives the meter and cost rules.
