# /oc-clean

This page covers `/oc-clean`: it lists or deletes finished threads under the root.

Syntax: `/oc-clean` or `/oc-clean force`

Example:

```
> /oc-clean
dry run: 2 under /home/you/Pi, 1 busy kept
ses_…  glm-5.3-flash  succeeded  12m  out 300  refactor-parser
run /oc-clean force to delete these
```

A dry run lists finished threads and keeps busy threads. A force run re-reads each thread, skips one
that started a run, and prints `oc-clean: deleted N, kept M busy`. With no finished thread it prints
`oc-clean: nothing to delete, M busy kept`.

The `force` argument changes the command from a list to a delete.
