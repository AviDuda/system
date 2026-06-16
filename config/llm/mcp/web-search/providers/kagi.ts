/**
 * Kagi Search API v1 client.
 *
 * Pure module — no host-specific imports. Host adapters resolve the API key
 * and pass it to `search()`. `loadApiKey()` is a host-neutral convenience
 * (env + sops path) that adapters may call.
 *
 * Spec: https://kagi.com/api/docs/openapi.md
 */

import { loadKey } from "./key";
import type { SearchFilters, SearchHit, SearchProvider } from "./types";

const KAGI_SEARCH_URL = "https://kagi.com/api/v1/search";

// ── Types ──

export interface KagiSearchResult {
  trace: string;
  hits: SearchHit[];
  relatedQuestions: string[];
}

export class KagiApiError extends Error {
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "KagiApiError";
    this.statusCode = statusCode;
  }
}

// ── API key ──
// Host-neutral resolution (env > file > sops path) shared via loadKey.

const DEFAULT_SECRET_PATH = "/run/secrets/kagi_api_key";

export function loadApiKey(): string {
  return loadKey({
    envVar: "KAGI_API_KEY",
    fileEnvVar: "KAGI_API_KEY_FILE",
    defaultPath: DEFAULT_SECRET_PATH,
    label: "Kagi API key",
  });
}

// ── Search ──

export async function search(
  query: string,
  options: { apiKey: string; limit?: number; signal?: AbortSignal; filters?: SearchFilters; extractCount?: number },
): Promise<KagiSearchResult> {
  const apiKey = options.apiKey;
  // API permits up to 1024, but a tool result rarely benefits from more than 40.
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 40);

  const response = await fetch(KAGI_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(buildRequestBody(query, limit, options.filters, options.extractCount)),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = parseErrorDetail(body);
    throw new KagiApiError(
      detail ? `Kagi API error (${response.status}): ${detail}` : `Kagi API error (${response.status})`,
      response.status,
    );
  }

  const payload = (await response.json()) as KagiResponse;

  // v1 returns errors with an HTTP 4xx status; defensive check on a 2xx body.
  if (payload.error && payload.error.length > 0) {
    const first = payload.error[0];
    throw new KagiApiError(
      first.message ? `Kagi API error: ${first.message}` : `Kagi API error (${first.code ?? "unknown"})`,
    );
  }

  // Web results live under data.search[]; related questions under
  // data.adjacent_question[] (question text on props.question).
  const hits: SearchHit[] = (payload.data?.search ?? []).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    publishedDate: item.time ?? undefined,
  }));

  const relatedQuestions: string[] = (payload.data?.adjacent_question ?? [])
    .map((item) => item.props?.question)
    .filter((q): q is string => typeof q === "string");

  return { trace: payload.meta?.trace ?? "", hits, relatedQuestions };
}

// ── Adapter ──
//
// Kagi's key is host-neutral (env + sops path), so the adapter is fully
// self-contained here and shared by every host. Defined with its client so the
// provider is described in one place; the host registry just lists it.
export const kagiProvider: SearchProvider = {
  name: "kagi",
  label: "Kagi",
  isAvailable: () => {
    try {
      loadApiKey();
      return true;
    } catch {
      return false;
    }
  },
  search: async (query, { limit, signal, filters, extractCount }) => {
    const result = await search(query, { apiKey: loadApiKey(), limit, signal, filters, extractCount });
    return {
      hits: result.hits,
      relatedQuestions: result.relatedQuestions,
      extracted: !!extractCount && extractCount > 0,
    };
  },
};

// ── Request body ──

/**
 * Build the v1 search request body, mapping normalized filters to Kagi params.
 *
 * - include/exclude domains → lens.sites_included / lens.sites_excluded
 * - freshness day/week/month → lens.time_relative (server-side relative window)
 * - freshness year → filters.after (time_relative caps at month, so use a date)
 * - extractCount → extract.count (inline markdown extraction of top N results)
 */
export function buildRequestBody(
  query: string,
  limit: number,
  filters: SearchFilters | undefined,
  extractCount: number | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { query, limit };

  const lens: Record<string, unknown> = {};
  if (filters?.includeDomains?.length) lens.sites_included = filters.includeDomains;
  if (filters?.excludeDomains?.length) lens.sites_excluded = filters.excludeDomains;
  if (filters?.freshness === "day" || filters?.freshness === "week" || filters?.freshness === "month") {
    lens.time_relative = filters.freshness;
  }
  if (Object.keys(lens).length > 0) body.lens = lens;

  if (filters?.freshness === "year") {
    body.filters = { after: yearsAgoIso(1) };
  }

  if (extractCount && extractCount > 0) {
    // Inline extraction fetches full page markdown for the top N results and
    // drops it into each hit's snippet. Billed at the Extract API rate.
    body.extract = { count: Math.min(Math.max(extractCount, 1), 10) };
  }

  return body;
}

/** ISO date (YYYY-MM-DD) for `years` years before today. */
function yearsAgoIso(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

// ── Internal types ──
// Mirrors the Kagi v1 Search response envelope. `data` is an object whose keys
// are result buckets (search, news, video, adjacent_question, ...); every bucket
// is an array of KagiSearchItem. We only consume a few buckets.

interface KagiSearchItem {
  url: string;
  title: string;
  snippet?: string;
  time?: string;
  image?: { url: string; height?: number; width?: number };
  props?: { question?: string; [key: string]: unknown };
}

interface KagiResponseData {
  search?: KagiSearchItem[];
  adjacent_question?: KagiSearchItem[];
  related_search?: KagiSearchItem[];
  [key: string]: unknown;
}

interface KagiErrorDetail {
  code?: string;
  url?: string;
  message?: string | null;
  location?: string | null;
}

interface KagiResponse {
  meta?: { trace?: string; node?: string; ms?: number };
  data?: KagiResponseData;
  // v1 error envelopes: search uses `error[]`, extract uses `errors[]`.
  error?: KagiErrorDetail[];
  errors?: KagiErrorDetail[];
}

function parseErrorDetail(body: string): string | null {
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.detail === "string") return parsed.detail;
    if (typeof parsed.error === "string") return parsed.error;
    // v1 envelopes: error[] / errors[], each { code, url, message, location }.
    for (const key of ["errors", "error"] as const) {
      const arr = parsed[key];
      if (Array.isArray(arr)) {
        const msgs = arr
          .map((e) => (e as { message?: string | null })?.message)
          .filter((m): m is string => typeof m === "string" && m.length > 0);
        if (msgs.length > 0) return msgs.join("; ");
      }
    }
  } catch {
    // not JSON
  }
  return body.length > 200 ? `${body.slice(0, 200)}...` : body;
}
