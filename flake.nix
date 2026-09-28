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
          # Pin Bun independently of nixpkgs; hashes are from the release's SHASUMS256.txt.
          bun = pkgs.bun.overrideAttrs (finalAttrs: previousAttrs: {
            version = "1.4.2";
            src = finalAttrs.passthru.sources.${system};
            passthru = previousAttrs.passthru // {
              sources = {
                aarch64-darwin = pkgs.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-darwin-aarch64.zip";
                  hash = "sha256-kJh6OhbX21VtiGrD1VHnttPt8KHPQ6yu1iLoZ2vh0S8=";
                };
                aarch64-linux = pkgs.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-aarch64.zip";
                  hash = "sha256-VDKLvC2cjgyfiSxUTWbFeoO4QTnjSQnl7oF1jxrI/ac=";
                };
                x86_64-darwin = pkgs.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-darwin-x64-baseline.zip";
                  hash = "sha256-utW71s8U0JgNEV9ZVMn/kE32GdXplNLaH/zNPzFjALA=";
                };
                x86_64-linux = pkgs.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-x64-baseline.zip";
                  hash = "sha256-xngEDxT+BEDrg503y9DOTAUaMtpygGrJfeamqra/co8=";
                };
              };
            };
          });
        in
        rec {
          default = pkgs.mkShell {
            packages = [
              bun
              pkgs.git
              pkgs.nodejs_22
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
