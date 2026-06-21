# Upgrading Nix

## Version locations

All version pins are in `flake.nix`:

```nix
nixpkgs.url = "github:nixos/nixpkgs/nixos-XX.YY";
url = "github:lnl7/nix-darwin/nix-darwin-XX.YY";
url = "github:nix-community/home-manager/release-XX.YY";
```

## Check latest releases

Repos:
- https://github.com/NixOS/nixpkgs
- https://github.com/LnL7/nix-darwin
- https://github.com/nix-community/home-manager
- https://git.lix.systems/lix-project/lix

One-liners to check latest release branches:

```bash
# nixpkgs
gh api repos/NixOS/nixpkgs/branches --paginate --jq '.[].name' | grep -E '^nixos-[0-9]+\.[0-9]+$' | sort -V | tail -3

# nix-darwin
gh api repos/LnL7/nix-darwin/branches --paginate --jq '.[].name' | grep -E '^nix-darwin-[0-9]+\.[0-9]+$' | sort -V | tail -3

# home-manager
gh api repos/nix-community/home-manager/branches --paginate --jq '.[].name' | grep -E '^release-[0-9]+\.[0-9]+$' | sort -V | tail -3
```

Note: nix-darwin often lags behind nixpkgs/home-manager by one release.

Lix is now managed via nixpkgs (see https://lix.systems/add-to-config/).
The package is set in `modules/darwin/core.nix` and `modules/nixos/core.nix`.
To check available versions, see `pkgs/tools/package-management/lix/default.nix` in nixpkgs, or:

```bash
# Available lix versions in nixpkgs
gh api repos/NixOS/nixpkgs/contents/pkgs/tools/package-management/lix/default.nix?ref=nixos-XX.YY --jq '.content' | base64 -d | grep 'version ='
```

## Changelogs

- nix-darwin: https://github.com/LnL7/nix-darwin/blob/master/CHANGELOG
- home-manager: https://nix-community.github.io/home-manager/release-notes/rl-2605.html

Note: The URL includes the release version (e.g. `rl-2605.html`). Update it when changing the release branch (e.g. `rl-2611.html`).
- nixpkgs: https://nixos.org/manual/nixos/stable/release-notes.html
- lix: https://docs.lix.systems/manual/lix/nightly/release-notes/release-notes.html

## Upgrade steps

1. Read the changelogs above for breaking changes
2. Update version strings in `flake.nix`
3. Run the upgrade:
   ```bash
   mise nix-upgrade  # or: nix-upgrade (from anywhere)
   ```
   This updates flake inputs, runs garbage collection, switches the system, and updates global mise tools.
4. If something breaks, roll back:
   ```bash
   sudo darwin-rebuild switch --rollback
   ```

## About stateVersion

`stateVersion` in `home-manager/default.nix` and `nixos/core.nix` is not a version indicator. It controls default behaviors and migration paths.

Do not change it unless:
- Fresh install on a new machine
- You've read the release notes and understand the migrations

## Release schedule

NixOS releases twice a year:
- XX.05 in May
- XX.11 in November

nix-darwin and home-manager follow the same schedule but may release slightly later.
