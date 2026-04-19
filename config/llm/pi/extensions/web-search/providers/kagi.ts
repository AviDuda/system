/**
 * Kagi web search API client.
 * Pure module — no pi imports, testable independently.
 */

import { readFileSync } from "node:fs";

const KAGI_SEARCH_URL = "https://kagi.com/api/v0/search";

// ── Types ──

export interface KagiSource {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
}

export interface KagiSearchResult {
  requestId: string;
  sources: KagiSource[];
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
//
// Resolution order:
//   1. KAGI_API_KEY env var (direct value)
//   2. KAGI_API_KEY_FILE env var (path to file containing key)
//   3. /run/secrets/kagi_api_key (sops-nix default)

const DEFAULT_SECRET_PATH = "/run/secrets/kagi_api_key";

export function loadApiKey(): string {
  if (process.env.KAGI_API_KEY) return process.env.KAGI_API_KEY;

  const path = process.env.KAGI_API_KEY_FILE ?? DEFAULT_SECRET_PATH;
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    throw new KagiApiError(
      `Cannot load Kagi API key: set KAGI_API_KEY env var, or KAGI_API_KEY_FILE to a readable path, or deploy ${DEFAULT_SECRET_PATH}.`,
    );
  }
}

// ── Search ──

export async function search(
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<KagiSearchResult> {
  const apiKey = loadApiKey();
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 40);

  const url = new URL(KAGI_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bot ${apiKey}`,
      Accept: "application/json",
    },
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

  if (payload.error && payload.error.length > 0) {
    const first = payload.error[0];
    throw new KagiApiError(
      first.msg ? `Kagi API error: ${first.msg}` : `Kagi API error (${first.code ?? "unknown"})`,
      first.code,
    );
  }

  const sources: KagiSource[] = [];
  const relatedQuestions: string[] = [];

  for (const item of payload.data) {
    if (item.t === 0) {
      sources.push({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        publishedDate: item.published ?? undefined,
      });
    } else if (item.t === 1) {
      relatedQuestions.push(...item.list);
    }
  }

  return { requestId: payload.meta.id, sources, relatedQuestions };
}

// ── Format results for LLM consumption ──

export function formatResults(result: KagiSearchResult): string {
  if (result.sources.length === 0) {
    return "No results found.";
  }

  const lines: string[] = [];
  for (const [i, source] of result.sources.entries()) {
    lines.push(`[${i + 1}] ${source.title}`);
    lines.push(`    ${source.url}`);
    if (source.snippet) {
      lines.push(`    ${source.snippet}`);
    }
    if (source.publishedDate) {
      lines.push(`    Published: ${source.publishedDate}`);
    }
    lines.push("");
  }

  if (result.relatedQuestions.length > 0) {
    lines.push("Related questions:");
    for (const q of result.relatedQuestions) {
      lines.push(`  - ${q}`);
    }
  }

  return lines.join("\n").trimEnd();
}

// ── Internal types ──

interface KagiResultObject {
  t: 0;
  url: string;
  title: string;
  snippet?: string;
  published?: string;
}

interface KagiRelatedObject {
  t: 1;
  list: string[];
}

interface KagiResponse {
  meta: { id: string };
  data: (KagiResultObject | KagiRelatedObject)[];
  error?: { code?: number; msg?: string }[];
}

function parseErrorDetail(body: string): string | null {
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.detail === "string") return parsed.detail;
    if (typeof parsed.error === "string") return parsed.error;
    if (Array.isArray(parsed.error)) {
      const first = parsed.error[0] as { msg?: string } | undefined;
      if (first?.msg) return first.msg;
    }
  } catch {
    // not JSON
  }
  return body.length > 200 ? `${body.slice(0, 200)}...` : body;
}
