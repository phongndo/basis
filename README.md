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

## Develop

Use the Nix shell on Linux or macOS:

```sh
nix develop -c bun install --frozen-lockfile
nix develop -c bun run check          # build JavaScript/declarations and type-check
nix develop -c bun run test           # core tests, including lifecycle regressions
nix develop -c bun run example        # compose plugins and invoke a hook
nix develop -c bun run package:check  # install the packed library into a temporary consumer
nix develop -c bun run core:bench     # warm framework microbenchmarks
```

`package:check` checks the emitted declarations and runs the same consumer on Bun
and Node.js. It tests provider replacement, dependent reconstruction, and cleanup
through the package export, outside this workspace. Its temporary install may need
network access for dependencies.

## Use in another application

The package is currently private and can be packed locally:

```sh
nix develop -c bun run build
nix develop -c bun pm --cwd packages/core pack --destination /tmp
```

Install the resulting tarball in the consuming application and import `@basis/core`.
The package contains ESM JavaScript, TypeScript declarations, and the example;
Effect remains an external dependency. See the [library README](packages/core/README.md)
for composition and plugin authoring.

Plugins execute as trusted code in the application's process. Scope ownership and
cooperative cancellation organize their lifetimes; they do not provide process
isolation. Performance claims require measured application workloads; the included
benchmarks measure framework overhead only.
