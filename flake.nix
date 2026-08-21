{
  description = "basis C++23 development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs
    , ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          llvm = pkgs.llvmPackages_22;
          isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
          darwinTools = llvm.clang-tools;
          darwinClang = pkgs.writeShellScriptBin "clang" ''
            exec /usr/bin/clang "$@"
          '';
          darwinClangxx = pkgs.writeShellScriptBin "clang++" ''
            exec /usr/bin/clang++ "$@"
          '';
          darwinClangd = pkgs.writeShellScriptBin "clangd" ''
            resource_dir="$(/usr/bin/env -u SDKROOT DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun clang -print-resource-dir)" || exit 1
            exec "${darwinTools}/bin/clangd-unwrapped" \
              --resource-dir="$resource_dir" \
              "$@"
          '';
          darwinClangFormat = pkgs.writeShellScriptBin "clang-format" ''
            exec "${darwinTools}/bin/clang-format" "$@"
          '';
          darwinClangTidy = pkgs.writeShellScriptBin "clang-tidy" ''
            sdk="$(/usr/bin/env -u SDKROOT DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun --sdk macosx --show-sdk-path)" || exit 1
            resource_dir="$(/usr/bin/env -u SDKROOT DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun clang -print-resource-dir)" || exit 1
            exec "${darwinTools}/bin/clang-tidy-unwrapped" \
              --extra-arg-before=-isysroot \
              --extra-arg-before="$sdk" \
              --extra-arg-before=-resource-dir \
              --extra-arg-before="$resource_dir" \
              "$@"
          '';
          darwinLldb = pkgs.writeShellScriptBin "lldb" ''
            exec /usr/bin/lldb "$@"
          '';
          compilerPackages =
            pkgs.lib.optionals isDarwin [
              darwinClang
              darwinClangxx
              darwinClangd
              darwinClangFormat
              darwinClangTidy
              darwinLldb
            ]
            ++ pkgs.lib.optionals (!isDarwin) [
              llvm.clang
              llvm.clang-tools
              llvm.lldb
            ];
        in
        {
          default = pkgs.mkShell {
            packages = compilerPackages ++ [
              pkgs.ccache
              pkgs.cmake
              pkgs.conan
              pkgs.git
              pkgs.just
              pkgs.ninja
              pkgs.nixd
              pkgs.nixpkgs-fmt
              pkgs.python3
              pkgs.uv
            ];

            CMAKE_GENERATOR = "Ninja";

            shellHook =
              if isDarwin then
                ''
                  export PATH="$PWD/build/debug:${darwinClang}/bin:${darwinClangxx}/bin:$PATH"
                  export CC=/usr/bin/clang
                  export CXX=/usr/bin/clang++
                  export CMAKE_MAKE_PROGRAM="$(command -v ninja)"
                  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
                  export SDKROOT="$(/usr/bin/xcrun --sdk macosx --show-sdk-path)"
                  export UV_PYTHON="$(command -v python3)"
                ''
              else
                ''
                  export PATH="$PWD/build/debug:$PATH"
                  export CC="${llvm.clang}/bin/clang"
                  export CXX="${llvm.clang}/bin/clang++"
                  export CMAKE_MAKE_PROGRAM="$(command -v ninja)"
                  export UV_PYTHON="$(command -v python3)"
                '';
          };
        }
      );

      formatter = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.writeShellApplication {
          name = "format-flake";
          runtimeInputs = [ pkgs.nixpkgs-fmt ];
          text = ''exec nixpkgs-fmt "$PWD/flake.nix"'';
        }
      );
    };
}
