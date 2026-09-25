# @basis/plugin-host

Provides `Paths` and `HostControl`, publishes `PluginsChanged`, and exports the functions `apps/host` runs before any plugin exists: resolving paths, reading and merging `config.jsonc` files into a `Composition`, and watching them.

## Use

```ts
import { hostPlugin, loadComposition, resolvePaths, watchConfig } from "@basis/plugin-host";

const paths = resolvePaths({ env: process.env, cwd: process.cwd() });
const { composition, diagnostics, files } = await Effect.runPromise(loadComposition(paths));
```

- `resolvePaths` — `home` is `$BASIS_HOME` or `~/.basis`; `userConfig` is `<home>/config.jsonc`, `projectConfig` is `<cwd>/.basis/config.jsonc`, `auth` is `<home>/auth.json`, `sessions` is `<home>/sessions`.
- `loadComposition(paths)` never fails. Each file is JSONC (comments and trailing commas), validated against `ConfigFile` from the contracts. Unreadable or invalid files become `Diagnostic`s naming the file (and the config path where relevant) and are skipped; a missing file is normal and `files` says which ones were found. The result always contains the `host` row with `config: paths`, so an empty setup runs the host plugin alone; a `host` row written in a file is ignored with a warning.
- Merge rule: project rows override user rows by plugin id. `enabled` and `config` are each taken from the project row when present; a project `config` replaces the user's whole object (no deep merge), so a project file can disable a plugin without repeating its config.
- `watchConfig(paths, { debounceMs? })` — a `Stream<string>` of the changed file's path. It watches the containing directories (editors replace files by rename; the project `.basis` directory may not exist yet), and a directory absent at start is not watched until the next start.
- `hostPlugin({ control, faults? })` builds the plugin: `id: "host"`, config schema `PathsSchema`, provides `Paths` (from config) and `HostControl` (from the app's handle). With `faults` (the core's fault stream) it publishes an error `Notice` and `PluginsChanged` for every fault; it also publishes `PluginsChanged` after `reload` and `restart` through the handle.

## Wiring in the app

The plugin activates inside `makeLoader`, before the loader value exists, so the app binds the handle through a `Deferred<Loader>` (see `apps/host/src/main.ts`). Two kernel facts shape the rest:

- `Loader.apply` retires the current revision and drains in-flight `core.run` work before swapping. A `HostControl.reload` executed *inside* `core.run` therefore waits on itself until the dispose deadline. Call it from plugin code (a transport's handler runs in its plugin scope) or, in the app, from the service value captured once with `loader.core.run(HostControl)`.
- A fault raised while a plugin is still staging (activation inside a reload) is published with the pre-swap snapshot; the reload's own `PluginsChanged` follows with the final state. Events are losable by design: the app's log and `core.inspect` remain the source of truth.

This package exports the factory rather than a default plugin instance because `HostControl` cannot exist without the loader.
