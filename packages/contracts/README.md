# @basis/contracts

Capability contracts shared by the shipped plugins and any replacement: Effect `Context.Tag`s for services, `Hook` tokens for interception points, `Event` tokens for notifications, and Effect Schema classes for every value that crosses a plugin or transport boundary.

The kernel (`@basis/core`) knows nothing about these. A plugin that provides a contract lists the tag in `provides`; a consumer lists it in `requires`. Two implementations of the same tag cannot coexist in one composition; choose one in the config file.

| Module | Service | Hooks / events |
| --- | --- | --- |
| `llm` | `Llm`: provider registry, model catalog, routed streaming | `LlmRequestHook` wraps every model call |
| `tools` | `Tools`: registration, validation, execution | `ToolExecuteHook` is the gate; `ToolExecuted` |
| `sessions` | `Sessions`: append-only entry tree per session | `SessionAppended`, `SessionChanged` |
| `agent` | `Agent`: one turn at a time per session | `AgentRequestHook` shapes each request; `TurnStarted`, `TurnEnded`, `ModelEvent` |
| `interaction` | `Interaction`: confirm, ask, select, open-url, notify | `InteractionHook` is answered by UIs |
| `credentials` | `Credentials`: resolve, store, login methods | — |
| `skills` | `Skills`: discovery and on-demand loading | — |
| `host` | `Paths`; `ConfigFile` schema | `Notice` |

Value types (`Message`, `ContentPart`, `StreamEvent`, `SessionEntry`, ...) are Schema classes so the same definitions serialize over the transport and validate on both ends. See [docs/plugins.md](../../docs/plugins.md) for which shipped plugin provides what.
