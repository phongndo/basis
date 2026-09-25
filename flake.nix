{
  description = "basis Bun development environment";

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
          isLinux = pkgs.stdenv.hostPlatform.isLinux;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.git
              pkgs.nodejs_22
              pkgs.nixd
              pkgs.nixpkgs-fmt
            ]
            # The npm Electron binary does not run on NixOS; Darwin uses the npm one.
            ++ pkgs.lib.optionals isLinux [ pkgs.electron_42-bin ];

            shellHook = pkgs.lib.optionalString isLinux ''
              export BASIS_ELECTRON_BIN="${pkgs.electron_42-bin}/bin/electron"
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
