nix := ""
profile := "debug"
build_type := if profile == "release" { "Release" } else { "Debug" }
cpp_files := "apps/daemon include src tests"
python_paths := "scripts conanfile.py"

_default:
    @just --list

# Sync the uv-managed Python tools into .venv.
setup:
    {{ nix }} uv sync --dev --locked
    @just versions

# Show the pinned development tool versions.
versions:
    {{ nix }} clang++ --version
    {{ nix }} clangd --version
    {{ nix }} clang-tidy --version
    {{ nix }} clang-format --version
    {{ nix }} lldb --version
    {{ nix }} cmake --version
    {{ nix }} ninja --version
    {{ nix }} ccache --version
    {{ nix }} conan --version
    {{ nix }} just --version
    {{ nix }} uv --version
    {{ nix }} bun --version
    {{ nix }} uv run --locked ruff --version
    {{ nix }} uv run --locked ty --version

# Install Conan dependencies for the selected profile.
deps:
    rm -f CMakeUserPresets.json
    {{ nix }} conan install . \
        --output-folder=build/{{ profile }}/conan \
        --profile:all=conan/profiles/llvm \
        --settings=build_type={{ build_type }} \
        --conf=tools.cmake.cmaketoolchain:user_presets= \
        --build=missing

# Generate Ninja files and compile_commands.json.
configure: deps
    {{ nix }} cmake --preset {{ profile }}
    ln -sfn build/{{ profile }}/compile_commands.json compile_commands.json

# Build the daemon and tests.
build: configure
    {{ nix }} cmake --build --preset {{ profile }}

# Run the daemon placeholder (no server yet).
run: build
    {{ nix }} ./build/{{ profile }}/basisd

# Run unit tests.
test: build
    {{ nix }} ctest --preset {{ profile }} --output-on-failure

# Launch lldb on the debug binary.
debug:
    just profile=debug build
    {{ nix }} lldb --source .lldbinit -- ./build/debug/basisd

# Format C++, Nix, and Python files in place.
fmt:
    {{ nix }} bash -c "find {{ cpp_files }} -type f \
        \\( -name '*.cpp' -o -name '*.hpp' \\) -print0 | xargs -0 clang-format -i"
    {{ nix }} nixpkgs-fmt flake.nix
    {{ nix }} uv run --locked ruff check --fix {{ python_paths }}
    {{ nix }} uv run --locked ruff format {{ python_paths }}

# Check formatting without changing files.
fmt-check:
    {{ nix }} bash -c "find {{ cpp_files }} -type f \
        \\( -name '*.cpp' -o -name '*.hpp' \\) -print0 | \
        xargs -0 clang-format --dry-run --Werror"
    {{ nix }} nixpkgs-fmt --check flake.nix
    {{ nix }} uv run --locked ruff format --check {{ python_paths }}

# Run clang-tidy over project translation units.
lint: configure
    {{ nix }} bash -c 'args=(); \
        if [[ "$(uname -s)" == Linux ]]; then \
          gcc="$(<"$NIX_CC/nix-support/orig-cc")"; \
          libc="$(<"$NIX_CC/nix-support/orig-libc-dev")"; \
          ver="$($gcc/bin/g++ -dumpfullversion)"; \
          triple="$($gcc/bin/g++ -dumpmachine)"; \
          args=(--extra-arg-before="-isystem$gcc/include/c++/$ver" \
                --extra-arg-before="-isystem$gcc/include/c++/$ver/$triple" \
                --extra-arg-before="-isystem$libc/include"); \
        fi; \
        find apps/daemon src tests -type f -name "*.cpp" -print0 | \
          xargs -0 clang-tidy --quiet -p build/{{ profile }} "${args[@]}"'

# Start clangd for editor integrations.
lsp:
    {{ nix }} clangd --enable-config

# Run Ruff and ty.
python-check:
    {{ nix }} uv run --locked ruff check {{ python_paths }}
    {{ nix }} uv run --locked ruff format --check {{ python_paths }}
    if find scripts -type f -name '*.py' | grep -q .; then {{ nix }} uv run --locked ty check; fi

# Run formatting, lint, build, tests, and Python checks.
check: fmt-check lint test python-check

# Remove generated build artifacts.
clean:
    rm -rf build compile_commands.json CMakeUserPresets.json
