/**
 * Formatting utilities for LSP responses.
 *
 * Converts LSP types (diagnostics, locations, symbols, hover) into
 * human/LLM-readable text.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Diagnostic, DocumentSymbol, Hover, Location, LocationLink, SymbolInformation } from "./client";
import { uriToFile } from "./client";

// ── Diagnostics ──

const SEVERITY_LABELS: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

export function formatDiagnostic(d: Diagnostic, relPath: string): string {
  const sev = SEVERITY_LABELS[d.severity ?? 3] ?? "info";
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  const source = d.source ? ` (${d.source})` : "";
  const code = d.code ? ` [${d.code}]` : "";
  return `${relPath}:${line}:${col} [${sev}]${source}${code} ${d.message}`;
}

export function formatDiagnosticsSummary(diagnostics: Diagnostic[]): string {
  const counts = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const d of diagnostics) {
    const key = SEVERITY_LABELS[d.severity ?? 3] ?? "info";
    counts[key as keyof typeof counts]++;
  }
  const parts: string[] = [];
  if (counts.error > 0) parts.push(`${counts.error} error(s)`);
  if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`);
  if (counts.info > 0) parts.push(`${counts.info} info(s)`);
  if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`);
  return parts.length > 0 ? parts.join(", ") : "no issues";
}

export function sortDiagnostics(diagnostics: Diagnostic[]): void {
  diagnostics.sort((a, b) => {
    // Errors first
    const sevDiff = (a.severity ?? 3) - (b.severity ?? 3);
    if (sevDiff !== 0) return sevDiff;
    // Then by line
    return a.range.start.line - b.range.start.line;
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

export function normalizeLocations(result: unknown): Location[] {
  if (!result) return [];
  const raw = Array.isArray(result) ? result : [result];
  return raw.flatMap((loc) => {
    if (loc && "uri" in loc) return [loc as Location];
    if (loc && "targetUri" in loc) {
      const link = loc as LocationLink;
      return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
    }
    return [];
  });
}

/**
 * Read a few lines of context around a location from disk.
 */
export function readLocationContext(filePath: string, line: number, contextLines = 1): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, line - 1 - contextLines);
    const end = Math.min(lines.length, line + contextLines);
    const result: string[] = [];
    for (let i = start; i < end; i++) {
      const lineNum = i + 1;
      const marker = lineNum === line ? ">" : " ";
      result.push(`${marker} ${String(lineNum).padStart(4)} | ${lines[i]}`);
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

export function extractHoverText(contents: Hover["contents"]): string {
  if (typeof contents === "string") return contents;
  if (!Array.isArray(contents)) {
    // MarkedString or MarkupContent
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

const SYMBOL_ICONS: Record<number, string> = {
  5: "C",
  6: "m",
  7: "p",
  8: "f",
  10: "E",
  11: "I",
  12: "F",
  13: "v",
  14: "c",
  23: "S",
  26: "T",
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
