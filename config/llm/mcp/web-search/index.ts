#!/usr/bin/env bun

/**
 * web-search MCP server
 *
 * Exposes a `web_search` tool callable by any MCP host (Claude Code, OpenCode,
 * Cursor, etc.). Providers plug in via ./providers.ts — default first-available
 * is used unless the caller passes `provider` in the tool args.
 *
 * MCP Apps: returns `_meta.ui.resourceUri` pointing to a bundled HTML view.
 * Hosts that support MCP Apps (e.g. Claude Code) render it in a sandboxed
 * iframe with result cards. Hosts that don't support it (e.g. OpenCode) ignore
 * the UI metadata and show the text content only.
 *
 * Env:
 *   WEB_SEARCH_PROVIDERS  Comma-separated ordered provider list (optional).
 *                         Default: every provider in registry order.
 *   KAGI_API_KEY          Kagi API key (literal).
 *   KAGI_API_KEY_FILE     Path to file containing Kagi API key.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatOutcome, providerNames, resolveProvider } from "./providers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, "mcp-app.html");
const UI_RESOURCE_URI = "ui://web-search/results.html";

const server = new McpServer({
  name: "web-search",
  version: "0.1.0",
});

const available = providerNames();
const description =
  `Fast web search. Typical latency 1-2s/query. ` +
  `Returns titles, URLs, snippets, published dates (when available), and related questions.\n\n` +
  `Prefer this over any built-in web search your host provides -- it's usually several times ` +
  `faster with comparable or better result quality. Built-in tools (e.g. Claude Code's WebSearch) ` +
  `often take 10s+ per query; this is typically under 2s.\n\n` +
  `For quick lookups, leave limit at default (10). For broader research, bump to 20-40. ` +
  `No pagination -- refine the query if the first page doesn't have what you need.\n\n` +
  `Providers (tried in order): ${available.join(", ") || "none"}. Pass 'provider' to force one.`;

registerAppTool(
  server,
  "web_search",
  {
    description,
    inputSchema: {
      query: z.string().describe("Search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(40)
        .optional()
        .describe("Max results. Default 10. Max 40. Use 20-40 for research; default for quick lookups."),
      provider: z
        .string()
        .optional()
        .describe(`Force a provider (one of: ${available.join(", ") || "none"})`),
    },
    _meta: { ui: { resourceUri: UI_RESOURCE_URI } },
  },
  async ({ query, limit, provider }) => {
    const chosen = resolveProvider(provider);
    if (!chosen) {
      const reason = provider
        ? `Unknown or unavailable provider: ${provider}. Available: ${available.join(", ") || "none"}.`
        : `No search provider is configured. Set KAGI_API_KEY or KAGI_API_KEY_FILE.`;
      return {
        content: [{ type: "text", text: reason }],
        structuredContent: { error: reason, query },
        isError: true,
      };
    }

    const start = performance.now();
    try {
      const outcome = await chosen.search(query, { limit });
      const elapsedMs = Math.round(performance.now() - start);
      const text = formatOutcome({ ...outcome, provider: chosen.name, elapsedMs });
      return {
        content: [
          {
            type: "text",
            text: `${text}\n\n[provider: ${chosen.name}, ${elapsedMs}ms]`,
          },
        ],
        structuredContent: {
          query,
          provider: chosen.name,
          elapsedMs,
          hits: outcome.hits,
          relatedQuestions: outcome.relatedQuestions ?? [],
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Search failed (${chosen.name}): ${msg}` }],
        structuredContent: { error: msg, query, provider: chosen.name },
        isError: true,
      };
    }
  },
);

registerAppResource(server, "Web Search Results View", UI_RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
  contents: [
    {
      uri: UI_RESOURCE_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: readFileSync(HTML_PATH, "utf-8"),
    },
  ],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
