{
  # NOTE: Some modules use mkOutOfStoreSymlink (e.g., 1Password socket).
  # This requires --impure flag for evaluation, or the symlink target
  # must exist at build time. On a fresh system, run 1Password first.
  description = "nix system flake";

  inputs = {
    # Packages
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    # Systems
    nixos-hardware.url = "github:nixos/nixos-hardware";
    darwin = {
      # Keep version in sync with nixpkgs
      url = "github:lnl7/nix-darwin/nix-darwin-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager = {
      # See https://nix-community.github.io/home-manager/release-notes/rl-2605.html
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Android agent skills (upstream repo). flake=false: consumed as a source
    # path only (skills are symlinked to ~/.{pi,claude,opencode}/skills/), not built.
    android-skills = {
      url = "github:android/skills";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-unstable,
      darwin,
      home-manager,
      ...
    }@inputs:
    let
      supportedSystems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

      # Overlay to fix packages with broken tests on Darwin
      # Only applied in mkDarwinHost, so no need for isDarwin check
      darwinFixesOverlay = final: prev: {
        # 2026-04-06: direnv fish tests get Killed (signal 9) on macOS during sandbox build
        direnv = prev.direnv.overrideAttrs { doCheck = false; };
      };

      # Unstable packages for when stable is too outdated
      pkgs-unstable-for =
        system:
        import nixpkgs-unstable {
          inherit system;
          config.allowUnfree = true;
        };

      # Helper to create darwin configurations with common settings
      mkDarwinHost =
        {
          machine,
          system ? "aarch64-darwin",
        }:
        let
          pkgs-unstable = pkgs-unstable-for system;
        in
        darwin.lib.darwinSystem {
          inherit system;
          specialArgs = { inherit inputs self pkgs-unstable; };
          modules = [
            { nixpkgs.overlays = [ darwinFixesOverlay ]; }
            machine
            home-manager.darwinModules.home-manager
            (
              { config, ... }:
              {
                home-manager.useUserPackages = true;
                home-manager.useGlobalPkgs = true;
                home-manager.backupFileExtension = "backup";
                home-manager.extraSpecialArgs = {
                  inherit pkgs-unstable;
                  inherit (config) systemFlakeDir;
                  android-skills = inputs.android-skills;
                };
              }
            )
            inputs.sops-nix.darwinModules.sops
          ];
        };

      # Helper to create NixOS configurations with common settings
      mkNixosHost =
        {
          machine,
          system ? "aarch64-linux",
        }:
        let
          pkgs-unstable = pkgs-unstable-for system;
        in
        nixpkgs.lib.nixosSystem {
          inherit system;
          specialArgs = { inherit inputs self pkgs-unstable; };
          modules = [
            machine
            home-manager.nixosModules.home-manager
            (
              { config, ... }:
              {
                home-manager.useUserPackages = true;
                home-manager.useGlobalPkgs = true;
                home-manager.backupFileExtension = "backup";
                home-manager.extraSpecialArgs = {
                  inherit pkgs-unstable;
                  inherit (config) systemFlakeDir;
                  android-skills = inputs.android-skills;
                };
              }
            )
            inputs.sops-nix.nixosModules.sops
          ];
        };
    in
    {
      # nix fmt
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);

      darwinConfigurations."procyonid-trailblazer" = mkDarwinHost {
        machine = ./machines/procyonid-trailblazer;
      };

      nixosConfigurations."phantom-tanuki" = mkNixosHost {
        machine = ./machines/phantom-tanuki;
      };
    };
}
