# LSP Extension

Language Server Protocol integration for pi. Gives the agent IDE-like code intelligence: type checking, go-to-definition, hover info, find references, symbol navigation, and lint feedback.

## What it does

1. **`lsp` tool** — the LLM can call this directly for diagnostics, definition, hover, references, symbols, rename, codeAction, codeActionApply
2. **Auto-diagnostics** — after every edit/write, LSP diagnostics + linter results are appended to the tool result so the model sees type errors and lint issues immediately
3. **Auto-detection** — discovers available language servers and CLI linters from project markers + PATH
4. **File watcher** — watches cwd recursively, sends `workspace/didChangeWatchedFiles` to servers when files are created, changed, or deleted (including via bash). Respects `.gitignore` via `git check-ignore`, with hardcoded fallbacks for non-git directories.
5. **Server request handling** — responds to `client/registerCapability` (stores watcher glob patterns), `client/unregisterCapability`, and `workspace/configuration`
6. **Cold server gating** — if a server times out on auto-diagnostics, it's marked cold and skipped for 5s to avoid blocking edits. Linters always run (they're fast CLI calls).
7. **Code actions** — `codeAction` lists available refactorings/fixes at a position, `codeActionApply` executes one by its index. Supports `codeAction/resolve` for deferred edits.
8. **Progress reporting** — tracks `window/workDoneProgress` from servers and shows progress (title, percentage) in the footer status bar. Stale progress entries are expired after 30s.

## Supported servers

Configured out of the box (requires the binary on PATH):

| Server | Languages | Root markers |
|--------|-----------|-------------|
| typescript-language-server | .ts, .tsx, .js, .jsx | package.json, tsconfig.json |
| rust-analyzer | .rs | Cargo.toml |
| gopls | .go | go.mod |
| pyright | .py | pyproject.toml, requirements.txt |
| nixd | .nix | flake.nix, default.nix |
| lua-language-server | .lua | .luarc.json |
| bash-language-server | .sh, .bash, .zsh | .git |
| yaml-language-server | .yaml, .yml | .git |
| taplo | .toml | .git |
| marksman | .md | .git |
| clangd | .c, .cpp, .h | compile_commands.json, CMakeLists.txt |
| zls | .zig | build.zig |

## Commands

- `/lsp` — show detected servers and status
- `/lsp-restart` — restart all LSP servers

## How auto-diagnostics work

When the model uses `edit` or `write` on a file that has an active language server:

1. The new content is synced to the LSP server (`didOpen` or `didChange` with incrementing version)
2. The server is notified of the save (`didSave`, with `includeText` if the server requests it)
3. For new files (not yet opened by any server), a `workspace/didChangeWatchedFiles` Created notification is sent first, with a longer 6s timeout for re-indexing
4. Diagnostics are collected (up to 3s timeout for existing files, 6s for new files)
5. Any errors/warnings are appended to the tool result

The file watcher also handles changes made via bash (e.g., `rm`, `echo >`, `git checkout`). When a file is deleted, `didClose` is sent before the deletion notification so servers like tsserver drop their cached state.

The model sees something like:

```
Successfully edited src/main.ts

[LSP diagnostics (typescript-language-server): 1 error(s)]
src/main.ts:42:5 [error] (ts) [2345] Argument of type 'string' is not assignable to parameter of type 'number'
```

## Files

| File | Purpose |
|------|---------|
| watcher.ts | File system watcher (fs.watch recursive, git check-ignore filtering, debounce) |
| watcher.test.ts | Tests for file watcher |
| index.ts | Extension entry point, tool registration, tool_result hooks, file change routing, cold server gating |
| client.ts | JSON-RPC client over stdio, LSP protocol handling, server request handlers, progress tracking (10s request timeout) |
| servers.ts | Known server configs, auto-detection, dynamic tsserver memory scaling |
| linters.ts | CLI linter configs (biome, golangci-lint), detection, JSON output parsing |
| format.ts | Formatting utilities (diagnostics, locations, symbols, hover, workspace edit application) |
| format.test.ts | Tests for formatting |
| servers.test.ts | Tests for server configs, file matching, memory scaling |
| linters.test.ts | Tests for linter configs, biome/golangci-lint output parsing |

## Adding new servers

Add entries to `KNOWN_SERVERS` in `servers.ts`. Required fields:
- `command`: binary name
- `args`: CLI args (usually `["--stdio"]` or `[]`)
- `fileTypes`: file extensions this server handles
- `rootMarkers`: files that indicate this server is relevant

The server binary must be on PATH. Install via nix in `modules/home-manager/default.nix`.

## Adding new linters

Add entries to `KNOWN_LINTERS` in `linters.ts` and a runner function. See `runBiome` / `runGolangciLint` for examples. Linters use `child_process.execFile` (not `Bun.spawn` -- pi runs in Node, not Bun).

## Code actions

`codeAction` queries the server for available actions at a position (quick fixes, refactorings, source actions). The response includes context lines around the cursor so the model can verify it's the right spot. Actions are shown with their kind, title, and preferred/disabled status.

`codeActionApply` executes a code action by its index from a prior `codeAction` listing. It:
1. Re-queries available actions (ensures freshness)
2. Resolves deferred actions via `codeAction/resolve` if the server uses lazy evaluation
3. Applies the resulting `WorkspaceEdit` to disk via `applyWorkspaceEdit`

`applyWorkspaceEdit` (in `format.ts`) handles per-file `TextEdit[]` in reverse order to preserve character positions. Supports single-line edits, multi-line replacements, insertions, and deletions.

## Progress reporting

Servers send progress via `window/workDoneProgress/create` + `$/progress` notifications. The client tracks active progress tokens in a `Map` and exposes them via the `LspClient.progress` field. The extension:
- Shows active progress in the footer status bar (e.g., `lsp:rust-analyzer Building 45%`)
- Throttles status updates to 500ms to avoid flooding the TUI
- Expires stale entries after 30s (servers that sent `begin` but never `end`)
- Uses accent color for active progress, muted color for idle status

## Rename error recovery

When `lsp rename` fails (no renameable symbol at the given position), the error includes a few lines of context around the target line. This helps the model see where the symbol actually is and retry with the correct line number and `symbol` parameter.

## Known limitations

- **tsserver in large monorepos**: first access to each TS project reference is slow (5-30s warmup). Cold server gating handles this gracefully.
- **TanStack Router types**: `createFileRoute`, `useLocation`, `Route` involve expensive type-level route tree inference. Hover on these symbols may always timeout. Partially addressed upstream (TanStack/router#1091, PR #1202) but fundamentally expensive for large route trees.
- **yamlls on large files**: `symbols` times out on YAML files >400 lines. Diagnostics and hover work fine. Schema store is disabled to prevent network-blocking timeouts.
- **Files outside cwd**: the file watcher only covers cwd. Files in other directories (e.g., a Go project elsewhere on disk) get basic `didOpen`/`didChange`/`didSave` but no watcher-driven notifications. Cross-file references may fail because the server is rooted at cwd, not the target project's module directory.
- **Code actions**: command-only actions (no edit, just a command) are not applied — the model is told to run them manually. `documentChanges` (CreateFile/RenameFile/DeleteFile) are not yet supported — only `changes` (text edits within existing files).
