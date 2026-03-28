# Permission Gate

Pi extension that gates tool calls with user confirmation.

## Model Roles Integration

The permission gate integrates with the model roles system (`shared/model-roles.ts`)
to provide LLM-generated explanations of tool calls in the confirmation dialog.
When the "explain" role is configured in `~/.pi/agent/roles.json`, each confirmation
dialog shows a colored SAFE/RISKY/DANGEROUS verdict with a short tl;dr. Press Ctrl+E
for detail.

### Verdict criteria

| Verdict | Meaning | Default cursor | Color |
|---------|---------|---------------|-------|
| SAFE | Read-only, regenerable artifacts, routine ops | Allow once | Green |
| RISKY | Modifies/deletes specific files, limited blast radius | Allow once | Yellow |
| DANGEROUS | Large-scale data loss, credential exposure, exfiltration, arbitrary code exec | Block | Red |

Single file deletion is RISKY even outside the project. DANGEROUS is reserved for
catastrophic or security-critical operations.

### Auto-classify

When enabled (`/permissions` > Toggle auto-classify), the sidecar classifies each
tool call *before* showing the dialog. If the verdict is auto-allowable for the
current mode, the call proceeds without confirmation.

| Mode | Auto-allows | Confirms |
|------|-------------|----------|
| Careful + auto | SAFE | RISKY, DANGEROUS |
| Trust project + auto | SAFE, RISKY | DANGEROUS |

Exact-match caching: identical tool calls (same command, same file, same content)
reuse the previous verdict. Useful for repeated test/lint/build commands.

Parse failures fall through to the dialog (never auto-allow garbage).
Sidecar failures fall through to the dialog (graceful degradation).

Status bar shows `+auto [N auto]` with count of auto-allowed calls.
`/permissions` > View auto-allow log shows recent auto-allowed calls.

## Modes

| Mode | Reads | Writes/Edits | Sensitive files | Bash |
|------|-------|-------------|-----------------|------|
| Careful (default) | allow | confirm | confirm | confirm |
| Trust project | allow | allow in project | confirm | confirm |
| Allow all | allow | allow | allow | allow |

Cycle modes with `Ctrl+Shift+A`. Open settings with `/permissions`.

## Confirmation UI

Every confirmation shows a custom TUI with:
- Select list of actions (Allow once, Allow for session, Block)
- Note input field (Tab to focus) — attached to the tool result so the model sees it
- Notes on allow: appended as `[User note: ...]` to tool output
- Notes on block: used as the block reason

## Session rules

Rules accumulate during a session and reset on session switch:

- **Path rules**: exact paths or globs (`**/*.nix`, `config/llm/pi/**`)
- **Bash prefix rules**: command prefixes (`bun test`, `git`, `rg`)
- **Tool overrides**: allow all calls to a specific tool (edit, write, bash)

Add rules via `/permissions` or from the confirmation dialog.

## Project boundary

Project root = git root (worktree-aware). Worktrees resolve to the main
repo root. Falls back to cwd if not in a git repo.

## Sensitive files

Always confirmed (except in Allow All mode), even with tool overrides:
`.env*`, `*.pem`, `*.key`, `*.p12`, `secrets/`, `.ssh/`, `.gnupg/`,
`id_rsa*`, `id_ed25519*`

## Files

- `logic.ts` — Pure decision engine, no pi dependencies
- `logic.test.ts` — Tests for decision logic and auto-classify helpers
- `explain.ts` — Verdict parsing, tool call description, block reasons
- `explain.test.ts` — Tests for explain/verdict logic
- `confirm-ui.ts` — Custom TUI component (SelectList + Input note field + explanation display)
- `index.ts` — Pi extension wrapper (UI, events, auto-classify, tool_result note injection)

## Known limitations

- Confirm dialog doesn't support Ctrl+O to expand/collapse tool output. When the
  model generates a long file, you can't scroll the pending content before deciding.
  Would need integration with pi's tool output expansion system.
- Trust project mode still confirms all bash (scoping commands to dirs is unreliable).
- Cross-extension imports work via `../shared/` but keep extension-specific logic local.

## Testing

```bash
bun test extensions/permission-gate/
```
