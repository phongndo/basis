# Basis

A domain-neutral TypeScript meta-framework for composing replaceable plugins.

Basis provides typed capabilities, plugin-defined hooks and events, scoped resources,
failure supervision, and reloads. Applications define their own contracts and choose
their own plugins. The framework has no required server, transport, persistence,
user interface, or domain model.

The library lives in [`packages/core`](packages/core/README.md). Its only runtime
dependency is Effect 3.22.2. Effect supplies lifecycle and cancellation machinery;
capability contracts can expose ordinary values, functions, and promises.

| Path | Responsibility |
| --- | --- |
| [`packages/core/src`](packages/core/src/index.ts) | Public interface and runtime implementation |
| [`packages/core/tests`](packages/core/tests) | Contract, lifecycle, failure, and property tests |
| [`packages/core/examples`](packages/core/examples/hello.ts) | A capability extended through a plugin-defined hook |
| [`packages/core/bench`](packages/core/bench/core.ts) | Framework microbenchmarks |
| [`docs/kernel.md`](docs/kernel.md) | Design rationale and limits |

## Harness

The rest of the workspace is a coding-agent harness built on Basis: every part
of it, including the agent loop, is a plugin that can be replaced by id.

| Path | Responsibility |
| --- | --- |
| [`packages/contracts`](packages/contracts/src/index.ts) | Capability contracts: session log, agent, LLM, tools, credentials, interaction, host RPC |
| [`plugins/*`](plugins) | The default plugins, one README each |
| [`apps/host`](apps/host/src/main.ts) | Reads config, loads plugins, hot-reloads on config change |
| [`apps/web`](apps/web) | The web client, served by the `transport` plugin |
| [`apps/cli`](apps/cli/README.md) | The `basis` command: runs the host and queries or controls a running one |

```sh
nix develop -c pnpm start          # build the web app, start the host, print its URL
nix develop -c pnpm basis status   # query the running host; `pnpm basis --help` lists commands
```

With no config, every bundled plugin runs. `~/.basis/config.jsonc` and
`<project>/.basis/config.jsonc` patch that by plugin id (`enabled: false`, or a
replacement `config`). Plugin files in `~/.basis/plugins/` or
`<project>/.basis/plugins/` load automatically and shadow a bundled plugin with
the same id. Project files and plugins can run code and redirect credentials, so
they load only for projects listed (or under a directory listed) in
`"trustedProjects"` in `~/.basis/config.jsonc`; otherwise the host warns and
ignores them. Providers come from pi-ai (`plugins/llm-pi-ai`): log in from the
key icon in the web app, or set a provider's API key environment variable.

The session log is the source of truth: every model request can be rebuilt from
it (`rebuildRequest` in the contracts) and records which plugins contributed
each part. `scripts/fixtures/mock-openai.ts` is a scripted provider for
end-to-end runs without an API key.

## Develop

Use the Nix shell on Linux or Apple silicon macOS. Both development shells supply
Node.js 24 and pnpm from [`flake.nix`](flake.nix), including CI. Node runs TypeScript
sources directly through type stripping, so source must use erasable syntax only
(enforced by `erasableSyntaxOnly`).

```sh
nix develop -c pnpm install --frozen-lockfile
nix develop -c pnpm check          # build JavaScript/declarations and type-check
nix develop -c pnpm test           # core tests (Vitest), including lifecycle regressions
nix develop -c pnpm example        # compose plugins and invoke a hook
nix develop -c pnpm package:check  # install the packed library into a temporary consumer
nix develop -c pnpm core:bench     # warm framework microbenchmarks
nix develop -c pnpm core:stress    # requires a build; lifecycle churn and memory
nix develop .#browser -c pnpm browser:check # packed consumers plus Chromium
```

`package:check` checks the emitted declarations and runs the consumer on Node.js.
It tests provider replacement, dependent reconstruction, and cleanup through the
package export, outside this workspace. Its temporary install may need network
access for dependencies.

The `browser` shell supplies pinned Chromium on Linux. On macOS, install the
development browser with `nix develop .#browser -c pnpm exec playwright install chromium`
first, or set `BASIS_CHROMIUM` to an existing executable. Linux Chromium is the
locally verified browser environment; other browsers/platforms need their own runs.

`perf:check` builds and runs the microbenchmarks and sustained workload. Performance results
are advisory by default; set `BASIS_PERF_ENFORCE=1` on a comparable idle machine to
enforce the [documented budgets](packages/core/bench/budgets.ts), and
`BASIS_BENCH_OUTPUT_DIR` to an artifact directory. The [CI workflow](.github/workflows/check.yml)
runs correctness checks on changes and extended checks weekly or on demand.

## Use in another application

The package is currently private and can be packed locally:

```sh
nix develop -c pnpm build
nix develop -c pnpm --filter @basis/core pack --pack-destination /tmp
```

Install the resulting tarball in the consuming application and import `@basis/core`.
The package contains ESM JavaScript, TypeScript declarations, and the example;
Effect remains an external dependency. See the [library README](packages/core/README.md)
for composition and plugin authoring.

Plugins execute as trusted code in the application's process. Scope ownership and
cooperative cancellation organize their lifetimes; they do not provide process
isolation. Performance claims require measured application workloads; the included
benchmarks measure framework overhead only.
