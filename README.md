# basis

A machine-resident agent harness with multiple clients. The [Effect-native plugin core](packages/core/README.md) is implemented; the applications remain scaffolds. No server transport, agent loop, tools, provider integration, or client connection is implemented yet.

| Path | Responsibility |
| --- | --- |
| `packages/core/` | Effect-native plugin composition, scoped lifetimes, hooks, and inspection |
| `apps/daemon/`, `src/`, `include/` | Earlier C++ daemon scaffold; not connected to the core |
| `packages/extension-host/` | Earlier extension-host placeholder; not connected to the core |
| `apps/web/` | SolidJS client, also used by desktop |
| `apps/desktop/` | Electron shell for the web client |

The core runs in Bun and contains no agent-specific behavior. It is currently used programmatically; the existing app scaffolds do not load it. See its [runnable example and development commands](packages/core/README.md#use).

The proposed [core implementation and verification plan](docs/core-implementation-plan.md) defines the next stages and their acceptance gates; those capabilities are not implemented yet.

## Develop

On Linux or macOS, enter the Nix shell, then install C++ and web dependencies:

```sh
nix develop
just setup
bun install --frozen-lockfile
```

```sh
bun run core:check    # TypeScript and plugin-interface checks
bun run core:test     # Core lifecycle and hook tests
bun run core:bench    # Warm core microbenchmarks
just test             # Existing C++ scaffold build and tests
just run              # prints the daemon placeholder; does not start a server
bun run web:check
bun run web:dev       # browser at http://127.0.0.1:5173
bun run desktop:dev   # builds web assets, then opens Electron
```

From outside the Nix shell, prefix `just` recipes with `just nix="nix develop --command" ...` or use `nix develop -c <command>`.
