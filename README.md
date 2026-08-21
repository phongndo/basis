# basis

C++23 library and CLI. The development toolchain is a Nix flake; C++ packages
come from Conan.

## Prerequisites

[Nix](https://nixos.org/download/) with flakes enabled.

```bash
nix develop
just setup
```

From outside the shell, prefix recipes with the flake:

```bash
just nix="nix develop --command" check
```

## Build

```bash
just build          # debug (default)
just test
just run
just bench
```

Release and sanitizers:

```bash
just profile=release build
just profile=sanitizers test
```

## Tooling

| Task | Command |
| --- | --- |
| Format | `just fmt` |
| Lint | `just lint` |
| Debug | `just debug` |
| LSP | `clangd` against `compile_commands.json` (created by `just configure`) |
| Python | `just python-check` |
| Gate | `just check` |

On macOS the compiler and debugger are Apple Clang / lldb. clangd, clang-format,
and clang-tidy come from LLVM 22 in the flake, wrapped against the Xcode SDK.
Linux uses LLVM 22 for the compiler and the tools.

After switching `profile`, restart the language server.
