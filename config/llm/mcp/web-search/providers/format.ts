/**
 * Result formatting for web-search providers.
 *
 * Pure module. The single formatter used by host adapters — no per-provider
 * formatResults duplication.
 */

import type { SearchHit } from "./types";

/**
 * Format normalized hits as a numbered list for LLM consumption.
 */
export function formatHits(hits: SearchHit[], relatedQuestions?: string[]): string {
  if (hits.length === 0) {
    return "No results found.";
  }

  const lines: string[] = [];
  for (const [i, hit] of hits.entries()) {
    lines.push(`[${i + 1}] ${hit.title}`);
    lines.push(`    ${hit.url}`);
    if (hit.snippet) {
      lines.push(`    ${hit.snippet}`);
    }
    if (hit.publishedDate) {
      lines.push(`    Published: ${hit.publishedDate}`);
    }
    lines.push("");
  }

  if (relatedQuestions && relatedQuestions.length > 0) {
    lines.push("Related questions:");
    for (const q of relatedQuestions) {
      lines.push(`  - ${q}`);
    }
  }

  return lines.join("\n").trimEnd();
}
