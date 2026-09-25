# Shipped plugins

Everything a user sees is a plugin. The shipped ones use the same public interfaces as third-party plugins: `@basis/core` for composition and `@basis/contracts` for the capabilities they provide or consume. This page is the map; each plugin's README is authoritative for its own behavior.

**Status (2026-09-25):** contracts defined; `host`, `interaction`, and `credentials` implemented and wired into `apps/host`; the rest in progress.

## Layout

| Path | Package | Provides | Requires |
| --- | --- | --- | --- |
| `plugins/host` | `@basis/plugin-host` | `Paths`, `HostControl`, `PluginsChanged`; also exports the functions `apps/host` uses before any plugin exists: resolve paths, read and merge `config.jsonc` files into a `Composition`, watch them | — |
| `plugins/credentials` | `@basis/plugin-credentials` | `Credentials` (auth.json, env vars, `command` values, OAuth refresh under a lock) | `Paths`, `Interaction` |
| `plugins/llm` | `@basis/plugin-llm` | `Llm` (provider registry, routing, `LlmRequestHook`) | `Credentials` |
| `plugins/llm-anthropic`, `plugins/llm-openai`, `plugins/llm-openai-compatible` | provider plugins | register an `LlmProvider` | `Llm`, `Credentials` |
| `plugins/tools` | `@basis/plugin-tools` | `Tools` (registry, input validation, `ToolExecuteHook`) | — |
| `plugins/tools-builtin` | `@basis/plugin-tools-builtin` | registers `read`, `write`, `edit`, `bash` | `Tools` |
| `plugins/sessions` | `@basis/plugin-sessions` | `Sessions` (JSONL tree files under `Paths.sessions`) | `Paths` |
| `plugins/agent` | `@basis/plugin-agent` | `Agent` (the loop: prompt → model → tools → model; `AgentRequestHook`) | `Llm`, `Tools`, `Sessions` |
| `plugins/compaction` | `@basis/plugin-compaction` | appends `compaction` entries when context nears the window | `Agent`, `Sessions`, `Llm` |
| `plugins/interaction` | `@basis/plugin-interaction` | `Interaction` (runs `InteractionHook`; fails `Unavailable` with no answerer) | — |
| `plugins/skills` | `@basis/plugin-skills` | `Skills`; contributes the skill index to `AgentRequestHook` and a `skill` tool | `Paths`, `Tools` |
| `plugins/mcp` | `@basis/plugin-mcp` | connects configured MCP servers; exposes them through `mcp_search` and `mcp_call` tools so server tool schemas stay out of the prompt unless a server opts into direct registration | `Tools` |
| `plugins/transport` | `@basis/plugin-transport` | `@effect/rpc` server over HTTP and WebSocket serving `HostRpcs`; answers `InteractionHook` for connected clients | `Agent`, `Sessions`, `Llm`, `Credentials`, `HostControl` |
| `packages/client` | `@basis/client` | typed `HostRpcs` client for browsers and Bun (used by web, desktop, CLI attach) | — |
| `plugins/subagent` | `@basis/plugin-subagent` | a `task` tool that runs a nested turn with its own tool list and model | `Agent`, `Tools`, `Sessions` |

Client-side (browser, TUI) plugins consume the transport's RPC client; they are described in the transport README once it exists.

## Conventions

- **One package per plugin**, `plugins/<name>`, exporting a default `definePlugin(...)`. Config is an Effect Schema on the manifest; secrets never appear in config, only credential references.
- **Contracts are the seam.** A plugin depends on `@basis/contracts` tags, never on another plugin's package. If a plugin needs something the contracts lack, add it to the contracts with a note, not to the plugin.
- **Plain functions where it counts.** Tools and commands accept promise-returning functions; the providing plugin wraps them once at registration. Anything that must be cancellable is an Effect.
- **Hooks fail closed; events are losable.** Gates, request shaping, and interaction go through hooks. Progress, notices, and telemetry go through events. Persistence is a direct call to `Sessions`, never an observer.
- **Full permissions by default.** No shipped plugin installs a `ToolExecuteHook` handler. A gate is a user plugin.
- **Tests per plugin:** unit tests with `bun test`, written against the contract's public interface so an alternative implementation can reuse them.
- **Docs per plugin:** a README covering use, config, and non-obvious rationale. No session logs.

## Storage

- `~/.basis/` (or `$BASIS_HOME`): `config.jsonc`, `auth.json` (0600), `sessions/<project>/<session>.jsonl`, `skills/`, `plugins/` (installed third-party plugins, later).
- `<project>/.basis/`: `config.jsonc`, `skills/`.
- Skills are also read from `.agents/skills` and `~/.agents/skills` for compatibility with other harnesses.
