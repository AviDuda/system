/**
 * Pure diagnostics for the patch tool. No pi imports — bun-testable.
 *
 * Builds the model-facing error/result text from a PlanResult: closest-match
 * "did you mean" on no-match, occurrence lines with context on ambiguity, and
 * the diff-in-success summary. All text is plain (the LLM and print mode see
 * this directly; the TUI gets its own colored rendering via renderDiff).
 */

import type { MatchHit, PlannedReplacement, PlanResult } from "./match";
import { normalizeForFuzzyMatch, normalizeToLF } from "./match";

// ── Similarity (for closest-match diagnostics) ─────────────────────────────

/**
 * Character-bigram Dice coefficient in [0, 1]. Cheap, language-agnostic, good
 * enough for "did you mean". Used for DIAGNOSTICS only — never to decide
 * whether to apply an edit.
 */
export function similarity(a: string, b: string): number {
  const ta = bigrams(a);
  const tb = bigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  const norm = s.replace(/\s+/g, " ").trim().toLowerCase();
  for (let i = 0; i + 1 < norm.length; i++) {
    set.add(norm.slice(i, i + 2));
  }
  return set;
}

// ── Line extraction with context ───────────────────────────────────────────

export interface LineInfo {
  /** 1-based line number. */
  num: number;
  text: string;
}

/** Split content into 1-based numbered lines (no trailing newline). */
export function numberedLines(content: string): LineInfo[] {
  return splitLines(content).map((text, i) => ({ num: i + 1, text }));
}

function splitLines(content: string): string[] {
  // Preserve empty trailing line semantics: "a\n" → ["a"], "a\nb" → ["a","b"]
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Lines [aroundLine - context, aroundLine + context] inclusive (1-based). */
export function contextLines(content: string, aroundLine: number, context: number): LineInfo[] {
  const lines = numberedLines(content);
  const start = Math.max(1, aroundLine - context);
  const end = Math.min(lines.length, aroundLine + context);
  const out: LineInfo[] = [];
  for (let n = start; n <= end; n++) {
    const text = lines[n - 1]?.text ?? "";
    out.push({ num: n, text });
  }
  return out;
}

// ── Closest match (no-match diagnostic) ────────────────────────────────────

export interface ClosestMatch {
  line: number;
  similarity: number;
  /** The actual file text at that window. */
  text: string;
  /** Structured breakdown of how oldText differs from this window. */
  diagnosis: LineDiffDiagnosis;
}

/** How oldText differs from a closest-match window, classified by fixability.
 * Diagnosis only — never drives application. */
export interface LineDiffDiagnosis {
  /** Lines differing only in whitespace/indentation (content tokens match).
   * Fix: re-copy the file's actual whitespace. */
  whitespaceOnly: number;
  /** Lines whose content actually differs. Fix: rewrite that text. */
  contentDiffer: number;
  /** Lines present in the file window but absent from oldText (oldText too short). */
  missingFromOldText: number;
  /** Lines in oldText but absent from the window (oldText too long). */
  extraInOldText: number;
}

/** Classify the line-level difference between oldText and a file window by
 * zipping lines pairwise (same line count, guaranteed by closestMatches).
 * No external dependency — avoids the tsconfig-paths != runtime-resolution
 * gap that bit the `diff` import (tsc saw it via paths, Node couldn't at runtime).
 *
 * Works reliably when both inputs have the same line count (the common case
 * via closestMatches). For mismatched-count edge cases the counts diverge
 * naturally via the undefined checks below. */
export function diagnoseLineDiff(oldText: string, windowContent: string): LineDiffDiagnosis {
  const oldLines = splitToLines(oldText);
  const winLines = splitToLines(windowContent);
  const len = Math.max(oldLines.length, winLines.length);
  let whitespaceOnly = 0;
  let contentDiffer = 0;
  let missingFromOldText = 0;
  let extraInOldText = 0;

  for (let i = 0; i < len; i++) {
    const o = oldLines[i];
    const w = winLines[i];
    if (o === undefined) {
      missingFromOldText++;
    } else if (w === undefined) {
      extraInOldText++;
    } else if (o === w) {
      // raw-identical — no difference, skip
    } else if (normalizeWhitespace(o) === normalizeWhitespace(w)) {
      whitespaceOnly++;
    } else {
      contentDiffer++;
    }
  }
  return { whitespaceOnly, contentDiffer, missingFromOldText, extraInOldText };
}

/** Strip trailing newline and split into lines for pairwise comparison. */
function splitToLines(text: string): string[] {
  const t = text.endsWith("\n") ? text.slice(0, -1) : text;
  return t.split("\n");
}

/** Collapse all whitespace runs to single space and trim, for the
 * whitespace-only-vs-content classification. */
function normalizeWhitespace(line: string): string {
  return line.replace(/[^\S\n]+/g, " ").trim();
}

/** Render a diagnosis as a human phrase (self-contained: names what differs
 * AND the implied fix, so a clueless model can act without inferring). */
export function describeDiagnosis(d: LineDiffDiagnosis): string {
  const bits: string[] = [];
  if (d.whitespaceOnly > 0)
    bits.push(
      `${d.whitespaceOnly} line(s) differ only in whitespace/indentation (text tokens match — your oldText needs the file's actual tabs/spaces)`,
    );
  if (d.contentDiffer > 0)
    bits.push(`${d.contentDiffer} line(s) differ in actual text (rewrite oldText to match those lines)`);
  if (d.missingFromOldText > 0)
    bits.push(
      `your oldText is missing ${d.missingFromOldText} line(s) that the file has at this spot (add them to oldText)`,
    );
  if (d.extraInOldText > 0)
    bits.push(`your oldText has ${d.extraInOldText} extra line(s) not in the file here (remove them from oldText)`);
  if (bits.length === 0) return "identical";
  return bits.join("; ");
}

/**
 * Slide a window the size of oldText's line count across the file, rank by
 * similarity to oldText. Return the top candidates above a threshold.
 */
export function closestMatches(content: string, oldText: string, maxResults = 3, threshold = 0.4): ClosestMatch[] {
  const fileLines = splitLines(content);
  const needleLines = splitLines(oldText);
  if (needleLines.length === 0 || fileLines.length === 0) return [];
  const windowSize = needleLines.length;
  const candidates: Array<Omit<ClosestMatch, "diagnosis">> = [];
  for (let i = 0; i + windowSize <= fileLines.length; i++) {
    const windowText = fileLines.slice(i, i + windowSize).join("\n");
    const sim = similarity(oldText, windowText);
    if (sim >= threshold) {
      candidates.push({ line: i + 1, similarity: sim, text: windowText });
    }
  }
  candidates.sort((a, b) => b.similarity - a.similarity);
  // Compute the structured diagnosis only for the top results (diagnoseLineDiff
  // is O(lines) per call; don't run it for every sliding window).
  return candidates.slice(0, maxResults).map((c) => ({
    ...c,
    diagnosis: diagnoseLineDiff(oldText, c.text),
  }));
}

// ── Duplicate-line guard ───────────────────────────────────────────────────

/**
 * Detect boundary duplication: the model included surrounding unchanged lines
 * inside its replacement. Reject when replacement's first line matches the line
 * immediately before the range, or last line matches the line immediately after.
 *
 * No punctuation exemption: for oldText-exact-match semantics, if oldText did
 * not include a boundary line, newText must not re-emit it (it would double on
 * disk). The Octofs-style lone-punctuation exemption is tuned for line-range
 * replaces and is wrong here — live testing showed it let through exactly the
 * doubled-brace case it was meant to protect against. If a matched block's
 * neighbor is `}` and newText also ends with `}`, that's always a duplicate.
 */
export interface DuplicationIssue {
  /** "before" | "after" — which boundary duplicated. */
  edge: "before" | "after";
  /** 1-based line number of the duplicated neighbor. */
  neighborLine: number;
  /** The duplicated text. */
  text: string;
}

export function detectBoundaryDuplication(content: string, hit: MatchHit, newText: string): DuplicationIssue | null {
  const fileLines = splitLines(content);
  const newLines = newText.split("\n");
  if (newLines.length === 0) return null;

  // hit.line is 1-based; matched block spans lines [hit.line, hit.line + lineCount - 1].
  const beforeLine = fileLines[hit.line - 2]; // line immediately above the range
  const afterLine = fileLines[hit.line - 1 + hit.lineCount]; // line immediately below

  const firstNew = newLines[0];
  const lastNew = newLines[newLines.length - 1];

  if (beforeLine !== undefined && firstNew !== undefined && beforeLine === firstNew) {
    return { edge: "before", neighborLine: hit.line - 1, text: beforeLine };
  }
  if (afterLine !== undefined && lastNew !== undefined && afterLine === lastNew) {
    return { edge: "after", neighborLine: hit.line + hit.lineCount, text: afterLine };
  }
  return null;
}

// ── Message formatting ─────────────────────────────────────────────────────

export const CONTEXT = 2;

/** Render occurrence hits with surrounding context (grep -C style). */
export function formatHitsWithContext(content: string, hits: MatchHit[]): string {
  return hits
    .map((hit) => {
      const ctx = contextLines(content, hit.line, CONTEXT);
      const rendered = ctx
        .map((l) => {
          const marker = l.num === hit.line ? ">>" : "  ";
          return `${marker} ${l.num}: ${l.text}`;
        })
        .join("\n");
      return `line ${hit.line} (${hit.kind}):\n${rendered}`;
    })
    .join("\n\n");
}

/** Render closest-match suggestions. */
export function formatClosestMatches(matches: ClosestMatch[]): string {
  if (matches.length === 0) {
    return "No similar text found. Re-read the file and check the exact content.";
  }
  const allWhitespace = matches.every((m) => isWhitespaceOnlyDiagnosis(m.diagnosis));
  const lines = matches.map((m, idx) => {
    const pct = Math.round(m.similarity * 100);
    const preview = m.text.split("\n").slice(0, 4).join("\n");
    const more = m.text.split("\n").length > 4 ? "\n  ..." : "";
    return `  ${idx + 1}. Lines ${m.line}-${m.line + m.text.split("\n").length - 1} (${pct}% similar — ${describeDiagnosis(m.diagnosis)})\n  ${preview}${more}`;
  });
  const tip = allWhitespace
    ? "Tip: your content looks right — only whitespace differs. Re-copy the exact text from the file (watch tabs vs spaces, indentation)."
    : "Tip: copy the exact text from the file (watch tabs vs spaces, Unicode symbols); fix differing content.";
  return `No exact match. Closest matches:\n${lines.join("\n")}\n\n${tip}`;
}

/** True when every difference is whitespace/indentation-only (content matches). */
function isWhitespaceOnlyDiagnosis(d: LineDiffDiagnosis): boolean {
  return d.whitespaceOnly > 0 && d.contentDiffer === 0 && d.missingFromOldText === 0 && d.extraInOldText === 0;
}

// ── Near-miss detection (normalized-equal occurrences the agent should know) ─

export interface NearMiss {
  line: number;
  lineCount: number;
  text: string;
}

/**
 * Find occurrences of oldText that match after normalization but are NOT exact
 * matches. These are "near-misses" — e.g., a third occurrence with 2-space
 * indent when oldText has 4-space indent, invisible to the exact-match scan
 * but structurally the same code the agent intended to target.
 *
 * Only meaningful when there ARE exact hits (the non-unique/ambiguous case).
 * When there are no exact hits, the normalized cascade handles matching.
 */
export function findNearMisses(content: string, oldText: string, exactHitLines: Set<number>): NearMiss[] {
  const normalizedOld = normalizeForFuzzyMatch(oldText);
  // If normalization doesn't change oldText, every normalized-equal line is
  // already an exact match — no near-misses possible.
  if (normalizedOld === normalizeToLF(oldText)) return [];

  const lines = splitLines(content);
  const needleLines = splitLines(normalizedOld);
  const windowSize = needleLines.length;
  if (windowSize === 0) return [];

  const nearMisses: NearMiss[] = [];
  for (let i = 0; i + windowSize <= lines.length; i++) {
    if (windowOverlapsExact(i + 1, windowSize, exactHitLines)) continue;
    const windowText = lines.slice(i, i + windowSize).join("\n");
    if (normalizeForFuzzyMatch(windowText) === normalizedOld) {
      nearMisses.push({ line: i + 1, lineCount: windowSize, text: windowText });
    }
  }
  return nearMisses;
}

/** True when any line in [startLine, startLine+windowSize) is in exactHitLines. */
function windowOverlapsExact(startLine: number, windowSize: number, exactHitLines: Set<number>): boolean {
  for (let l = startLine; l < startLine + windowSize; l++) {
    if (exactHitLines.has(l)) return true;
  }
  return false;
}

/** Build the set of all line numbers covered by exact hits. */
function exactHitLineSet(hits: MatchHit[]): Set<number> {
  const set = new Set<number>();
  for (const h of hits) {
    for (let l = h.line; l < h.line + h.lineCount; l++) set.add(l);
  }
  return set;
}

/** Format near-miss lines with context (same `>>` + context pattern as hits). */
function formatNearMisses(content: string, misses: NearMiss[]): string {
  return misses
    .map((m) => {
      const ctx = contextLines(content, m.line, CONTEXT);
      const rendered = ctx
        .map((l) => {
          const marker = l.num === m.line ? ">>" : "  ";
          return `${marker} ${l.num}: ${l.text}`;
        })
        .join("\n");
      return `line ${m.line} (normalized-equal):\n${rendered}`;
    })
    .join("\n\n");
}

/** Build the per-edit outcome messages from a plan (no overlap-free successes). */
export function formatOutcomes(content: string, plan: PlanResult, edits: { oldText: string }[]): string[] {
  const messages: string[] = [];
  for (const outcome of plan.outcomes) {
    const edit = edits[outcome.editIndex];
    switch (outcome.status) {
      case "applied":
        continue;
      case "no-op":
        messages.push(
          `edits[${outcome.editIndex}]: no-op — oldText and newText are identical (after normalization), so this edit changes nothing. You likely pasted the same text on both sides. Remove this edit or correct newText.`,
        );
        break;
      case "empty":
        messages.push(
          "edits[".concat(
            String(outcome.editIndex),
            "]: oldText is empty. patch edits existing files by matching oldText; to create a new file, use the write tool.",
          ),
        );
        break;
      case "no-match": {
        const closest = closestMatches(content, edit.oldText);
        messages.push(`edits[${outcome.editIndex}]: not found.\n${formatClosestMatches(closest)}`);
        break;
      }
      case "ambiguous": {
        if (outcome.hits.length > 0) {
          const exactLines = exactHitLineSet(outcome.hits);
          const miss = findNearMisses(content, edit.oldText, exactLines);
          const missText =
            miss.length > 0
              ? `\n\nAlso found ${miss.length} normalized-equal occurrence(s) with different whitespace (the exact match missed these):\n${formatNearMisses(content, miss)}`
              : "";
          messages.push(
            `edits[${outcome.editIndex}]: found ${outcome.hits.length} occurrences. Use a unique \`anchor\`, set \`replaceAll: true\`, or add more context.\n${formatHitsWithContext(content, outcome.hits)}${missText}`,
          );
        } else {
          messages.push(`edits[${outcome.editIndex}]: overlaps another edit. Merge them or target disjoint regions.`);
        }
        break;
      }
    }
  }
  return messages;
}

/** Count applied replacements for the success summary. */
export function countApplied(replacements: PlannedReplacement[]): { edits: number; occurrences: number } {
  const editIndices = new Set(replacements.map((r) => r.editIndex));
  return { edits: editIndices.size, occurrences: replacements.length };
}
