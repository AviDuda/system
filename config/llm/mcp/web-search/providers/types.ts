/**
 * Shared types for web-search providers.
 *
 * Pure module — no network, no host-specific imports. Provider clients and
 * host adapters both depend on these.
 */

/** Normalized filters most providers can map to their own params. All optional. */
export interface SearchFilters {
  /** Restrict to results published/updated within this recency window. */
  freshness?: "day" | "week" | "month" | "year";
  /** Restrict to these domains (whitelist). */
  includeDomains?: string[];
  /** Exclude these domains. No-op on providers without exclude support (e.g. z.ai). */
  excludeDomains?: string[];
}

/** A single normalized search hit. Provider results map to this shape. */
export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
}

/** What a provider's search() returns, before the host stamps on provider/timing. */
export interface ProviderSearchResult {
  hits: SearchHit[];
  relatedQuestions?: string[];
  /** True when full page content was extracted inline (e.g. Kagi extract.count). */
  extracted?: boolean;
}

/** A search provider. Adapters are defined per-provider; hosts list which to enable. */
export interface SearchProvider {
  name: string;
  /** Human-readable label for UI (status pills, notifications). Defaults to name. */
  label?: string;
  /** Cheap check — is the provider configured (key present, etc.)? */
  isAvailable(): boolean;
  search(
    query: string,
    opts: { limit?: number; signal?: AbortSignal; filters?: SearchFilters; extractCount?: number },
  ): Promise<ProviderSearchResult>;
}
