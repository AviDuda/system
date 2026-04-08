# /sidecar — Configure sidecar model roles

Interactive command for picking which models handle sidecar tasks (permission-gate explain, draft-suggestion).

## Usage

```
/sidecar
```

Opens a two-screen UI:
1. **Role list** — shows all configured roles and their current primary model
2. **Model picker** — all available models, with chain position labels (`#1`, `#2`, ...)

### Keybindings

**Role list:**
- `Enter` — select role → model picker
- `r` — reset all roles to defaults
- `Esc` — cancel

**Model picker:**
- `Enter` — set model as primary (`#1`)
- `p` — promote one position up the chain
- `d` — demote one position down the chain
- `x` — remove from chain
- `/` — toggle search filter (matches name and model ID)
- `r` — reset this role to defaults
- `Esc` — back to role list

Search filters the visible list but arrows and actions still work while filtered.

## How it works

- **roles.json** — default role configuration (deployed by pi.nix or hand-edited)
- **roles.local.json** — runtime overrides written by `/sidecar`
- `model-roles.ts` merges both, with local taking precedence per-role

Selecting a model moves it to position `#1` in the fallback chain. `p`/`d` reorder within the chain. Changes take effect immediately — the config is re-read on each sidecar call.

### Reset overrides

Delete `~/.pi/agent/roles.local.json` to revert to defaults:

```bash
rm ~/.pi/agent/roles.local.json
```
