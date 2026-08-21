# Basis architecture

Basis is a C++23 library with a thin CLI driver. The current tree is a toolchain
and ownership skeleton, not a product domain.

## Boundaries

```text
CLI (apps/basis) -> library (include/basis, src) -> tests / benchmarks
```

- The library owns observable behavior and public headers.
- The CLI is a replaceable driver. It must not grow domain state.
- Tests and benchmarks observe the library. They do not own production types.
- Python tooling (`scripts`, Conan recipe) is host-side. It is not part of the
  C++ runtime.

## Ownership

Every mutable value has exactly one owner. New state must name that owner before
it is introduced.

| State | Owner |
| --- | --- |
| Public library API | `include/basis` |
| Library implementation | `src` |
| Process entry | `apps/basis` |
| Build graph and warning policy | `CMakeLists.txt` |
| Toolchain versions | `flake.nix` |
| Third-party C++ packages | `conanfile.py` |
| Host Python tooling | `pyproject.toml` |

## Constraints

- C++23, Clang or Apple Clang, libc++ on macOS.
- The flake owns compilers, CMake, Ninja, Conan, uv, and Clang tools. Do not add mise, Homebrew LLVM, or ad-hoc PATH toolchains.
- No GNU extensions (`CMAKE_CXX_EXTENSIONS OFF`).
- Do not introduce speculative subsystems, extra libraries, or shared mutable
  state without a named owner.
- Do not duplicate responsibility already owned by CMake, Conan, clangd, or lldb.
