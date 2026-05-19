/**
 * Formatting utilities for LSP responses.
 *
 * Converts LSP types (diagnostics, locations, symbols, hover) into
 * human/LLM-readable text.
 *
 * Each formatter takes raw LSP protocol types and produces plain text
 * suitable for display in a terminal or inclusion in LLM context.
 * Line/column numbers are converted from 0-based (LSP) to 1-based (human).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SymbolInformation,
  WorkspaceEdit,
} from "./client";
import { uriToFile } from "./client";

// ── Diagnostics ──

/** Maps LSP DiagnosticSeverity enum values to human-readable labels. */
const SEVERITY_LABELS: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

/** Severity values ordered by priority (most severe first). */
const SEVERITY_ORDER = [1, 2, 3, 4] as const;

export function formatDiagnostic(d: Diagnostic, relPath: string): string {
  const sev = SEVERITY_LABELS[d.severity ?? 3] ?? "info";
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  const source = d.source ? ` (${d.source})` : "";
  const code = d.code ? ` [${d.code}]` : "";
  return `${relPath}:${line}:${col} [${sev}]${source}${code} ${d.message}`;
}

export function formatDiagnosticsSummary(diagnostics: Diagnostic[]): string {
  const counts: Record<string, number> = {};
  for (const d of diagnostics) {
    const key = SEVERITY_LABELS[d.severity ?? 3] ?? "info";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const sev of SEVERITY_ORDER) {
    const label = SEVERITY_LABELS[sev];
    const count = counts[label] ?? 0;
    if (count > 0) parts.push(`${count} ${label}${count === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no issues";
}

/**
 * Sort diagnostics in-place: by severity (errors first), then by line,
 * then by column for diagnostics on the same line.
 */
export function sortDiagnostics(diagnostics: Diagnostic[]): void {
  diagnostics.sort((a, b) => {
    const sevDiff = (a.severity ?? 3) - (b.severity ?? 3);
    if (sevDiff !== 0) return sevDiff;
    const lineDiff = a.range.start.line - b.range.start.line;
    if (lineDiff !== 0) return lineDiff;
    return a.range.start.character - b.range.start.character;
  });
}

// ── Locations ──

export function formatLocation(loc: Location, cwd: string): string {
  const filePath = uriToFile(loc.uri);
  const rel = path.relative(cwd, filePath);
  const line = loc.range.start.line + 1;
  const col = loc.range.start.character + 1;
  return `${rel}:${line}:${col}`;
}

/**
 * Normalize LSP location responses into a flat Location array.
 *
 * LSP definition/references can return Location | Location[] | LocationLink[].
 * LocationLink has targetUri/targetRange instead of uri/range. This normalizes
 * both forms into Location[], preferring targetSelectionRange (the precise
 * symbol range) over targetRange (the full declaration range) when available.
 */
export function normalizeLocations(result: unknown): Location[] {
  if (!result) return [];
  const raw = Array.isArray(result) ? result : [result];
  return raw.flatMap((loc) => {
    if (loc && typeof loc === "object" && "uri" in loc) return [loc as Location];
    if (loc && typeof loc === "object" && "targetUri" in loc) {
      const link = loc as LocationLink;
      return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
    }
    return [];
  });
}

/**
 * Read a few lines of context around a location from disk.
 *
 * Returns formatted lines with line numbers and a `>` marker on the target line.
 * Used to show surrounding code when displaying definition/reference results.
 *
 * @param filePath - Absolute path to the source file
 * @param line - 1-based line number to center on
 * @param contextLines - Number of lines to show above and below the target
 * @returns Formatted lines, or empty array if the file can't be read
 */
export function readLocationContext(filePath: string, line: number, contextLines = 1): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, line - 1 - contextLines);
    const end = Math.min(lines.length, line + contextLines);
    const gutterWidth = String(end).length;
    const result: string[] = [];
    for (let i = start; i < end; i++) {
      const lineNum = i + 1;
      const marker = lineNum === line ? ">" : " ";
      result.push(`${marker} ${String(lineNum).padStart(gutterWidth)} | ${lines[i]}`);
    }
    return result;
  } catch {
    return [];
  }
}

export function formatLocationWithContext(loc: Location, cwd: string, contextLines = 1): string {
  const header = formatLocation(loc, cwd);
  const filePath = uriToFile(loc.uri);
  const line = loc.range.start.line + 1;
  const context = readLocationContext(filePath, line, contextLines);
  if (context.length === 0) return header;
  return `${header}\n${context.map((l) => `    ${l}`).join("\n")}`;
}

// ── Hover ──

/**
 * Extract plain text from LSP hover contents.
 *
 * Hover contents can be a string, a MarkedString ({language, value} or plain string),
 * a MarkupContent ({kind, value}), or an array of any of these. This extracts the
 * text value from all forms, joining array elements with double newlines.
 */
export function extractHoverText(contents: Hover["contents"]): string {
  if (typeof contents === "string") return contents;
  if (!Array.isArray(contents)) {
    if ("value" in contents) return contents.value;
    return String(contents);
  }
  return contents
    .map((c) => {
      if (typeof c === "string") return c;
      if ("value" in c) return c.value;
      return String(c);
    })
    .join("\n\n");
}

// ── Symbols ──

/** Maps LSP SymbolKind enum values to human-readable labels. */
const SYMBOL_KINDS: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

/** Single-character icons for compact symbol display. Only the most common kinds. */
const SYMBOL_ICONS: Record<number, string> = {
  5: "C", // Class
  6: "m", // Method
  7: "p", // Property
  8: "f", // Field
  9: "K", // Constructor
  10: "E", // Enum
  11: "I", // Interface
  12: "F", // Function
  13: "v", // Variable
  14: "c", // Constant
  22: "e", // EnumMember
  23: "S", // Struct
  26: "T", // TypeParameter
};

export function formatDocumentSymbol(sym: DocumentSymbol, indent = 0): string[] {
  const kind = SYMBOL_KINDS[sym.kind] ?? "Unknown";
  const icon = SYMBOL_ICONS[sym.kind] ?? "?";
  const line = sym.selectionRange.start.line + 1;
  const detail = sym.detail ? ` — ${sym.detail}` : "";
  const prefix = " ".repeat(indent * 2);
  const lines = [`${prefix}[${icon}] ${sym.name} (${kind}) @ line ${line}${detail}`];
  if (sym.children) {
    for (const child of sym.children) {
      lines.push(...formatDocumentSymbol(child, indent + 1));
    }
  }
  return lines;
}

export function formatSymbolInformation(sym: SymbolInformation, cwd: string): string {
  const kind = SYMBOL_KINDS[sym.kind] ?? "Unknown";
  const icon = SYMBOL_ICONS[sym.kind] ?? "?";
  const loc = formatLocation(sym.location, cwd);
  const container = sym.containerName ? ` in ${sym.containerName}` : "";
  return `[${icon}] ${sym.name} (${kind})${container} @ ${loc}`;
}

/**
 * Resolve the column position of a symbol on a given line.
 * If symbol is provided, finds its position on the line.
 * Otherwise returns 0.
 */
/**
 * Resolve the 0-based column position of a symbol on a given line.
 *
 * Used by the LSP action dispatcher to convert (file, line, symbol) triples
 * into the (file, line, character) positions that LSP requests require.
 *
 * @param filePath - Absolute path to the source file
 * @param line - 1-based line number
 * @param symbol - Text to find on the line (if undefined, returns column 0)
 * @param occurrence - Which occurrence to match (1-based, defaults to 1)
 * @returns 0-based column index, or 0 if not found
 */
export function resolveSymbolColumn(filePath: string, line: number, symbol?: string, occurrence?: number): number {
  if (!symbol) return 0;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const targetLine = lines[line - 1];
    if (!targetLine) return 0;

    const occ = occurrence ?? 1;
    let found = 0;
    let idx = -1;
    let searchFrom = 0;
    while (found < occ) {
      idx = targetLine.indexOf(symbol, searchFrom);
      if (idx === -1) break;
      found++;
      searchFrom = idx + 1;
    }
    return idx >= 0 ? idx : 0;
  } catch {
    return 0;
  }
}

// ── Workspace edit application ──

/**
 * Apply a WorkspaceEdit to files on disk.
 *
 * Handles both `changes` (per-file TextEdit[]) and `documentChanges`
 * (structured edits that may create/rename files). For the LSP extension's
 * current use case, only `changes` is needed.
 *
 * Edits within each file are applied in reverse order (end-to-start)
 * to preserve character positions.
 *
 * @param edit - The WorkspaceEdit to apply
 * @param cwd - Current working directory for relative path reporting
 * @returns Array of "relativePath: N edit(s)" strings
 */
export async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  cwd: string,
): Promise<Array<{ path: string; count: number }>> {
  const results: Array<{ path: string; count: number }> = [];

  if (edit.changes) {
    for (const [editUri, edits] of Object.entries(edit.changes)) {
      const editPath = uriToFile(editUri);
      const relPath = path.relative(cwd, editPath);
      const content = await fs.promises.readFile(editPath, "utf-8");
      const lines = content.split("\n");

      // Apply edits in reverse order to preserve positions
      const sorted = [...edits].sort((a, b) => {
        const lineDiff = b.range.start.line - a.range.start.line;
        return lineDiff !== 0 ? lineDiff : b.range.start.character - a.range.start.character;
      });

      for (const textEdit of sorted) {
        const startLine = textEdit.range.start.line;
        const endLine = textEdit.range.end.line;
        const startChar = textEdit.range.start.character;
        const endChar = textEdit.range.end.character;

        if (startLine === endLine) {
          const line = lines[startLine];
          lines[startLine] = line.slice(0, startChar) + textEdit.newText + line.slice(endChar);
        } else {
          const firstLine = lines[startLine].slice(0, startChar) + textEdit.newText;
          const lastLine = lines[endLine].slice(endChar);
          lines.splice(startLine, endLine - startLine + 1, firstLine + lastLine);
        }
      }

      await fs.promises.writeFile(editPath, lines.join("\n"));
      results.push({ path: relPath, count: edits.length });
    }
  }

  return results;
}
