/**
 * Diagnostics dedup ledger: which diagnostics the agent has already been shown,
 * so the post-edit block reports only what's new and collapses the rest to a
 * single line. The agent still sees that something is wrong; it just doesn't
 * get the same full messages re-listed on every edit.
 *
 * Pure (no pi imports) — block assembly lives in index.ts / format.ts.
 *
 * Identity deliberately ignores position: an edit above an error shifts its
 * line and column, which is the same error, not a new one. Keying by position
 * would re-report every shifted error as fresh on each edit — exactly the
 * noise this removes. Trade-off: two identical errors in one file collapse to
 * one identity; fix one and the survivor reads as "unchanged" (still counted).
 */

import type { Diagnostic } from "./client";

/** Identity for the ledger: source + severity + code + message, no position. */
export function diagnosticIdentity(d: Diagnostic): string {
  return `${d.source ?? ""}|${d.severity}|${d.code ?? ""}|${d.message}`;
}

export interface LedgerSplit {
  /** Diagnostics never shown before, or re-appeared after the file went clean. */
  fresh: Diagnostic[];
  /** Diagnostics shown before, unchanged. */
  unchanged: Diagnostic[];
}

/** Per-file ledger of identities the agent has already been shown. */
export class DiagnosticsLedger {
  private seen = new Map<string, Set<string>>();

  /**
   * Classify a file's current diagnostics against what was shown before, and
   * update the ledger. A file that goes clean is forgotten, so re-appearing
   * errors classify as fresh again.
   */
  reduce(absPath: string, diagnostics: Diagnostic[]): LedgerSplit {
    const previous = this.seen.get(absPath);
    const current = new Set<string>();
    const fresh: Diagnostic[] = [];
    const unchanged: Diagnostic[] = [];
    for (const d of diagnostics) {
      const id = diagnosticIdentity(d);
      current.add(id);
      if (previous?.has(id)) unchanged.push(d);
      else fresh.push(d);
    }
    if (current.size === 0) this.seen.delete(absPath);
    else this.seen.set(absPath, current);
    return { fresh, unchanged };
  }

  /** Forget everything. Called on session start: a new conversation has not
   * seen any diagnostics, so the first report must show the full set. */
  clear(): void {
    this.seen.clear();
  }
}
