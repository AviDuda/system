# LSP Extension

Language Server Protocol integration for pi. Gives the agent IDE-like code intelligence: type checking, go-to-definition, hover info, find references, symbol navigation, and lint feedback.

## What it does

1. **`lsp` tool** — the LLM can call this directly for type-checking and navigation: diagnostics, go-to-definition, hover, find references, symbols, workspace symbol search, rename, code actions, and restart (the tool's action enum has the full set, including `type_definition`, `implementation`, `workspace_symbol`, `restart`, and `status`)
2. **Auto-diagnostics** — after every edit/write, LSP diagnostics + linter results are appended to the tool result so the model sees type errors and lint issues immediately
3. **Auto-detection** — discovers available language servers and CLI linters from project markers + PATH
4. **Multi-root support** — automatically roots LSP servers at the correct project root for files outside the session cwd (e.g., rust-analyzer rooted at the Cargo.toml ancestor, not the session dir). Clients are keyed by `serverName::rootPath` so multiple instances of the same server type can coexist.
5. **Workspace symbol search** — `workspace_symbol` action searches across all active LSP servers by symbol name, returning matches from the entire project (not just one file)
6. **File watcher** — watches cwd recursively, sends `workspace/didChangeWatchedFiles` to servers when files are created, changed, or deleted (including via bash). Respects `.gitignore` via `git check-ignore`, with hardcoded fallbacks for non-git directories.
7. **Server request handling** — responds to `client/registerCapability` (stores watcher glob patterns), `client/unregisterCapability`, and `workspace/configuration`
8. **Cold server gating** — if a server times out on auto-diagnostics or a `symbols` call, it's marked cold and skipped for 5s to avoid blocking edits. Linters always run (they're fast CLI calls).
9. **Code actions** — `codeAction` lists available refactorings/fixes at a position, `codeActionApply` executes one by its index. Supports `codeAction/resolve` for deferred edits.
10. **Progress reporting** — tracks `window/workDoneProgress` from servers and shows progress (title, percentage) in the footer status bar. Stale progress entries are expired after 30s.

## Supported servers

Auto-detects common language servers from project markers (TypeScript, Rust, Go, Python, Nix, Swift, Lua, Bash, YAML, TOML, Markdown, C/C++, Zig, and more). The server binary must be on PATH. The full list with file types and root markers lives in `servers.ts` (`KNOWN_SERVERS`).

## Commands

- `/lsp` — show detected servers and status
- `/lsp-restart` — restart all LSP servers (user command)

The agent can also restart servers via `lsp(action="restart")` (all servers) or `lsp(action="restart", file="...")` (server for a specific file's project).

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

## Symbols

The `symbols` action renders `textDocument/documentSymbol` as a compact skeleton — top-level declarations with line ranges, so the agent can `read` with `offset`/`limit` for just the symbol it needs instead of the whole file.

**Container/body filter.** `documentSymbol` returns a scope tree; tsserver includes every local `const` and `.map()` callback inside function bodies, swamping the signal. `formatDocumentSymbol` only recurses into containers (Module, Class, Struct, Interface, Enum, Namespace, Object, Package) — body kinds (Function, Method, Property, Field, Constant, Variable) render as leaves. This is the scope-tree → declaration-tree conversion. Language-agnostic by design: the container/body axis holds across servers even when their SymbolKind sets differ, and it only ever drops body-locals, never declarations. (A no-op for Rust since rust-analyzer emits no body locals; for TS it collapses ~350 lines of scope-tree noise to ~50.)

**Line ranges.** Every symbol carries its full-extent range (`sym.range`, covering doc comments and decorators, not just the name span): `@ line 42` single-line, `@ lines 243-802` multi-line. LSP's `range.end` is exclusive — a closing brace at a line boundary (character 0) is handled so ranges are read-ready (`read file.ts offset=243 limit=560`). When the server populates `sym.detail` (rust-analyzer always does — real signatures), it's appended after the range.

**Cold-server graceful handling.** The first `symbols` call on an unanalyzed file (common right after session start, before edits warm the server) hits the 10s timeout. Instead of surfacing a raw error that looks like a bug, the action marks the server cold (same `coldServers` map auto-diagnostics uses) and returns a message telling the agent to retry immediately or fall back to `read` — not "retry in N seconds", which agents have no concept of and would translate to a blind `sleep`. A successful symbols call clears the cold mark.

Example output (TS, after filter):

```
[?] rpc.ts (implicit module) (Module) @ lines 1-802
  [c] SUBAGENT_SESSION_DIR (Constant) @ line 18
  [I] UsageStats (Interface) @ lines 42-50
    [p] input (Property) @ line 43
  [F] runSingleAgent (Function) @ lines 243-802
  [F] writeRpcCommand (Function) @ lines 237-241
```

**Agent steering.** A `promptGuideline` directs the agent to call `lsp symbols` before `read` on capable-server languages (e.g. Rust, TS/JS, C#, Go), explicitly excluding weak servers (e.g. nixd, bash-language-server). Scoped deliberately — over-steering backfires, and the filter can't save a server whose `documentSymbol` shape is fundamentally wrong (nixd emits every leaf value as a symbol).

## Workspace Symbol Search

The `workspace_symbol` action searches for symbols across the entire project by name. Unlike `symbols` (which lists all symbols in one file), `workspace_symbol` queries all active LSP servers.

**Parameters:**
- `action: "workspace_symbol"` — the action to perform
- `query: string` — symbol name query (matching behavior is server-dependent: some do substring, some prefix, some fuzzy)

**Behavior:**
- Broadcasts `workspace/symbol` to all active LSP clients (across all roots)
- Results are sorted alphabetically by symbol name
- Each result shows the symbol kind, container name, and file location
- Returns up to the server's limit (typically 50-200 results)

**When to use:** Finding a function/type/class when you know the name but not the file. More precise than `rg` for symbols (respects scoping, includes types/interfaces, handles overloads).

**Example:** `lsp(action="workspace_symbol", query="handleInput")` — finds all symbols matching "handleInput" across the project.

## Multi-root Support

When working on files outside the session cwd, the extension automatically roots LSP servers at the correct project root.

**How it works:**
1. For each file, `findProjectRoot` walks up from the file's directory looking for root markers (Cargo.toml, package.json, go.mod, etc.)
2. If a server is already running for that root, it's reused
3. Otherwise, a new server instance is spawned rooted at the project root
4. Clients are keyed by `serverName::rootPath` so multiple instances of the same server type can coexist (e.g., one rust-analyzer for `~/dev/project-a/` and another for `~/dev/project-b/`)

**Example scenario:** Session cwd is `~/config/` (Nix config). Agent opens `~/projects/myapp/src/lib.rs` — rust-analyzer starts rooted at `~/projects/myapp/`, not `~/config/`. All LSP features work correctly (diagnostics, go-to-definition, symbols, etc.).

**Status display:** The `/lsp` command shows both session-cwd servers and dynamically-started servers from other roots.

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
| client.test.ts | Tests for project root detection |

## Per-project LSP settings (`.lsp/` directory)

Projects can override server `initializationOptions` via a `.lsp/<server-name>.json` file in the project root. Settings are deep-merged with server defaults from `KNOWN_SERVERS` (project settings take priority).

### Example

```json
// .lsp/rust-analyzer.json
{
  "_comment": "Dioxus RSX proc macros generate untypeable code (TemplateNode/TemplateAttribute mismatches). rustc compiles clean, rust-analyzer does not.",
  "procMacro": {
    "ignored": {
      "dioxus-core-macro": ["rsx", "component"]
    }
  }
}
```

### Reserved fields

- `_comment` — string or array of strings (inline documentation, stripped before sending to server)
- `_meta` — arbitrary object (reserved for future use, stripped before sending)

Both are stripped recursively at all nesting levels.

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

`applyWorkspaceEdit` (in `format.ts`) handles per-file `TextEdit[]` in reverse order to preserve character positions. Supports single-line edits, multi-line replacements, insertions, and deletions. Requires an `onFileWritten` callback that's invoked after each file is written — used to sync modified content back to the LSP server via `didChange` so subsequent edits (e.g., round-trip renames) don't operate on stale positions.

## Progress reporting

Servers send progress via `window/workDoneProgress/create` + `$/progress` notifications. The client tracks active progress tokens in a `Map` and exposes them via the `LspClient.progress` field. The extension:
- Shows active progress in the footer status bar (e.g., `lsp:rust-analyzer Building 45%`)
- Throttles status updates to 500ms to avoid flooding the TUI
- Expires stale entries after 30s (servers that sent `begin` but never `end`)
- Uses accent color for active progress, muted color for idle status

## Failure context

When an LSP action returns no results (no definition found, no hover info, no references, etc.), the response includes:
- **Position info**: the resolved position with resolution method (e.g., `(symbol "foo" at 42:15 via semantic)` or `(symbol "foo" not found at line 5)`)
- **Context lines**: 2 lines around the target line so the model can see what's actually there and retry with the correct parameters

For `rename` failures, 3 lines of context are shown. For `codeAction`, 5 lines.

## Position resolution

When the agent provides a `symbol` parameter, the extension resolves the exact cursor position using two strategies:

1. **Semantic** (when `line` is NOT specified): fetches `textDocument/documentSymbol` and searches the symbol tree by name. Uses `selectionRange` — the precise name span at the declaration site. Most reliable for "find where X is defined."
2. **Textual** (when `line` IS specified): word-boundary regex match on the given line. Finds the symbol at the usage site, not the declaration. Required for `references`, `hover`, `type_definition` at a specific usage.

When `line` is omitted, semantic resolution is used (finds the declaration). When `line` is provided, textual resolution is used (finds the usage at that line). The `source` field in position info (`via semantic` / `via textual`) tells the agent which path was used.

Word-boundary matching (`\b`) prevents false matches where a symbol name appears inside another identifier (e.g., `get` won't match `getApiKey`).

## Tool call rendering

The collapsed tool call display shows the action, file, line, symbol, and rename target:
- `lsp definition index.ts:46 readLocationContext`
- `lsp rename index.ts:42 oldName → newName`
- `lsp codeAction index.ts:42 [3]`
- `lsp workspace_symbol "handleInput"`
- `lsp restart index.ts`

## Known limitations

- **tsserver in large monorepos**: first access to each TS project reference is slow (5-30s warmup). Cold server gating handles this gracefully.
- **TanStack Router types**: `createFileRoute`, `useLocation`, `Route` involve expensive type-level route tree inference. Hover on these symbols may always timeout. Partially addressed upstream (TanStack/router#1091, PR #1202) but fundamentally expensive for large route trees.
- **yamlls on large files**: `symbols` times out on YAML files >400 lines (now surfaces the graceful 'still indexing' message rather than a raw error). Diagnostics and hover work fine. Schema store is disabled to prevent network-blocking timeouts.
- **Files outside cwd**: the file watcher only covers cwd. Files in other directories get server-side watching via the LSP server's own watchers (registered via `client/registerCapability`), but bash-side file changes (e.g., `rm`, `echo >`) in external projects won't trigger notifications. Cross-file references within external projects work correctly via multi-root support — the server is rooted at the project's Cargo.toml/package.json/go.mod ancestor, not the session cwd.
- **Code actions**: command-only actions (no edit, just a command) are not applied — the model is told to run them manually. `documentChanges` (CreateFile/RenameFile/DeleteFile) are not yet supported — only `changes` (text edits within existing files).
