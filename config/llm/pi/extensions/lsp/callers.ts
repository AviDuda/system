/**
 * Post-edit caller warning: which top-level symbols an edit touched (via a
 * line diff) and how to surface their callers to the agent.
 *
 * Pure (node:path only, no pi imports) — the LSP calls (documentSymbol,
 * prepareCallHierarchy, incomingCalls) live in index.ts / client.ts. Changing
 * a function's body or signature can break its callers even when it still
 * type-checks, which is the gap diagnostics don't cover.
 */

import * as path from "node:path";
import { changedLineNumbers } from "../shared/diff";
import type { DocumentSymbol } from "./client";

/** Cap on symbols reported per edit (over-touching stays bounded). */
export const MAX_CALLER_SYMBOLS = 4;
/** Cap on caller sites listed per symbol (aggregate count still shown). */
export const MAX_CALLERS_PER_SYMBOL = 6;

/**
 * NEW-side 1-based changed line numbers between two file contents. Thin
 * wrapper over the shared line diff so callers read intent, plus it returns
 * [] for identical content (common no-op edit) without a scan.
 */
export function changedLines(oldContent: string, newContent: string): number[] {
  return changedLineNumbers(oldContent, newContent);
}

/**
 * The top-level `documentSymbol`s whose declared range overlaps a changed
 * line. Nested symbols (method bodies) are reported via their enclosing
 * top-level declaration — that's the unit LSP callers resolve against.
 */
export function touchedSymbols(symbols: DocumentSymbol[], changedLines_: readonly number[]): DocumentSymbol[] {
  if (changedLines_.length === 0) return [];
  const changedSet = new Set(changedLines_);
  const out: DocumentSymbol[] = [];
  for (const sym of symbols) {
    const start = sym.range.start.line + 1; // 1-based
    const end = sym.range.end.line + 1;
    if (symbolOverlapsRange(changedSet, start, end)) out.push(sym);
  }
  return out;
}

/** True when any changed 1-based line falls in [start, end] (inclusive). */
function symbolOverlapsRange(changedSet: Set<number>, start: number, end: number): boolean {
  // Prefer iterating the smaller side: changed-lines are usually few.
  if (changedSet.size <= end - start) {
    for (const line of changedSet) {
      if (line >= start && line <= end) return true;
    }
    return false;
  }
  for (let l = start; l <= end; l++) {
    if (changedSet.has(l)) return true;
  }
  return false;
}

/** One symbol's caller summary for the agent. Caller locations are already
 * host-visible "rel/path:line" strings (built where the LSP pathMap lives). */
export interface CallerWarningSymbol {
  name: string;
  /** 1-based declaration line within its file. */
  line: number;
  /** Up to MAX_CALLERS_PER_SYMBOL caller location strings. */
  callers: string[];
  /** Total caller count (>= callers.length when capped). */
  totalCallers: number;
}

/** Render the `[LSP callers ...]` block appended to an edit result. */
export function formatCallerWarnings(serverDisplay: string, relFile: string, touched: CallerWarningSymbol[]): string {
  const lines = touched.map((s) => {
    const here = `${relFile}:${s.line}`;
    const list = s.callers.join(", ");
    const more = s.totalCallers > s.callers.length ? ` (+${s.totalCallers - s.callers.length} more)` : "";
    const detail = list ? `${list}${more}` : "(no call sites)";
    return `  ${s.name} (${here}): ${detail}`;
  });
  return `[LSP callers (${serverDisplay}): ${touched.length} symbol(s) changed — call sites to check]\n${lines.join("\n")}`;
}

/** Format a caller item's location as `rel/path:line` given its host file path. */
export function formatCallerLocation(hostFile: string, line0: number, cwd: string): string {
  return `${path.relative(cwd, hostFile)}:${line0 + 1}`;
}
