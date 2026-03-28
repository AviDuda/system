# web-search

Web search and page fetching tools.

## Tools

### web_search

Search the web. Returns titles, URLs, and snippets.

Edit `ENABLED_PROVIDERS` in `index.ts` to configure. Tried in order; first available wins.

Parameters: `query` (required), `limit` (optional, default 10, max 40), `provider` (optional: `'kagi'` or `'claude'`).

Results include timing info (elapsed seconds).

| Provider | Speed | Auth | Notes |
|----------|-------|------|-------|
| `kagi` | ~1-2s | `/run/secrets/kagi_api_key` (sops-nix) | $0.025/search, prepaid balance |
| `claude` | ~13-20s | Existing Anthropic auth | Shells out to `claude -p` with WebSearch tool |

Currently enabled: **kagi** (primary), **claude** (fallback). Kagi auto-falls back to Claude on 401/403.

### web_fetch

Fetch a web page and extract its text content. Uses `agent-browser` CLI (headless Chrome daemon) which handles JavaScript rendering and bot detection.

After `web_fetch` opens a page, the browser session persists. The LLM can use `agent-browser` directly via bash for complex interactions:

```bash
# Inspect interactive elements on the page web_fetch just opened
agent-browser --session pi-fetch-<project> snapshot -i

# Click, fill, screenshot, etc.
agent-browser --session pi-fetch-<project> click @e3
agent-browser --session pi-fetch-<project> screenshot page.png
```

Session name is `pi-fetch-<project-basename>`, isolated per project.

## Commands

| Command | Description |
|---------|-------------|
| `/search [kagi\|claude] <query>` | Search the web (results injected into conversation via sendUserMessage) |
| `/fetch <url>` | Fetch a page (content injected into conversation via sendUserMessage) |
| `/fetch-headed` | Toggle visible browser mode (for debugging bot detection) |

## Architecture

- `kagi.ts` -- Kagi API client. No pi imports.
- `kagi.test.ts` -- Tests for result formatting.
- `claude-search.ts` -- Claude Code CLI wrapper.
- `claude-search.test.ts` -- Tests for link parsing and formatting.
- `web-fetch.ts` -- agent-browser CLI wrapper. Session management, content extraction.
- `web-fetch.test.ts` -- Tests for session naming, ANSI stripping, truncation.
- `index.ts` -- Pi extension. Provider resolution, tool + command registration.

## Sandbox compatibility

Both search providers and web_fetch make network requests from the extension's Node process (or child CLI processes), not via the LLM's bash tool. A future sandbox would not affect them. The Kagi secret at `/run/secrets/` would also be invisible to sandboxed bash.

Note: if the LLM uses `agent-browser` directly via bash, those calls *would* go through the sandbox. The `agent-browser` binary and `kagi.com` / other domains would need to be in the sandbox allowlist.
