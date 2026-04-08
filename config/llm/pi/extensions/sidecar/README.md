# /sidecar-models — Configure sidecar model roles

Interactive command for picking which models handle sidecar tasks (permission-gate explain, draft-suggestion).

## Usage

```
/sidecar-models
```

Opens a two-screen UI:
1. **Role list** — shows all configured roles and their current primary model
2. **Model picker** — all available models, with chain position indicators (`#1 ✓`, `✗`)

### Keybindings

**Role list:**
- `Enter` — select role → model picker
- `r` — reset all roles to defaults
- `Ctrl+C` / `Esc` — cancel

**Model picker** (matches `/scoped-models` conventions):
- `Enter` — toggle model in/out of chain (added at end if new)
- `Alt+↑↓` — reorder within chain
- `Ctrl+A` — add all (or all filtered) to chain
- `Ctrl+X` — remove all (or all filtered) from chain
- `Ctrl+P` — toggle all models from same provider
- `Ctrl+S` — save to `roles.local.json`
- `r` — reset this role to defaults
- `Ctrl+C` — clear search or back to role list
- `Esc` — back to role list

Type in the search box to fuzzy-filter models by name, ID, or provider.

## How it works

- **roles.json** — default role configuration (deployed by pi.nix or hand-edited)
- **roles.local.json** — runtime overrides saved by `Ctrl+S`
- `model-roles.ts` merges both, with local taking precedence per-role

Toggling a model adds it to the end of the fallback chain (or removes it). `Alt+↑↓` reorders within the chain. Changes are session-only until `Ctrl+S` saves them.

### Reset overrides

Delete `~/.pi/agent/roles.local.json` to revert to defaults:

```bash
rm ~/.pi/agent/roles.local.json
```
