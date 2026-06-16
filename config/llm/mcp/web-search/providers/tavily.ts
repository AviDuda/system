/**
 * Tavily Search client.
 *
 * Pure module — no host-specific imports. Host adapters resolve the API key
 * and pass it to `search()`. `loadApiKey()` is a host-neutral convenience
 * (env + sops path) that adapters may call.
 *
 * Spec: https://docs.tavily.com/documentation/api-reference/endpoint/search
 */

import { loadKey } from "./key";
import type { SearchFilters, SearchHit, SearchProvider } from "./types";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

// ── Types ──

export interface TavilySearchResult {
  requestId: string;
  hits: SearchHit[];
}

export class TavilyApiError extends Error {
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "TavilyApiError";
    this.statusCode = statusCode;
  }
}

// ── API key ──
// Host-neutral resolution (env > file > sops path) shared via loadKey.

const DEFAULT_SECRET_PATH = "/run/secrets/tavily_api_key";

export function loadApiKey(): string {
  return loadKey({
    envVar: "TAVILY_API_KEY",
    fileEnvVar: "TAVILY_API_KEY_FILE",
    defaultPath: DEFAULT_SECRET_PATH,
    label: "Tavily API key",
  });
}

// ── Search ──

export async function search(
  query: string,
  options: { apiKey: string; limit?: number; signal?: AbortSignal; filters?: SearchFilters },
): Promise<TavilySearchResult> {
  const apiKey = options.apiKey;
  // Tavily caps max_results at 20.
  const maxResults = options.limit !== undefined ? Math.min(Math.max(options.limit, 1), 20) : undefined;

  const response = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(buildRequestBody(query, maxResults, options.filters)),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = parseErrorDetail(body);
    throw new TavilyApiError(
      detail ? `Tavily API error (${response.status}): ${detail}` : `Tavily API error (${response.status})`,
      response.status,
    );
  }

  const payload = (await response.json()) as TavilyResponse;
  const hits: SearchHit[] = (payload.results ?? []).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.content,
  }));

  return { requestId: payload.request_id ?? "", hits };
}

// ── Request body ──

// ── Quality defaults ──
//
// Agent-grade config per Tavily's own setup guide
// (https://docs.tavily.com/agents.md): search_depth="advanced" +
// chunks_per_source=3 yields the highest-relevance, chunk-reranked results —
// the quality config that's most competitive on technical/niche queries.
// advanced costs 2 credits/search vs basic's 1, but this is a fallback path
// (rare), so quality matters more than the doubled per-call cost.
// chunks_per_source requires advanced depth; they're set together.
const DEFAULT_SEARCH_DEPTH = "advanced";
const DEFAULT_CHUNKS_PER_SOURCE = 3;
const DEFAULT_MAX_RESULTS = 10;

/**
 * Build the request body, mapping normalized filters to Tavily params.
 *
 * Normalized filters map cleanly:
 * - freshness → time_range (day/week/month/year, native enum)
 * - includeDomains → include_domains (native array, up to 300)
 * - excludeDomains → exclude_domains (native array, up to 150)
 *
 * No extractCount equivalent: Tavily's `include_raw_content` returns full
 * page content for ALL results (not top-N) and bloats the response — the
 * dedicated /extract endpoint is the real analog (future fetch-chain).
 */
export function buildRequestBody(
  query: string,
  maxResults: number | undefined,
  filters: SearchFilters | undefined,
): Record<string, unknown> {
  // Tavily caps max_results at 20; default to 10 when unspecified (matches the
  // tool's documented default, consistent with other providers).
  const limit = maxResults !== undefined ? Math.min(Math.max(maxResults, 1), 20) : DEFAULT_MAX_RESULTS;

  const body: Record<string, unknown> = {
    query,
    search_depth: DEFAULT_SEARCH_DEPTH,
    chunks_per_source: DEFAULT_CHUNKS_PER_SOURCE,
    max_results: limit,
  };

  if (filters?.freshness) body.time_range = filters.freshness;
  if (filters?.includeDomains?.length) body.include_domains = filters.includeDomains;
  if (filters?.excludeDomains?.length) body.exclude_domains = filters.excludeDomains;

  return body;
}

// ── Internal types ──

interface TavilyResultItem {
  title: string;
  url: string;
  content?: string;
  score?: number;
  raw_content?: string | null;
}

interface TavilyResponse {
  query?: string;
  answer?: string;
  results?: TavilyResultItem[];
  response_time?: number;
  request_id?: string;
}

function parseErrorDetail(body: string): string | null {
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.detail === "string") return parsed.detail;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON
  }
  return body.length > 200 ? `${body.slice(0, 200)}...` : body;
}

// ── Adapter ──
//
// Tavily's key is host-neutral (env + sops path), so the adapter is fully
// self-contained here and shared by every host.
export const tavilyProvider: SearchProvider = {
  name: "tavily",
  label: "Tavily",
  isAvailable: () => {
    try {
      loadApiKey();
      return true;
    } catch {
      return false;
    }
  },
  search: async (query, { limit, signal, filters }) => {
    const result = await search(query, { apiKey: loadApiKey(), limit, signal, filters });
    return { hits: result.hits };
  },
};
