{
  description = "Basis TypeScript library development environment";

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
        in
        rec {
          default = pkgs.mkShell {
            packages = [
              pkgs.git
              pkgs.hk
              pkgs.nodejs_24
              pkgs.pnpm_12
              pkgs.nixd
              pkgs.nixpkgs-fmt
            ];
          };
          browser = pkgs.mkShell ({
            inputsFrom = [ default ];
          } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            packages = [ pkgs.chromium ];
            BASIS_CHROMIUM = "${pkgs.chromium}/bin/chromium";
          });
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
