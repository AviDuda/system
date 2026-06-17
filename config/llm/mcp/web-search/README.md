# web-search MCP server

A host-agnostic [MCP](https://modelcontextprotocol.io/) server exposing a single `web_search` tool. Pluggable providers (Kagi, Tavily, Claude; addable via one file). Returns text for the LLM and an MCP Apps iframe view for hosts that support it.

**This tree is canonical for the provider clients** — pi imports them from here by relative path, so search logic survives a host swap (the MCP server is the multi-host survivor; pi may go).

## Design

- **Tool**: `web_search(query, limit?, provider?, freshness?, includeDomains?, excludeDomains?, extractCount?)` — returns titles, URLs, snippets, published dates, and related questions. `freshness`/`includeDomains`/`excludeDomains` are normalized filters mapped per-provider; `extractCount` (Kagi only) fetches full page content for the top N results inline.
- **Providers**: client + adapter live together in `providers/<name>.ts`. Host-neutral adapters (Kagi) are ready to register; host-specific ones (z.ai, whose key is host-resolved) export a `createProvider(resolveKey)` factory. The `PROVIDERS` array in `providers.ts` lists which to enable. First `isAvailable()` wins unless the caller forces one via `provider` or `WEB_SEARCH_PROVIDERS` reorders/filters.
- **Canonical clients**: `providers/{kagi,zai,types,format}.ts` are pure (no host imports) and imported by pi too — single source of truth across hosts.
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
| `TAVILY_API_KEY` | Tavily API key (literal value). |
| `TAVILY_API_KEY_FILE` | Path to file containing Tavily API key. |

Key resolution for Kagi: `KAGI_API_KEY` > `KAGI_API_KEY_FILE` > `/run/secrets/kagi_api_key` (sops-nix default on this system). z.ai is resolved host-side (pi resolves it from its z.ai/GLM credential store); set `ZAI_API_KEY` here to enable it for this server.

## Adding a provider

1. Create `providers/<name>.ts`: a pure client (`search(query, {apiKey, ...})`) plus either a ready `SearchProvider` adapter (if the key is host-neutral) or a `createProvider(resolveKey)` factory (if the key is host-resolved).
2. If host-neutral, import and add to `PROVIDERS` in `providers.ts`. If host-specific, wire its key resolver there.
3. Describe its env/secret handling in the `## Environment` table above.

Providers return a normalized `{ hits, relatedQuestions?, extracted? }` shape. The server handles formatting and MCP wire protocol.

## Host support matrix

| Host | Base MCP | MCP Apps iframe |
|---|---|---|
| Claude Code | ✅ | ✅ |
| OpenCode | ✅ | ❌ (text fallback, silently ignored) |
| pi | ❌ (no MCP support by design) | ❌ |

Pi uses its own in-tree web-search extension (`config/llm/pi/extensions/web-search/`), not this server.

## Files

| Path | Purpose |
|---|---|
| `index.ts` | MCP server entry. Tool + resource registration. |
| `providers.ts` | Re-export shim (registry lives in providers/registry.ts). |
| `providers/registry.ts` | `PROVIDERS` list, `resolveProvider`, `availableProviders`, `formatOutcome`. |
| `providers/types.ts` | `SearchFilters`, `SearchHit`, `SearchProvider` (shared contract). |
| `providers/format.ts` | `formatHits` — the single result formatter (shared). |
| `providers/key.ts` | `loadKey` — shared env>file>sops key resolution for host-neutral providers. |
| `providers/{kagi,tavily,claude,zai}.ts` | Provider clients + adapters. |
| `providers/*.test.ts` | Tests for formatting + request-body mapping. |
| `mcp-app.html` | Self-contained iframe UI. Hand-written JSON-RPC over `postMessage` — no bundler. |
| `package.json` | `@modelcontextprotocol/sdk` + `@modelcontextprotocol/ext-apps` + `bun-types`. |
