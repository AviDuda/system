/**
 * Format drift detection.
 *
 * Asks a server what the project formatter would do to a file
 * (textDocument/formatting) and summarizes the changed line ranges. Reports
 * only — never applies. The agent's patches assume on-disk == last write;
 * knowing a formatter would rewrite part of the file prevents stale-oldText
 * surprises when the next patch targets unformatted content.
 *
 * The gate is the caller's: only repo-gated servers (allowLazy: false —
 * biome) opt in to a formatter via config marker, so drift is only checked
 * where the project's formatter is unambiguous. Other servers (rust-analyzer,
 * gopls) are skipped; revisit if rustfmt/gofmt drift proves worth reporting.
 */

import type { LspClient } from "./client";
import { serverUriFor } from "./client";

/**
 * Ask a server to format `abs` and return collapsed 1-based changed line
 * ranges (e.g. "2-4, 7"), or null when the server has no formatter or the
 * formatter would not change the file. Servers that don't implement
 * formatting reject the request — a normal no-drift signal.
 */
export async function formatDriftLines(client: LspClient, abs: string): Promise<string | null> {
  let edits: unknown;
  try {
    edits = await client.request("textDocument/formatting", {
      textDocument: { uri: serverUriFor(client, abs) },
      options: { tabSize: 2, insertSpaces: true },
    });
  } catch {
    return null; // no formatting support
  }
  if (!Array.isArray(edits) || edits.length === 0) return null;

  const lines = new Set<number>();
  for (const e of edits as Array<{ range?: { start?: { line?: number }; end?: { line?: number } } }>) {
    const start = e?.range?.start?.line;
    const end = e?.range?.end?.line;
    if (typeof start !== "number" || typeof end !== "number") continue;
    for (let l = start; l <= end; l++) lines.add(l + 1);
  }
  if (lines.size === 0) return null;
  return collapseRanges([...lines]);
}

/**
 * Collapse line numbers into ranges: [2, 3, 4, 7, 12, 13] → "2-4, 7, 12-13".
 * Order-independent; duplicates collapse into their range.
 */
export function collapseRanges(lines: number[]): string {
  const sorted = [...lines].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev) continue; // duplicate
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    if (cur !== undefined) {
      start = cur;
      prev = cur;
    }
  }
  return parts.join(", ");
}
