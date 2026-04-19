/**
 * Provider registry for web-search MCP server.
 *
 * Adding a provider:
 *   1. Create providers/<name>.ts exporting a SearchProvider
 *   2. Import + add to PROVIDERS below
 *
 * Active providers are ordered by the WEB_SEARCH_PROVIDERS env var
 * (comma-separated). Default: first available in PROVIDERS order.
 */

import { kagiProvider } from "./providers/kagi";

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
}

export interface SearchOutcome {
  provider: string;
  hits: SearchHit[];
  relatedQuestions?: string[];
  elapsedMs: number;
}

export interface SearchProvider {
  name: string;
  /** Cheap check — is the provider configured (key present, etc.)? */
  isAvailable(): boolean;
  search(
    query: string,
    opts: { limit?: number; signal?: AbortSignal },
  ): Promise<Omit<SearchOutcome, "provider" | "elapsedMs">>;
}

const PROVIDERS: SearchProvider[] = [kagiProvider];

export function listProviders(): SearchProvider[] {
  const order = process.env.WEB_SEARCH_PROVIDERS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!order || order.length === 0) return PROVIDERS;

  const byName = new Map(PROVIDERS.map((p) => [p.name, p]));
  return order.map((n) => byName.get(n)).filter((p): p is SearchProvider => Boolean(p));
}

export function resolveProvider(forced?: string): SearchProvider | null {
  const candidates = listProviders();
  if (forced) {
    return candidates.find((p) => p.name === forced) ?? null;
  }
  return candidates.find((p) => p.isAvailable()) ?? null;
}

export function providerNames(): string[] {
  return listProviders().map((p) => p.name);
}

export function formatOutcome(outcome: SearchOutcome): string {
  if (outcome.hits.length === 0) {
    return `No results found (provider: ${outcome.provider}).`;
  }

  const lines: string[] = [];
  for (const [i, hit] of outcome.hits.entries()) {
    lines.push(`[${i + 1}] ${hit.title}`);
    lines.push(`    ${hit.url}`);
    if (hit.snippet) lines.push(`    ${hit.snippet}`);
    if (hit.publishedDate) lines.push(`    Published: ${hit.publishedDate}`);
    lines.push("");
  }

  if (outcome.relatedQuestions && outcome.relatedQuestions.length > 0) {
    lines.push("Related questions:");
    for (const q of outcome.relatedQuestions) lines.push(`  - ${q}`);
  }

  return lines.join("\n").trimEnd();
}
