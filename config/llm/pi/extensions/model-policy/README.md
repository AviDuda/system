# Model Policy Extension

Enforces per-project model policies based on provider tags. Prevents sensitive projects from using non-compliant providers (e.g., ensures personal journals only use local or ZDR-enforced models).

## How it works

**Tags** are defined on providers in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "omlx": { "tags": ["local"], "models": [...] },
    "openrouter-sidecar": { "tags": ["zdr", "cloud"], "models": [...] },
    "zai": { "tags": ["cloud"], "models": [...] }
  }
}
```

Unknown providers default to `["cloud"]`.

**Policies** are defined in `~/.pi/agent/model-policies.json`:

```json
{
  "policies": {
    "~/projects/my-journal": {
      "requireTags": ["local", "zdr"],
      "comment": "Personal journal"
    }
  }
}
```

`requireTags` uses OR logic: a model must have at least ONE of the listed tags. No policy for a project means unrestricted.

## Enforcement

| Event | Behavior |
|-------|----------|
| `session_start` | Validates current model against policy. Auto-switches to first compliant model if non-compliant. |
| `model_select` | Validates on model change (Ctrl+P, `/model`). Reverts to compliant model if non-compliant. |
| `before_provider_request` | Warns if a non-compliant model somehow reaches the request stage. |

## Auto-switch priority

1. First model from `enabledModels` (settings.json) matching required tags
2. First available model from registry matching required tags

The `enabledModels` setting controls the preference order. Wildcard patterns (`openrouter/*`) are supported.

## Status bar

Shows `policy:local|zdr` when active. Hidden when project has no policy (unrestricted).

## Files

| File | Purpose |
|------|---------|
| `policy.ts` | Pure logic: config loading, tag matching, compliance checks. No pi imports. |
| `index.ts` | Pi extension wiring: event handlers, model switching, status bar. |
| `policy.test.ts` | Tests for pure logic functions. |

## Testing

```bash
bun test config/llm/pi/extensions/model-policy/
```
