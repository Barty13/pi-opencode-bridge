# Budget

This page covers the quota meters, the cost display rules, and the two budget ceilings.

The quota route is `GET /api/experimental/usage/limits`. It returns `data.go.rolling`,
`data.go.weekly`, and `data.go.monthly`. Each meter has a `percent`, a `limited` flag, and a
`resetsAt` time. A meter prints as `go rolling 45%`, or `go rolling LIMITED` when `limited` is true.
The rolling meter also prints `resets HH:MM` in local time.

The meter read is cached for 30 s. `oc_open`, `oc_send`, and `oc_fanout` call the cache; a read older
than 30 s refreshes it. `/oc-budget` forces a read. The HUD timer and the backstop poll never ask the
service; they show the last snapshot. A failed read keeps the last snapshot and retries after 30 s.
The route has a 5 s timeout, so it cannot hold a send.

The footer carries the meter line and the armed count. Each HUD row carries the thread's `tok` and
cost. Thread numbers come from `Session.Info` on detail reads that the bridge already makes, so a
sweep adds no request.

`OC_BUDGET_PCT` reads the rolling meter, the shortest window. It refuses `oc_open` and `oc_send`
while the rolling percent is at or above the value. The refusal names the percent, the setting, and
the reset time. A fan-out skips a Go member at or above the value; a free member still runs, and the
skip is in the member section. A zero value turns the ceiling off.

`OC_BUDGET_TOKENS` caps the token total of threads that this Pi session delegated to. The total adds
`input + cache.read + cache.write + output + reasoning` for each delegated thread. The numbers come
from `Session.Info`, not from a new request. The cap refuses `oc_open`, `oc_send`, and `oc_fanout`
when the total is at or above the value, and names the thread that crossed it. A zero value turns
the cap off.

The cap counts a thread from its `oc_open`, from its first `oc_send`, from a fan-out member, or from
an `oc_steer`. A refused `oc_steer` still adds the thread, because the add runs before the busy
check. `oc_attach` does not add a thread; the first `oc_send` on an adopted thread runs its budget
check before the add, so the adopted history does not block that send, but later sends count it.
`oc_steer` and `oc_reply` are not gated by the cap. The cap does not count threads outside this Pi
session, and it does not count cost. `/oc-clean` and a settle read that finds the thread gone remove
it from the set; a thread deleted outside the bridge can stay in the total until Pi restarts. A
settled thread stays in the total until the bridge deletes it or the session ends.

A cost that `Session.Info` reports is exact and prints as `$0.0012`. When the service reports 0, the
bridge prices the tokens from `GET /api/model` and marks the result with `~`, for example
`~$0.8500`. With no price row, the line keeps its token count and prints no dollar figure. A console
`budget` is exact and carries no `~`.
