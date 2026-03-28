# agents-loader

Loads `AGENTS.md`, `AGENTS.local.md`, `CLAUDE.md`, and `CLAUDE.local.md` from subdirectories when tools access files there. Mirrors Claude Code's auto-loading behavior.

## What it does

Pi natively loads `AGENTS.md` from cwd and parent directories at startup. This extension fills three gaps:

1. **`AGENTS.local.md` support** -- pi doesn't load these at all. Loaded from cwd and parent dirs at session start, injected on first prompt.

2. **Subdirectory loading on access** -- pi doesn't load `AGENTS.md` from subdirectories. Discovered when read/write/edit/ls/find/grep tools touch files in those directories.

3. **`@` mention loading** -- when user types `@path/to/dir` or `@path/to/file.ts` in their prompt, agents files for those directories are discovered and injected before the LLM sees the prompt.

## How it works

### Startup (session_start + before_agent_start)
- Walks cwd and parent directories for `.local.md` files only (pi handles `AGENTS.md` natively)
- Injects as a hidden message on first prompt

### @ mentions (input + before_agent_start)
- Parses `@path` and `@"quoted path"` references from user input
- Discovers agents files in the directory chain for each mention
- Injects as a hidden message alongside the prompt

### Tool access (tool_result)
- Fires on read, write, edit, ls, find, grep
- For file tools (read/write/edit): walks from file's parent dir up to cwd
- For directory tools (ls/find/grep): includes the directory itself in the chain
- Appends discovered content to tool result output

## Deduplication

All paths are resolved via `realpath` before tracking. This handles:
- `CLAUDE.md -> AGENTS.md` symlinks (loaded once, not twice)
- Same file discovered via different paths
- Already-loaded files from earlier in the session

## Supported filenames

- `AGENTS.md`
- `AGENTS.local.md`
- `CLAUDE.md`
- `CLAUDE.local.md`

At startup, only `.local.md` variants are loaded (pi handles the rest natively).
