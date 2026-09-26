# basis

A build-your-own agent harness where everything, including the UI, is a replaceable plugin. One host runs the plugins; the web, desktop, and CLI clients connect to it.

The [kernel](packages/core/README.md) ([rationale](docs/kernel.md)), the [contracts](packages/contracts/README.md), and the [shipped plugins](docs/plugins.md) are implemented. The host runs them with a transport that web, desktop, and CLI clients connect to; the client apps are still scaffolds.

| Path | Responsibility |
| --- | --- |
| `packages/core/` | Effect-native plugin kernel: capabilities, hooks, events, supervision, transactional reload |
| `packages/contracts/` | Capability contracts shared by shipped and third-party plugins, including the RPC surface |
| `packages/models/` | Bundled models.dev snapshot |
| `packages/client/` | Typed host client for browsers and Bun |
| `plugins/*` | Shipped plugins: host, credentials, llm and providers, tools, sessions, agent, compaction, subagent, skills, mcp, transport, interaction |
| `apps/host/` | Bun host process: loads `config.jsonc`, runs the composition, reloads on change |
| `apps/cli/` | Command-line client placeholder |
| `apps/web/` | SolidJS client, also used by desktop (scaffold) |
| `apps/desktop/` | Electron shell for the web client |

## Defaults

- **Full permissions.** Neither the kernel nor the default plugins include an approval system. Gating or auto-approval belongs in a plugin that wraps tool execution.
- **Plugins all the way down.** Providers, credentials, tools, sessions, skills, MCP, and UI are plugins using the same public interfaces as third-party ones.

## Develop

On Linux or macOS:

```sh
nix develop -c bun install --frozen-lockfile
nix develop -c bun run check          # type-check every workspace package
nix develop -c bun run test           # all kernel and plugin tests
nix develop -c bun run core:bench     # warm kernel microbenchmarks
nix develop -c bun run host:dev       # run the host with the default composition
nix develop -c bun run web:dev        # browser at http://127.0.0.1:5173
nix develop -c bun run desktop:dev    # build web assets, then open Electron
```

The host reads `~/.basis/config.jsonc` and `<project>/.basis/config.jsonc` (see [docs/plugins.md](docs/plugins.md)); without either it runs every shipped plugin except the OpenAI-compatible and MCP ones, which need configuration. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, or log in through a client, to talk to a model.
