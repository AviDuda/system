# web-search MCP server

A host-agnostic [MCP](https://modelcontextprotocol.io/) server exposing a single `web_search` tool. Pluggable providers (Kagi today; Brave/Exa/etc. trivially addable). Returns text for the LLM and an MCP Apps iframe view for hosts that support it.

## Design

- **Tool**: `web_search(query, limit?, provider?)` — returns titles, URLs, snippets, published dates, and related questions.
- **Providers**: one file in `providers/`, one entry in the `PROVIDERS` array in `providers.ts`. Order matters — first `isAvailable()` wins unless the caller forces one via the `provider` arg or the `WEB_SEARCH_PROVIDERS` env var reorders/filters the list.
- **Dep reuse**: the Kagi client code lives in pi's tree (`config/llm/pi/extensions/web-search/providers/kagi.ts`) and is imported by relative path — single source of truth across pi and this MCP server.
- **MCP Apps**: returns `_meta.ui.resourceUri` + `structuredContent`. Supporting hosts render `mcp-app.html` in a sandboxed iframe (result cards). Non-supporting hosts see the text content and work fine.

## Run

The server is registered globally via `modules/llm-mcp.nix` (consumed by Claude Code's `managed-mcp.json` and OpenCode's `mcp` field). Nix flake handles wiring — nothing to invoke manually.

For ad-hoc manual run / smoke test:

```bash
cd config/llm/mcp/web-search
bun install   # first time only
bun index.ts  # speaks stdio JSON-RPC
```

## Environment

| Var | Purpose |
|---|---|
| `WEB_SEARCH_PROVIDERS` | Comma-separated ordered provider list (filters + orders). Default: full registry order. |
| `KAGI_API_KEY` | Kagi API key (literal value). |
| `KAGI_API_KEY_FILE` | Path to file containing Kagi API key. |

Key resolution for Kagi: `KAGI_API_KEY` > `KAGI_API_KEY_FILE` > `/run/secrets/kagi_api_key` (sops-nix default on this system).

## Adding a provider

1. Create `providers/<name>.ts` exporting a `SearchProvider` object (see `providers/kagi.ts` for the shape).
2. Import it and add to `PROVIDERS` in `providers.ts`.
3. Describe its env/secret handling in the `## Environment` table above.

Providers return a normalized `{ hits, relatedQuestions? }` shape. The server handles formatting and MCP wire protocol.

## Host support matrix

| Host | Base MCP | MCP Apps iframe |
|---|---|---|
| Claude Code | ✅ | ✅ |
| OpenCode | ✅ | ❌ (text fallback, silently ignored) |
| pi (`@mariozechner/pi-coding-agent`) | ❌ (no MCP support by design) | ❌ |

Pi uses its own in-tree web-search extension (`config/llm/pi/extensions/web-search/`), not this server.

## Files

| Path | Purpose |
|---|---|
| `index.ts` | MCP server entry. Tool + resource registration. |
| `providers.ts` | `SearchProvider` interface, registry, result formatter. |
| `providers/kagi.ts` | Kagi adapter (thin wrapper around pi's client). |
| `mcp-app.html` | Self-contained iframe UI. Hand-written JSON-RPC over `postMessage` — no bundler. |
| `package.json` | `@modelcontextprotocol/sdk` + `@modelcontextprotocol/ext-apps` + `bun-types`. |
