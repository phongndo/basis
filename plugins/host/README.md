# @lemma/plugin-host

Provides `Paths` and `HostControl`, publishes `PluginsChanged`, and exports the functions `packages/host` runs before any plugin exists: resolving paths, reading and merging `config.jsonc` files into a `Composition`, watching them, and describing the running composition.

## Use

```ts
import { compositionInfo, hostPlugin, loadComposition, resolvePaths, watchConfig } from "@lemma/plugin-host";

const paths = resolvePaths({ env: process.env, cwd: process.cwd() });
const { composition, diagnostics, files } = await Effect.runPromise(loadComposition(paths));
```

- `resolvePaths` — `home` is `$LEMMA_HOME` or `~/.lemma`; `userConfig` is `<home>/config.jsonc`, `projectConfig` is `<cwd>/.lemma/config.jsonc`, `auth` is `<home>/auth.json`, `sessions` is `<home>/sessions`.
- `loadComposition(paths)` never fails. Each file is JSONC (comments and trailing commas), validated against `ConfigFile` from the contracts. Unreadable or invalid files become `Diagnostic`s naming the file (and the config path where relevant) and are skipped; a missing file is normal and `files` says which ones were found. The result always contains the `host` row with `config: paths`, so an empty setup runs the host plugin alone; a `host` row written in a file is ignored with a warning. `enabledIn` names, per plugin id, the file whose row sets `enabled`, so a change can target the file that decides.
- `patchConfig(text, rows, scope?)` returns the JSONC text with each plugin's row updated in place, keeping comments and other rows: a key present in a row is written and a row left empty is removed. In the user file (the default scope) `enabled: true` removes the key, since it is the default; in the project file it is written out, because only an explicit `true` overrides a user row that says `false`. `updateConfig(path, rows, scope?)` applies it to a file (creating it if needed), refuses a file it cannot parse, and returns the `text` written, the `previous` text, and `restore`, which puts the file back and never fails; the app uses that when the host rejects the change, and compares `text` with what its watcher sees so it does not reload its own writes. `readConfigText(path)` is the read half: the text, or undefined for a missing file.
- `resolveComposition(known, composition)` — turning a plugin off takes its dependents out of the composition rather than failing the whole change on a missing capability. Given every `KnownPlugin` (definition plus `source`) and the composition, it returns the composition to load and `haltedBy`: each enabled plugin left out with the disabled (or itself left-out) plugin providing a capability it requires. Unknown ids and capabilities nobody provides are left to the planner.
- `withReplacements(known, composition, rows)` — a capability has one provider, so a row turning on a plugin gets a row turning off every enabled plugin that provides a capability it provides: that is how a provider is swapped. Rows already given are left alone.
- `catalog({ known, composition, resolved, snapshots, enabledIn, pinned })` — the `PluginInfo` list `HostControl.plugins` returns: every known plugin, in `known` order, with its `enabled` row, core `state` and `fault` when loaded, `haltedBy` from the core or from `resolved`, and `locked` for a `pinned` plugin (the app's reason) or one a pinned plugin needs, transitively (`Needed by <id>`).
- Trust: the project file is read only when `isTrusted(paths.cwd, trustedProjects)` holds for the user file's `trustedProjects` (absolute directories; a subdirectory of an entry is covered). Otherwise `trusted` is false and, if the project has a config file or a `projectPluginsDir(paths)`, a warning names the entry to add. `trustedProjects` in a project file is ignored with a warning. The app loads project plugins only when `trusted`.
- Merge rule: project rows override user rows by plugin id. `enabled` and `config` are each taken from the project row when present; a project `config` replaces the user's whole object (no deep merge), so a project file can disable a plugin without repeating its config.
- `watchConfig(paths, { debounceMs? })` — a `Stream<string>` of the changed file's path. It watches the containing directories (editors replace files by rename; the project `.lemma` directory may not exist yet), and a directory absent at start is not watched until the next start.
- `compositionInfo(composition, plugins)` — the `CompositionInfo` for `HostControl.composition`: running plugin ids and versions (pass `core.inspect` snapshots) plus `id`, a sha256 over the sorted ids, versions, and each member's config as canonical JSON (sorted keys). Session `request` events record this id, so it must not depend on config key order or process.
- `hostPlugin({ control, faults? })` builds the plugin: `id: "host"`, config schema `PathsSchema`, provides `Paths` (from config) and `HostControl` (from the app's handle). With `faults` (the core's fault stream) it publishes an error `Notice` and `PluginsChanged` for every fault; it also publishes `PluginsChanged` after `reload`, `restart`, and `configure` through the handle.

## Wiring in the app

The plugin activates inside `makeLoader`, before the loader value exists, so the app binds the handle through a `Deferred<Loader>` (see `tests/plugin.test.ts`; the handle's `composition` is `compositionInfo(yield* loader.composition, (yield* loader.core.inspect).plugins)`). Two kernel facts shape the rest:

- `Loader.apply` retires the current revision and drains in-flight `core.run` work before swapping. A `HostControl.reload` executed _inside_ `core.run` therefore waits on itself until the dispose deadline. Call it from plugin code (a transport's handler runs in its plugin scope) or, in the app, from the service value captured once with `loader.core.run(HostControl)`.
- A fault raised while a plugin is still staging (activation inside a reload) is published with the pre-swap snapshot; the reload's own `PluginsChanged` follows with the final state. Events are losable by design: the app's log and `core.inspect` remain the source of truth.

This package exports the factory rather than a default plugin instance because `HostControl` cannot exist without the loader.
