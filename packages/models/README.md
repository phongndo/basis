# @basis/models

A bundled snapshot of [models.dev](https://models.dev) data for the providers basis ships, as `ModelInfo` values. Provider plugins own the truth about ids and limits and overlay names and prices from here, so no plugin depends on another plugin's package for data.

`bun run --cwd packages/models generate` refreshes `src/models.generated.ts` from the live API; commit the result.
