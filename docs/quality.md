# Quality

## Tooling

| Concern | Tool |
| --- | --- |
| Toolchain | Nix flake (`nix develop`) |
| Build | CMake + Ninja |
| Packages | Conan 2 (`gtest`, `benchmark`) |
| Format | clang-format |
| Lint | clang-tidy |
| LSP | clangd |
| Debug | lldb |
| Sanitizers | CMake `sanitizers` preset (ASan + UBSan) |
| Python | uv, ruff, ty |

`just check` is the developer gate: format, clang-tidy, tests, and Python checks.

## C++ bar

- Warnings are errors (`BASIS_ENABLE_WERROR`).
- clang-tidy warnings are errors.
- Public headers stay self-contained. clangd Include Cleaner is strict.
- Behavior changes need a test. Performance claims need a benchmark or a
  measurement note.
- Debug builds keep frame pointers and debug info. Use `just debug` for lldb.

## Python bar

- ruff formats and lints host scripts.
- ty type-checks `scripts/`.
- Python is not a substitute for C++ unit tests.
