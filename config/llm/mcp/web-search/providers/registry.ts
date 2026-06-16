/**
 * Provider registry for web-search.
 *
 * Each provider's client + adapter live in ./<name>.ts; this module holds the
 * shared registry (priority list + resolution + outcome formatting). Both the
 * MCP server and the pi extension import from here so adding a provider =
 * one entry in PROVIDERS, picked up by every host automatically.
 */

import { claudeProvider } from "./claude";
import { formatHits } from "./format";
import { kagiProvider } from "./kagi";
import { tavilyProvider } from "./tavily";
import type { SearchHit, SearchProvider } from "./types";

// Re-export the contract so hosts import from one place.
export type { SearchFilters, SearchProvider } from "./types";

export interface SearchOutcome {
  provider: string;
  hits: SearchHit[];
  relatedQuestions?: string[];
  extracted?: boolean;
  elapsedMs: number;
}

// Registered providers, in default priority order. Claude is last (slow,
// ~13s/query, needs the Claude CLI + auth).
const PROVIDERS: SearchProvider[] = [kagiProvider, tavilyProvider, claudeProvider];

export function listProviders(): SearchProvider[] {
  const order = process.env.WEB_SEARCH_PROVIDERS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!order || order.length === 0) return PROVIDERS;

  const byName = new Map(PROVIDERS.map((p) => [p.name, p]));
  return order.map((n) => byName.get(n)).filter((p): p is SearchProvider => Boolean(p));
}

/** First available provider, optionally forced. Returns null if none usable. */
export function resolveProvider(forced?: string): SearchProvider | null {
  const candidates = listProviders();
  if (forced) {
    const match = candidates.find((p) => p.name === forced);
    // A forced provider must also be available (key present) — otherwise the
    // caller gets a clear null→error rather than a mid-call key failure.
    return match?.isAvailable() ? match : null;
  }
  return candidates.find((p) => p.isAvailable()) ?? null;
}

export function providerNames(): string[] {
  return listProviders().map((p) => p.name);
}

/** Providers that are actually usable (key present), in priority order. Hosts
 *  iterate this for fallback chains, status, completion lists, etc. */
export function availableProviders(): SearchProvider[] {
  return listProviders().filter((p) => p.isAvailable());
}

/** Display label for a provider (falls back to its name). */
export function providerLabel(p: SearchProvider): string {
  return p.label ?? p.name;
}

export function formatOutcome(outcome: SearchOutcome): string {
  const body = formatHits(outcome.hits, outcome.relatedQuestions);
  if (outcome.hits.length === 0) {
    return `${body} (provider: ${outcome.provider})`;
  }
  return outcome.extracted ? `${body}\n\n[results include extracted page content]` : body;
}
