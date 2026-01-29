# Commands

Task runner: [mise](https://mise.jdx.dev/). Run from `~/system` directory, or use shell aliases from anywhere.

## Build & Apply

| Command | Alias | Description |
|---------|-------|-------------|
| `mise nix-switch` | `nix-switch` | Format, build, and apply configuration |
| `mise fast-switch` | `mise fs` | Build and apply without formatting (rapid iteration) |
| `mise nix-build` | `mise b` | Build without applying |
| `mise nix-upgrade` | `nix-upgrade` | Update flake inputs, switch, garbage collect |

## Inspection

| Command | Description |
|---------|-------------|
| `mise nix-diff` | Show what would change before switching |
| `mise repl` | REPL with flake outputs (`pkgs`, `lib`, `configs`) |

## Maintenance

| Command | Description |
|---------|-------------|
| `mise fmt` | Format all .nix files (nixpkgs-fmt) |
| `mise fmt-check` | Check formatting without changing files |
| `mise gc` | Garbage collect store (default: 60 days) |
| `mise gc -- 30` | Garbage collect older than 30 days |

## Homebrew

```bash
brew bundle check -v   # List missing dependencies
brew bundle cleanup    # List unexpected dependencies (--force to remove)
```

## Source Hash Prefetching

For custom packages:

```bash
# From URL (zip, tar.gz, dmg)
nix-prefetch-url --type sha256 URL

# From GitHub source tarball
nix-prefetch-url --unpack --type sha256 URL

# From git repo
nix-prefetch-git URL --rev REV
```
