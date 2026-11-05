# Bridge checks

This page points at the check documentation. The full recipe, the control builds, and the case
tables live in [docs/checks.md](../docs/checks.md).

Run the model-free suite from the package root:

```sh
bun run typecheck
bun run check
```

`bun run check` runs every model-free check and its control. `BRIDGE` points a check at another
build; `check-12-docs` reads it as a docs bundle.
