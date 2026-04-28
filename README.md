# system

Raccoons are generalists. They eat anything, live anywhere, and figure out how to open every trash can on the block. This repo does the same thing for computers -- one flake that configures macOS machines, NixOS VMs, and Windows VMs, plus all the tooling to make LLM agents useful along the way.

## What's in here

```
config/
  llm/             Pi extensions (LSP, permission gate, sidecar, vision...), MCP servers,
                   benchmarks, skills -- the brain infrastructure for AI agents
  windows/         Windows 11 ARM64 VM scripts (unattended install, firstlogin, debloat)
docs/              Architecture, commands, secrets, Windows VMs, Quake mapping...
machines/          Per-host config (procyonid-trailblazer = macOS, phantom-tanuki = NixOS)
modules/
  darwin/          macOS system config (Homebrew, preferences, core settings)
  home-manager/    User-level config (shell, git, editors, LLM tools, 1Password)
  nixos/           NixOS system config (graphical, core, SPICE clipboard)
packages/          Custom derivations (forepaw, Godot, TrenchBroom, Quake tools)
scripts/           Build helpers, VM scripts, winrun, package update checker
secrets/           sops-nix encrypted secrets (GitHub, Kagi, Tailscale, LLM keys)
tailscale/         Tailscale ACL policy + push script
```

## Getting started (macOS)

1. **Set hostname** (must match a `darwinConfigurations` entry in `flake.nix`):
    ```bash
    my_hostname="my-macbook-pro"
    sudo scutil --set HostName $my_hostname
    sudo scutil --set LocalHostName $my_hostname
    sudo scutil --set ComputerName $my_hostname
    dscacheutil -flushcache
    ```

2. **Install Lix** ([docs](https://lix.systems/install/)):
    ```bash
    curl -sSf -L https://install.lix.systems/lix | sh -s -- install
    nix run nixpkgs#hello  # verify it works
    ```

3. **Clone this repo** to `~/system`

4. **Add machine config** if needed:
    - Create `machines/<hostname>/default.nix`
    - Add `darwinConfigurations` entry in `flake.nix`

5. **Optional:** Create `.env` to override hostname (see `.env.example`)

6. **First build:**
    ```bash
    nix run nix-darwin -- switch --flake .
    ```

## Daily commands

```bash
mise nix-switch       # Format, build, and apply (or: nix-switch from anywhere)
mise fast-switch      # Build/apply without formatting
mise nix-diff         # Preview changes before applying
mise nix-upgrade      # Update flake inputs and rebuild
mise fmt              # Format .nix files
mise cpu              # Check custom packages for upstream updates
```

Homebrew is managed via nix and [`modules/darwin/brew.nix`](modules/darwin/brew.nix). See [docs/homebrew-vs-nixpkgs.md](docs/homebrew-vs-nixpkgs.md) for when to use which.

## Windows VMs

Build Windows 11 ARM64 VMs in UTM with unattended installation, auto-logon, SSH, RDP, and a full dev environment. Clone disposable test VMs in 0.25s via APFS copy-on-write.

```bash
mise nwu -- --username avi --password hunter2   # Download ISO + create VM
mise wr -- config/windows/personalize.ps1        # Install tools (git, mise, browsers...)
mise wr -- config/windows/debloat.ps1            # Kill ads/suggestions/Copilot
```

See [docs/windows-vms.md](docs/windows-vms.md) for the full guide.

## NixOS

The repo includes NixOS config for UTM VMs (and potentially bare metal). See [docs/nixos-vms.md](docs/nixos-vms.md) for setup instructions.

## LLM agents

`config/llm/` holds pi extensions (LSP integration, permission gate, sidecar model routing, vision, web search, draft suggestions, journaling), an MCP web-search server with Kagi, local LLM benchmarks, and skills. See `config/llm/README.md` and `config/llm/pi/README.md` for details.

## Documentation

| Doc | Contents |
|-----|----------|
| [Architecture](docs/architecture.md) | Module structure, flake inputs, directory layout |
| [Commands](docs/commands.md) | Build, inspect, maintain |
| [Custom packages](docs/custom-packages.md) | Creating package derivations |
| [Homebrew vs nixpkgs](docs/homebrew-vs-nixpkgs.md) | Package placement |
| [Secrets](docs/secrets.md) | sops/age management |
| [Upgrading](docs/upgrading.md) | Version upgrades |
| [Windows VMs](docs/windows-vms.md) | Windows 11 ARM64 VM creation |
| [NixOS VMs](docs/nixos-vms.md) | NixOS VM setup |

## Resources

- [nix-darwin manual](https://daiderd.com/nix-darwin/manual/index.html)
- [Home Manager manual](https://nix-community.github.io/home-manager/index.xhtml)
- [Lix documentation](https://docs.lix.systems/manual/nightly/)

### Influences

- https://gitlab.canidae.systems/htw/system (main inspiration)
- https://github.com/kclejeune/system
- https://github.com/i077/system
- https://xyno.space/post/nix-darwin-introduction
- https://nixcademy.com/2024/01/15/nix-on-macos/
