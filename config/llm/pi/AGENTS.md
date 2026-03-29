# AGENTS.md

Pi coding agent extensions and configuration, deployed via Nix (`modules/home-manager/pi.nix`).

## Quick Reference

```bash
mise pi-check    # biome lint + bun test
mise pi-fmt      # biome auto-fix
mise nix-diff    # verify Nix build after changes
```

## Key Paths

| What | Where |
|------|-------|
| Pi extension docs | `/opt/homebrew/Cellar/pi-coding-agent/*/libexec/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` |
| Pi TUI component docs | Same path but `docs/tui.md` |
| Pi extension examples | Same path but `examples/extensions/` |
| Pi TUI type declarations | Same path but `node_modules/@mariozechner/pi-tui/dist/components/*.d.ts` |
| Nix module that deploys these | `modules/home-manager/pi.nix` |
| Shared LLM constants | `modules/home-manager/llm-shared.nix` |
| Global instructions | `config/llm/instructions.md` |

## Guidelines

- Multi-file extensions go in a subdirectory with `index.ts` as entry point and a README.
- Extract testable logic into a pure module (no pi imports). Test with bun.
- All extensions are symlinked live to `~/.pi/agent/extensions/` — edit + `/reload` works without nix-switch.
- Runtime config (journal constants, model roles) is read from `~/.config/llm/journal.json` and `~/.pi/agent/roles.json` respectively.
- Auto-discovery: any directory under `config/llm/pi/extensions/` with an `index.ts` is symlinked automatically by `pi.nix`. No Nix changes needed to add a new extension.
- Cross-extension imports work via `../shared/` (Node resolves symlinks to real paths before resolving relative imports).
- Shared code goes in `extensions/shared/` (no `index.ts` = not discovered as an extension).
- Run `mise pi-check` before committing. `mise check` includes it.

### Runtime: Node, not Bun

Pi extensions run in **Node.js**, not Bun. Tests run under `bun test`. This mismatch is a trap:

- **No Bun APIs in extension code.** `Bun.spawn`, `Bun.file`, `Bun.write`, etc. will throw `ReferenceError` at runtime but pass in tests. Use `node:child_process`, `node:fs`, etc. instead.
- **Bun-only test APIs are fine.** `bun:test`, `Bun.spawn` in test files only — these never run in pi.
- If spawning processes from extensions, use `child_process.execFile` or `child_process.spawn` from `node:child_process`.

## TUI API notes

Read the `.d.ts` files for actual APIs — don't guess method names. Key components:
- `SelectList`: `getSelectedItem()` (not `getSelectedIndex()`), `onSelect`, `onCancel`, `onSelectionChange`, `setSelectedIndex()`
- `Input`: `getValue()` / `setValue()` (not `getText()`), `onSubmit`, `onEscape`
- `Text`: `setText()`, constructor takes `(text, paddingLeft, paddingTop)`
- `Container`: `addChild()`, renders children vertically
- `DynamicBorder`: from `@mariozechner/pi-coding-agent`, not pi-tui
- `matchesKey(data, key)`: from pi-tui, use for key matching in `handleInput`
- `ctx.ui.custom<T>()`: returns a Component, must have `render(width)`, `invalidate()`, `handleInput(data)`
