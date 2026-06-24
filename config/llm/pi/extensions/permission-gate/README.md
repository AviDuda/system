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
| SAFE | Strictly read-only. No creation, modification, deletion, or state changes. | Allow once | Green |
| RISKY | Any filesystem mutation, even if recoverable. | Allow once | Yellow |
| DANGEROUS | Large-scale data loss, credential exposure, exfiltration, arbitrary code exec | Block | Red |

If in doubt between SAFE and RISKY, the sidecar chooses RISKY.

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
Widget below editor shows the latest auto-allow verdict during a turn.

Cache is shared with the explain feature -- classifications from dialogs
warm the cache for auto-classify and vice versa.

## Modes

| Mode | Reads | Writes/Edits | Sensitive files | Bash |
|------|-------|-------------|-----------------|------|
| Careful (default) | allow | confirm | confirm | confirm |
| Trust project | allow | allow in project | confirm | confirm |
| Allow all | allow | allow | allow | allow |

Cycle modes with `Ctrl+Shift+A`. Open settings with `/permissions`.

## Keyboard shortcuts

| Key | Where | Action |
|-----|-------|--------|
| `Ctrl+Shift+A` | Global | Cycle permission mode |
| `Ctrl+Shift+C` | Global | Toggle auto-classify |
| `Ctrl+E` | Confirm dialog | Toggle explanation detail |
| `Ctrl+A` | Confirm dialog | Toggle auto-classify |
| `Ctrl+O` | Confirm dialog | Toggle diff view (compact/full) |
| `Tab` | Confirm dialog | Cycle focus: list → note → diff (when expanded) |

## Confirmation UI

Every confirmation shows a custom TUI with:
- Colored unified diff preview (edit/write/patch tools) — compact 6-line view by default
- Select list of actions (Allow once, Allow for session, Block)
- Multi-line note editor (Tab to focus, Shift+Enter for newlines) — attached to the tool result so the model sees it
- Notes on allow: appended as `[Instruction from the user: ...]` to tool output
- Notes on block: included in the block reason alongside the automated classification

### Diff preview

For `edit` and `write` tool calls, the dialog shows a unified diff computed from
the pending changes. Uses pi's `computeEditsDiff` and `renderDiff` for colored
output with intra-line change highlighting. For `patch`, the diff preview uses
patch's own matcher (from `patch/preview.ts`) so tolerant matches (Unicode
arrows, tab↔space) preview correctly.

- Compact view (6 lines) starts scrolled to the first change
- `Ctrl+O` expands to full view (up to 30 lines, scrollable)
- When expanded: `↑↓` scroll one line, `Shift+↑↓` page jump, `Shift+←→` top/bottom
- Tab cycles focus between list, note, and diff (diff only when expanded)
- Lines wrap preserving ANSI colors via `wrapTextWithAnsi`

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
- `confirm-ui.ts` — Custom TUI component (SelectList + Editor note field + explanation display)
- `index.ts` — Pi extension wrapper (UI, events, auto-classify, tool_result note injection)

## Known limitations

- Trust project mode still confirms all bash (scoping commands to dirs is unreliable).
- Cross-extension imports work via `../shared/` but keep extension-specific logic local.
- No mouse/scroll wheel support (pi TUI is keyboard-only).

## Testing

```bash
bun test extensions/permission-gate/
```
