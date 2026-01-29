# Architecture

Nix flake for macOS (nix-darwin) and NixOS. Declarative system configuration with Home Manager for user environment.

## Directory Structure

```
flake.nix                 # Entry point: inputs, darwinConfigurations
flake.lock                # Pinned dependency versions
machines/<hostname>/      # Machine-specific config
modules/
├── common.nix            # Shared darwin/NixOS settings
├── primaryUser.nix       # User option definitions
├── darwin/               # macOS-specific modules
│   ├── default.nix       # Module aggregator
│   ├── core.nix          # Nix settings, sops-nix, zsh
│   ├── brew.nix          # Homebrew: taps, brews, casks, MAS apps
│   └── preferences.nix   # macOS system preferences
└── home-manager/         # User environment
    ├── default.nix       # Package lists, custom app symlinks
    ├── shell.nix         # zsh, aliases, prompt
    ├── git.nix           # Git config, signing
    └── ...               # Other user-level modules
packages/                 # Custom derivations
```

## Flake Inputs

- `nixpkgs` / `nixpkgs-unstable` - Package sources
- `darwin` - nix-darwin for macOS system config
- `home-manager` - User environment management
- `lix-module` - Lix (Nix fork) for the Nix implementation
- `sops-nix` - Secrets management

## Package Management

Three-tier system:

1. **nixpkgs** (`modules/home-manager/default.nix`) - CLI tools, cross-platform
2. **Homebrew** (`modules/darwin/brew.nix`) - GUI casks, macOS-specific CLIs
3. **Custom packages** (`packages/`) - Software not in nixpkgs or Homebrew

See [homebrew-vs-nixpkgs.md](homebrew-vs-nixpkgs.md) for decision criteria.

## Adding a New Machine

1. Create `machines/<hostname>/default.nix`
2. Add `darwinConfigurations."<hostname>"` in `flake.nix` using `mkDarwinHost`
3. Set hostname: `sudo scutil --set HostName <hostname>`

## Key Integrations

- **1Password**: SSH agent socket, git commit signing, CLI plugins
- **Homebrew**: Managed by nix-darwin, auto-upgrades on switch
- **Secrets**: sops-nix with age encryption (see [secrets.md](secrets.md))
