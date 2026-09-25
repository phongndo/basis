# basis

A build-your-own agent harness where everything, including the UI, is a replaceable plugin. One host runs the plugins; the web, desktop, and CLI clients connect to it.

Only the [plugin kernel](packages/core/README.md) is implemented; its rationale is in [docs/kernel.md](docs/kernel.md). The apps are scaffolds: there is no config file, transport, agent loop, provider, or client connection yet.

| Path | Responsibility |
| --- | --- |
| `packages/core/` | Effect-native plugin kernel: capabilities, hooks, events, supervision, transactional reload |
| `apps/host/` | Bun host process; currently loads an empty composition |
| `apps/cli/` | Command-line client placeholder |
| `apps/web/` | SolidJS client, also used by desktop |
| `apps/desktop/` | Electron shell for the web client |

## Defaults

- **Full permissions.** Neither the kernel nor the default plugins include an approval system. Gating or auto-approval belongs in a plugin that wraps tool execution.
- **Plugins all the way down.** Providers, credentials, tools, sessions, skills, MCP, and UI are plugins using the same public interfaces as third-party ones.

## Develop

On Linux or macOS:

```sh
nix develop -c bun install --frozen-lockfile
nix develop -c bun run check          # type-check all workspaces
nix develop -c bun run core:test      # core lifecycle and hook tests
nix develop -c bun run core:bench     # warm core microbenchmarks
nix develop -c bun run host:dev       # mount the empty host composition
nix develop -c bun run web:dev        # browser at http://127.0.0.1:5173
nix develop -c bun run desktop:dev    # build web assets, then open Electron
```
