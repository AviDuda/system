# AGENTS.md

Nix flake for macOS (nix-darwin) and NixOS system configuration.

## Quick Reference

```bash
mise nix-switch       # Format, build, and apply (or: nix-switch from anywhere)
mise fast-switch      # Build/apply without formatting
mise nix-diff         # Preview changes before applying
mise fmt              # Format .nix files
mise repl             # REPL with flake outputs
```

## Key Paths

| Task | Location |
|------|----------|
| Add nixpkgs packages | `modules/home-manager/default.nix` |
| Add Homebrew casks/brews | `modules/darwin/brew.nix` |
| Add custom package | `packages/` (see @docs/custom-packages.md) |
| Modify shell config | `modules/home-manager/shell.nix` |
| Add git aliases/config | `modules/home-manager/git.nix` |
| macOS system preferences | `modules/darwin/preferences.nix` |
| Machine-specific config | `machines/<hostname>/default.nix` |
| LLM instructions/skills | `config/llm/` |
| Secrets (encrypted) | `secrets/` (see @docs/secrets.md) |

## @-mentions

@docs/architecture.md - Module structure, flake inputs, directory layout
@docs/custom-packages.md - Creating package derivations
@docs/homebrew-vs-nixpkgs.md - When to use Homebrew vs nixpkgs

## Project Context

- **Task runner**: mise (not make/just). Tasks defined in `mise.toml`.
- **Nix implementation**: Lix (Nix fork), not standard Nix.
- **Secrets**: sops-nix with age encryption. Keys in `.sops.yaml`.
- **Formatter**: nixfmt (official). Run `mise fmt` before committing.

## Guidelines

- Stage new files with `git add` before running nix-switch. Flakes only see git-tracked files. Run `mise run _check-git` to verify.
- Run `mise nix-diff` before `mise nix-switch` when testing changes. Shows what would change without applying.
- Use `callPackage` pattern for custom packages. See existing `packages/*.nix` for examples.
- macOS app bundles from custom packages need symlinks in `modules/home-manager/default.nix` to appear in `~/Applications`.
- Test format with `mise fmt-check` before proposing changes.
- When adding Homebrew casks, prefer nixpkgs if the package is available and works well on macOS.
