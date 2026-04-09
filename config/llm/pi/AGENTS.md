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

- Multi-file extensions go in a subdirectory with `index.ts` as entry point and a README. See `ls config/llm/pi/extensions/` for current extensions.
- Extract testable logic into a pure module (no pi imports). Test with bun.
- All extensions are symlinked live to `~/.pi/agent/extensions/` — edit + `/reload` works without nix-switch.
- Runtime config (journal constants, model roles) is read from `~/.config/llm/journal.json` and `~/.pi/agent/roles.json` respectively.
- Auto-discovery: any directory under `config/llm/pi/extensions/` with an `index.ts` is symlinked automatically by `pi.nix` (the `allExtDirs` let binding reads the directory at eval time and generates symlink commands). Adding a new extension directory only requires `mise nix-switch` — no manual Nix edits. Directories without `index.ts` (like `shared/`) are also symlinked but pi only loads them as extensions if they have `index.ts`.
- Cross-extension imports work via `../shared/` (Node resolves symlinks to real paths before resolving relative imports).
- Shared code goes in `extensions/shared/` (no `index.ts` = not discovered as an extension).
- Run `mise pi-check` before committing. `mise check` includes it.

### Runtime: Node, not Bun

Pi extensions run in **Node.js**, not Bun. Tests run under `bun test`. This mismatch is a trap:

- **No Bun APIs in extension code.** `Bun.spawn`, `Bun.file`, `Bun.write`, etc. will throw `ReferenceError` at runtime but pass in tests. Use `node:child_process`, `node:fs`, etc. instead.
- **Bun-only test APIs are fine.** `bun:test`, `Bun.spawn` in test files only — these never run in pi.
- If spawning processes from extensions, use `child_process.execFile` or `child_process.spawn` from `node:child_process`.

## TUI API notes

Read the `.d.ts` files for actual APIs — don't guess method names. Use LSP (go-to-definition, hover) on imports from `@mariozechner/pi-tui` and `@mariozechner/pi-coding-agent` to explore available types and methods.

### Key types (from `@mariozechner/pi-coding-agent`)

- `ExtensionAPI` — the `pi` parameter passed to the extension factory. Has `registerCommand`, `registerTool`, `on`, `registerProvider`, etc.
- `ExtensionContext` — the `ctx` parameter in event handlers and command handlers. Has `ui`, `modelRegistry`, `sessionManager`, `model`, `cwd`, etc.
- `ExtensionUIContext` — `ctx.ui` separately. Use when a helper only needs UI methods. Has `select`, `confirm`, `input`, `notify`, `custom`, `setStatus`, `theme`, etc.
- `Theme` — theming object with `fg(color, text)`, `bold(text)`, `dim(text)`, etc. Color names: `"accent"`, `"muted"`, `"dim"`, `"success"`, `"warning"`, `"error"`, etc.

### UI methods (`ctx.ui.*`)

- `ctx.ui.custom<T>(factory)` — show a custom keyboard-focused component. Factory receives `(tui, theme, keybindings, done)`. Return an object with `render(width)`, `invalidate()`, `handleInput(data)`. `done(result)` dismisses it. The component can be a flat object (no Container needed) or a class.
- `ctx.ui.setStatus(key, text)` — add/update a footer status pill. Pass `undefined` as text to remove. Use `ctx.ui.theme.fg("muted", text)` for styling. Keys are unique per extension: `"sidecar"`, `"web-search"`, `"draft"`, `"lsp"`.
- `ctx.ui.notify(message, type)` — show a toast notification. Types: `"info"`, `"warning"`, `"error"`.
- `ctx.ui.select(title, options)`, `ctx.ui.confirm(title, message)`, `ctx.ui.input(title, placeholder)` — simple dialog methods for non-complex interactions.

### pi-tui components (from `@mariozechner/pi-tui`)

- `Input` — single-line text input. Full Component with `render(width)` and `handleInput(data)`. Methods: `getValue()`, `setValue()`. Use directly inside `ctx.ui.custom()` for search boxes instead of hand-rolling filter state.
- `SelectList` — scrollable selection list. `getSelectedItem()`, `onSelect`, `onCancel`, `setSelectedIndex()`. Note: `setFilter` only matches `value` with `startsWith` — for fuzzy search, use `fuzzyFilter` instead.
- `Text` — static text display. `setText()`. Constructor: `(text?, paddingLeft?, paddingTop?)`.
- `Container` — vertical layout container. `addChild()`, `removeChild()`, `clear()`.
- `Spacer` — vertical spacer. Constructor: `(lines?)`.
- `DynamicBorder` — from `@mariozechner/pi-coding-agent` (not pi-tui). Horizontal border that adjusts to viewport width.

### Keyboard handling

- `Key` — helper for typed key identifiers. `Key.enter`, `Key.escape`, `Key.ctrl("a")`, `Key.alt("up")`, etc. Always prefer this over raw string matching.
- `matchesKey(data, keyId)` — check if raw input matches a key. Use with `Key.*` helpers.
- `getKeybindings()` — returns `KeybindingsManager`. Use `kb.matches(data, "tui.select.up")` for navigation keys — this respects user keybinding overrides. Available binding names: `tui.select.up/down/pageUp/pageDown/confirm/cancel`, `tui.editor.*`.
- `fuzzyFilter(items, query, getText)` — fuzzy-match and sort items by relevance. Much better than `SelectList.setFilter` or custom `includes`/`startsWith` matching.

### Patterns to follow

- **Look at existing extensions** before building new UIs. `sidecar/` has a two-screen custom UI with search and toggle (similar to `/scoped-models`). `permission-gate/` has a confirm dialog with diff preview. `web-search/` has tool registration and status. `draft-suggestion/` has widgets and footer status.
- **Use `ctx.ui.custom()` for complex UIs**, `ctx.ui.select/confirm/input` for simple ones. Don't build a custom component for a single yes/no question.
- **Prefer `Input` + `fuzzyFilter` over `SelectList`** for searchable model/option lists. `SelectList.setFilter` is too limited for human-friendly search.
- **Use `ExtensionContext` as the type for `ctx`** in helper functions, not ad-hoc inline types. Import from `@mariozechner/pi-coding-agent`. `ExtensionContext` has `signal: AbortSignal | undefined` for cancelling async work in event handlers.
- **Footer status is cheap** — use `ctx.ui.setStatus(key, text)` to show extension state. Update on `session_start` and after any config changes.
- **Check `extensions/shared/` before building new UI components or utility logic.** It has reusable modules that multiple extensions share. When two extensions need the same logic, extract it here (no `index.ts` = not discovered as an extension). Keep shared code generic and reusable.
