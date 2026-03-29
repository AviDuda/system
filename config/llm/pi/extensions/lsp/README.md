# LSP Extension

Language Server Protocol integration for pi. Gives the agent IDE-like code intelligence: type checking, go-to-definition, hover info, find references, symbol navigation, and lint feedback.

## What it does

1. **`lsp` tool** — the LLM can call this directly for diagnostics, definition, hover, references, symbols, rename
2. **Auto-diagnostics** — after every edit/write, LSP diagnostics + linter results are appended to the tool result so the model sees type errors and lint issues immediately
3. **Auto-detection** — discovers available language servers and CLI linters from project markers + PATH
4. **Cold server gating** — if a server times out on auto-diagnostics, it's marked cold and skipped for 5s to avoid blocking edits. Linters always run (they're fast CLI calls).

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

1. The new content is synced to the LSP server
2. The server is notified of the save
3. Diagnostics are collected (up to 3s timeout)
4. Any errors/warnings are appended to the tool result

The model sees something like:

```
Successfully edited src/main.ts

[LSP diagnostics (typescript-language-server): 1 error(s)]
src/main.ts:42:5 [error] (ts) [2345] Argument of type 'string' is not assignable to parameter of type 'number'
```

## Files

| File | Purpose |
|------|---------|
| index.ts | Extension entry point, tool registration, tool_result hooks, cold server gating |
| client.ts | JSON-RPC client over stdio, LSP protocol handling (10s request timeout) |
| servers.ts | Known server configs, auto-detection, dynamic tsserver memory scaling |
| linters.ts | CLI linter configs (biome, golangci-lint), detection, JSON output parsing |
| format.ts | Formatting utilities (diagnostics, locations, symbols, hover) |
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

## Rename error recovery

When `lsp rename` fails (no renameable symbol at the given position), the error includes a few lines of context around the target line. This helps the model see where the symbol actually is and retry with the correct line number and `symbol` parameter.

## Known limitations

- **tsserver in large monorepos**: first access to each TS project reference is slow (5-30s warmup). Cold server gating handles this gracefully.
- **TanStack Router types**: `createFileRoute`, `useLocation`, `Route` involve expensive type-level route tree inference. Hover on these symbols may always timeout. Partially addressed upstream (TanStack/router#1091, PR #1202) but fundamentally expensive for large route trees.
- **yamlls on large files**: `symbols` times out on YAML files >400 lines. Diagnostics and hover work fine. Schema store is disabled to prevent network-blocking timeouts.
