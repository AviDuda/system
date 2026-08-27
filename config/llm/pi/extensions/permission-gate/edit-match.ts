/**
 * Edit-tool matching, vendored from pi's internal dist/core/tools/edit-diff.js
 * (pi does not export it through the public API). Behaviorally identical to
 * what the built-in edit tool runs, so match outcomes here predict tool
 * outcomes. Pure string logic, no pi imports; equivalence-tested against pi's
 * compiled implementation in edit-match.test.ts.
 *
 * Semantics preserved from upstream:
 * - Content and edit texts are LF-normalized before matching.
 * - Exact match first; on failure, NFKC + per-line-trimEnd + smart-quote/
 *   dash/space normalization for both sides (fuzzy). If ANY edit goes fuzzy,
 *   ALL matches are recomputed in fully-normalized space and only changed
 *   line groups are overlaid back onto the original bytes.
 * - Rejections mirror the tool's: empty oldText, not found, duplicate
 *   occurrences (counted in fuzzy space even when exact matched), overlapping
 *   edits, net-no-change.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EditOp {
  oldText: string;
  newText: string;
}

interface TextReplacement {
  matchIndex: number;
  matchLength: number;
  newText: string;
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Normalize text for fuzzy matching (upstream normalizeForFuzzyMatch):
 * NFKC, per-line trailing-whitespace strip, smart quotes → ASCII,
 * Unicode dashes → "-", special Unicode spaces → " ".
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
  start: number;
  end: number;
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(
  lines: LineSpan[],
  replacement: TextReplacement,
): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content.");
  }
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

/**
 * Upstream applyReplacementsPreservingUnchangedLines: replacements matched
 * against `base` (normalized view) are widened to touched lines, those lines
 * are rewritten from base, everything else copied verbatim from `original`.
 */
function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
  }
  const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
  const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }
  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStartOffset = baseLines[group.startLine].start;
    const groupEndOffset = baseLines[group.endLine - 1].end;
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");
  return result;
}

interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
}

/** Upstream fuzzyFindText: exact indexOf, falling back to normalized-space indexOf. */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  }
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

/** Occurrence count always computed in fuzzy space (upstream countOccurrences). */
function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

/**
 * Apply edits to LF-normalized content exactly as the built-in edit tool does
 * (upstream applyEditsToNormalizedContent). Throws on the tool's rejection
 * conditions (empty/not-found/duplicate/overlap/no-change).
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: EditOp[],
  path: string,
): { baseContent: string; newContent: string } {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw new Error(`edits[${i}].oldText must not be empty in ${path}.`);
    }
  }
  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
  const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
  const matchedEdits: Array<TextReplacement & { editIndex: number }> = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
    if (!matchResult.found) {
      throw new Error(
        `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
      );
    }
    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) {
      throw new Error(
        `Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
      );
    }
    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }
  const baseContent = normalizedContent;
  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
    : applyReplacements(replacementBaseContent, matchedEdits);
  if (baseContent === newContent) {
    throw new Error(`No changes made to ${path}. The replacements produced identical content.`);
  }
  return { baseContent, newContent };
}

// --- Path resolution (upstream resolveToCwd / normalizePath) ---

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Convert Git Bash/MSYS/Cygwin/WSL drive paths to native form (Windows only inputs). */
export function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * Resolve an edit-tool path argument the way pi resolves it before reading
 * (upstream resolveToCwd): unicode spaces → regular, "@" prefix stripped,
 * ~ expanded, file:// URLs converted, relative joined onto cwd.
 */
export function resolveEditPath(filePath: string, cwd: string): string {
  let normalized = filePath.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (process.platform === "win32") {
    normalized = normalizeWindowsShellPath(normalized);
  }
  const home = homedir();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    return join(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    normalized = fileURLToPath(normalized);
  }
  return isAbsolute(normalized) ? nodeResolve(normalized) : nodeResolve(cwd, normalized);
}
