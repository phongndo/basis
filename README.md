# basis

A machine-resident agent harness with multiple clients. This repository is a scaffold: no daemon transport, agent loop, extension loading, or client connection is implemented yet.

| Path | Responsibility |
| --- | --- |
| `apps/daemon/`, `src/`, `include/` | C++ daemon executable and native library |
| `packages/extension-host/` | Bun runtime for JS/TS extensions (not implemented) |
| `apps/web/` | SolidJS client, also used by desktop |
| `apps/desktop/` | Electron shell for the web client |

Clients will connect to the daemon rather than own sessions. The daemon will own agent execution and state; the extension host will run separately. The client and extension interfaces are not defined yet.

## Develop

On Linux or macOS, enter the Nix shell, then install C++ and web dependencies:

```sh
nix develop
just setup
bun install --frozen-lockfile
```

```sh
just test             # C++ build and tests
just run              # prints the daemon placeholder; does not start a server
bun run web:check
bun run web:dev       # browser at http://127.0.0.1:5173
bun run desktop:dev   # builds web assets, then opens Electron
```

From outside the Nix shell, prefix `just` recipes with `just nix="nix develop --command" ...` or use `nix develop -c <command>`.
