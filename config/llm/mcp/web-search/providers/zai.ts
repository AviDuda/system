/**
 * z.ai Web Search client.
 *
 * Pure module — no host-specific imports. Host adapters resolve the API key
 * and pass it to `search()`. z.ai shares its API key with GLM model providers
 * (same platform key), so adapters typically resolve it from whatever the host
 * uses for z.ai/GLM credentials.
 *
 * Spec: https://docs.z.ai/api-reference/tools/web-search.md
 */

import type { SearchFilters, SearchHit, SearchProvider } from "./types";

const ZAI_SEARCH_URL = "https://api.z.ai/api/paas/v4/web_search";

// ── Types ──

export interface ZaiSearchResult {
  id: string;
  hits: SearchHit[];
}

export class ZaiApiError extends Error {
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "ZaiApiError";
    this.statusCode = statusCode;
  }
}

// ── Search ──

export async function search(
  query: string,
  options: { apiKey: string; limit?: number; signal?: AbortSignal; filters?: SearchFilters },
): Promise<ZaiSearchResult> {
  const apiKey = options.apiKey;
  const limit = options.limit !== undefined ? Math.min(Math.max(options.limit, 1), 50) : undefined;

  const response = await fetch(ZAI_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(buildRequestBody(query, limit, options.filters)),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = parseErrorDetail(body);
    throw new ZaiApiError(
      detail ? `z.ai API error (${response.status}): ${detail}` : `z.ai API error (${response.status})`,
      response.status,
    );
  }

  const payload = (await response.json()) as ZaiResponse;
  const hits: SearchHit[] = (payload.search_result ?? []).map((item) => ({
    title: item.title,
    url: item.link,
    snippet: item.content,
    publishedDate: item.publish_date ?? undefined,
  }));

  return { id: payload.id ?? "", hits };
}

// ── Adapter ──
//
// z.ai's key is host-specific (resolved from the host's z.ai/GLM credential
// store — e.g. pi resolves it from modelRegistry; an MCP host from env). So the
// adapter is a factory: the host supplies a key resolver (sync, throws when the
// key is absent) and gets back a SearchProvider. Resolve the key once up front
// (e.g. at session start) and have the resolver return the cached value.
export function createProvider(resolveKey: () => string): SearchProvider {
  return {
    name: "zai",
    isAvailable: () => {
      try {
        resolveKey();
        return true;
      } catch {
        return false;
      }
    },
    search: async (query, { limit, signal, filters }) => {
      const result = await search(query, { apiKey: resolveKey(), limit, signal, filters });
      return { hits: result.hits };
    },
  };
}

// ── Request body ──

/**
 * Build the request body, mapping normalized filters to z.ai params.
 *
 * - freshness → search_recency_filter (oneDay/oneWeek/oneMonth/oneYear)
 * - includeDomains → search_domain_filter (single string; z.ai exposes a
 *   whitelist, not an array — only the first domain is used)
 * - excludeDomains → NO-OP (z.ai has no exclude support)
 *
 * NOTE: the z.ai docs mark count / search_domain_filter / search_recency_filter
 * as "Supported search engines: search_pro_jina", while the only search_engine
 * enum value is "search-prime". These filters MAY silently no-op on
 * search-prime. We map them optimistically (an unsupported param is ignored by
 * the API). Verify live if filter behavior matters.
 */
export function buildRequestBody(
  query: string,
  limit: number | undefined,
  filters: SearchFilters | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    search_engine: "search-prime",
    search_query: query,
  };
  if (limit !== undefined) body.count = limit;

  if (filters?.freshness) {
    body.search_recency_filter = RECENCY_MAP[filters.freshness];
  }
  if (filters?.includeDomains?.length) {
    body.search_domain_filter = filters.includeDomains[0];
  }
  // excludeDomains: intentionally not mapped — z.ai has no exclude support.

  return body;
}

const RECENCY_MAP: Record<NonNullable<SearchFilters["freshness"]>, string> = {
  day: "oneDay",
  week: "oneWeek",
  month: "oneMonth",
  year: "oneYear",
};

// ── Internal types ──

interface ZaiResultItem {
  title: string;
  content?: string;
  link: string;
  media?: string;
  icon?: string;
  refer?: string;
  publish_date?: string;
}

interface ZaiResponse {
  id?: string;
  created?: number;
  search_result?: ZaiResultItem[];
}

function parseErrorDetail(body: string): string | null {
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON
  }
  return body.length > 200 ? `${body.slice(0, 200)}...` : body;
}
