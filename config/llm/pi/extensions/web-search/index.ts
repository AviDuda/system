/**
 * Web Search Extension
 *
 * Registers `web_search` and `web_fetch` tools.
 *
 * web_search providers (edit ENABLED_PROVIDERS, tried in order):
 * - kagi: Fast (~1s), requires API access + key at /run/secrets/kagi_api_key
 * - claude: Slow (~13s), uses Claude Code CLI's WebSearch via `claude -p`. No extra keys.
 *
 * web_fetch: Fetches and extracts page content via agent-browser CLI (headless Chrome daemon).
 *
 * Commands: /search <query>, /fetch <url>, /fetch-headed
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { ClaudeSearchError, formatClaudeResults, searchViaClaude } from "./providers/claude-search";
import { formatResults, KagiApiError, search as kagiSearch, loadApiKey } from "./providers/kagi";
import { closeSession, FetchError, fetchPage, sessionName, truncateContent } from "./web-fetch";

// ── Provider config ──
// Edit this array to enable/disable providers. Tried in order; first available wins.
const ENABLED_PROVIDERS: ProviderId[] = [
  // "kagi",   // Uncomment when Kagi API access is granted
  "claude",
];

type ProviderId = "kagi" | "claude";

interface SearchResult {
  text: string;
  details: Record<string, unknown>;
}

export default function (pi: ExtensionAPI) {
  // Resolve active provider: first enabled one that's actually available
  let activeProvider: ProviderId | null = null;
  for (const id of ENABLED_PROVIDERS) {
    if (id === "kagi") {
      try {
        loadApiKey();
        activeProvider = id;
        break;
      } catch {
        continue;
      }
    }
    if (id === "claude") {
      activeProvider = id;
      break;
    }
  }

  async function doSearch(
    query: string,
    limit: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SearchResult> {
    if (activeProvider === "kagi") {
      try {
        const result = await kagiSearch(query, { limit, signal });
        return {
          text: formatResults(result),
          details: {
            provider: "kagi",
            resultCount: result.sources.length,
            requestId: result.requestId,
            hasRelated: result.relatedQuestions.length > 0,
          },
        };
      } catch (err) {
        // On auth failure, fall through to next provider
        if (err instanceof KagiApiError && (err.statusCode === 401 || err.statusCode === 403)) {
          const fallback = ENABLED_PROVIDERS.find((id) => id !== "kagi");
          if (fallback === "claude") {
            activeProvider = "claude";
            return doSearch(query, limit, signal);
          }
        }
        if (err instanceof KagiApiError) {
          return { text: `Search failed: ${err.message}`, details: { provider: "kagi", error: err.message } };
        }
        throw err;
      }
    }

    if (activeProvider === "claude") {
      try {
        const result = await searchViaClaude(query, { limit, signal });
        return {
          text: formatClaudeResults(result),
          details: { provider: "claude", resultCount: result.sources.length },
        };
      } catch (err) {
        if (err instanceof ClaudeSearchError) {
          return { text: `Search failed: ${err.message}`, details: { provider: "claude", error: err.message } };
        }
        throw err;
      }
    }

    return { text: "No search providers enabled.", details: { error: "no providers" } };
  }

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web. Returns titles, URLs, and snippets for each result.",
    promptSnippet:
      "web_search: Search the web. Parameters: query (string, required), limit (number, optional, default 10, max 40)",
    promptGuidelines: [
      "Use web_search when you need current information, documentation, or facts you're uncertain about.",
      "Prefer specific, focused queries over broad ones.",
      "When search results reference a page that likely has the answer, use web_fetch to read the full page.",
      "For complex browser interactions beyond simple page reading, use bash with agent-browser CLI directly (e.g., agent-browser open <url> && agent-browser snapshot -i).",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 40)" })),
    }),

    async execute(_toolCallId, params, signal) {
      const { text, details } = await doSearch(params.query, params.limit, signal);
      return { content: [{ type: "text", text }], details };
    },

    renderCall(args, theme) {
      const query = theme.fg("accent", theme.bold(`"${args.query}"`));
      const label = theme.fg("toolTitle", theme.bold("web_search "));
      const limit = args.limit ? theme.fg("muted", ` (limit: ${args.limit})`) : "";
      return new Text(`${label}${query}${limit}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { resultCount?: number; error?: string; provider?: string } | undefined;

      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const count = details?.resultCount ?? 0;
      const prov = details?.provider ?? "unknown";
      const summary = theme.fg("muted", `${count} result${count !== 1 ? "s" : ""} (${prov})`);

      if (!expanded) {
        return new Text(summary, 0, 0);
      }

      const text = result.content[0];
      const body = text?.type === "text" ? text.text : "";
      return new Text(`${summary}\n${theme.fg("dim", body)}`, 0, 0);
    },
  });

  // ── web_fetch tool ──

  let fetchHeaded = false;

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page and extract its text content. Uses a headless browser that handles JavaScript rendering and bot detection. Use after web_search to read a specific result page. For complex interactions (clicking, filling forms, screenshots), use bash with `agent-browser` CLI directly.",
    promptSnippet: "web_fetch: Fetch a web page and extract its text content. Parameters: url (string, required)",
    promptGuidelines: [
      "Use web_fetch to read pages found via web_search. It handles JS-rendered pages and bot detection.",
      "For interactive browser tasks (login, click, fill, screenshot), use `agent-browser` CLI via bash instead. The browser session is shared -- after web_fetch opens a page, you can run `agent-browser --session <session> snapshot -i` to inspect interactive elements, then click/fill/type as needed.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await fetchPage(params.url, {
          cwd: ctx.cwd,
          headed: fetchHeaded,
          signal: signal ?? undefined,
        });

        const { text, truncated } = truncateContent(result.content, 100_000);
        const titleLine = result.title ? `# ${result.title}\n\n` : "";
        const session = sessionName(ctx.cwd);
        const sessionNote = `\n\n[Browser session: ${session} -- use \`agent-browser --session ${session}\` for further interaction]`;

        return {
          content: [{ type: "text", text: `${titleLine}${text}${sessionNote}` }],
          details: { url: params.url, title: result.title, truncated, charCount: result.content.length, session },
        };
      } catch (err) {
        if (err instanceof FetchError) {
          return {
            content: [{ type: "text", text: `Fetch failed: ${err.message}` }],
            details: { url: params.url, error: err.message },
          };
        }
        throw err;
      }
    },

    renderCall(args, theme) {
      const url = theme.fg("accent", args.url);
      const label = theme.fg("toolTitle", theme.bold("web_fetch "));
      return new Text(`${label}${url}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as
        | { title?: string; charCount?: number; error?: string; truncated?: boolean }
        | undefined;

      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const title = details?.title || "(untitled)";
      const chars = details?.charCount ?? 0;
      const trunc = details?.truncated ? " (truncated)" : "";
      const summary = theme.fg("muted", `${title} \u2014 ${chars} chars${trunc}`);

      if (!expanded) {
        return new Text(summary, 0, 0);
      }

      const text = result.content[0];
      const body = text?.type === "text" ? text.text : "";
      const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;
      return new Text(`${summary}\n${theme.fg("dim", preview)}`, 0, 0);
    },
  });

  // ── Commands ──

  pi.registerCommand("fetch", {
    description: "Fetch a web page (usage: /fetch <url>)",
    handler: async (args, ctx) => {
      const url = args.trim();
      if (!url) {
        ctx.ui.notify("Usage: /fetch <url>", "warning");
        return;
      }
      ctx.ui.notify(`Fetching: ${url}`, "info");
      try {
        const result = await fetchPage(url, { cwd: ctx.cwd, headed: fetchHeaded });
        const { text } = truncateContent(result.content, 10_000);
        ctx.ui.notify(`${result.title}\n\n${text}`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Fetch failed: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("fetch-headed", {
    description: "Toggle headed (visible) browser mode for web_fetch",
    handler: async (_args, ctx) => {
      fetchHeaded = !fetchHeaded;
      ctx.ui.notify(`Browser mode: ${fetchHeaded ? "headed (visible)" : "headless"}`, "info");
    },
  });

  pi.registerCommand("search", {
    description: "Search the web (usage: /search <query>)",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /search <query>", "warning");
        return;
      }

      ctx.ui.notify(`Searching (${activeProvider}): ${query}`, "info");
      try {
        const { text } = await doSearch(query, 10, undefined);
        ctx.ui.notify(text, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Search failed: ${msg}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!activeProvider) {
      ctx.ui.notify("Web search: no providers available. Check ENABLED_PROVIDERS in web-search/index.ts.", "warning");
    } else if (activeProvider === "claude") {
      ctx.ui.notify("Web search: Claude Code fallback (~13s/query)", "info");
    } else {
      ctx.ui.setStatus("web-search", ctx.ui.theme.fg("muted", `search:${activeProvider}`));
    }
  });

  // Clean up browser session on shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    await closeSession(ctx.cwd);
  });
}
