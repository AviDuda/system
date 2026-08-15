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
  CreateFile,
  DeleteFile,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  RenameFile,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
} from "./client";
import { translateLocationUri, uriToFile } from "./client";
import type { PathMap } from "./devcontainer";

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
 * One collapsed line for diagnostics the agent has already seen, e.g.
 * `  unchanged: src/a.ts:10, 22, 45 (+2 more)`. Locations only — the messages
 * were shown before; this refreshes where they are. All diagnostics share one
 * file (the ledger is per-file), so the relPath appears once, then bare lines.
 * `line` is 1-based via range.start.line + 1, matching formatDiagnostic.
 */
export function formatUnchangedLine(diagnostics: Diagnostic[], relPath: string, cap = 6): string {
  const lines = diagnostics.map((d) => String(d.range.start.line + 1));
  const first = lines[0];
  const rest = lines.slice(1, cap).join(", ");
  const more = lines.length > cap ? ` (+${lines.length - cap} more)` : "";
  const linesPart = rest ? `${first}, ${rest}` : first;
  return `  unchanged: ${relPath}:${linesPart}${more}`;
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
export function normalizeLocations(result: unknown, map: PathMap | null = null): Location[] {
  if (!result) return [];
  const raw = Array.isArray(result) ? result : [result];
  const tr = (uri: string) => (map ? translateLocationUri(uri, map) : uri);
  return raw.flatMap((loc) => {
    if (loc && typeof loc === "object" && "uri" in loc) {
      const l = loc as Location;
      return [{ uri: tr(l.uri), range: l.range }];
    }
    if (loc && typeof loc === "object" && "targetUri" in loc) {
      const link = loc as LocationLink;
      return [{ uri: tr(link.targetUri), range: link.targetSelectionRange ?? link.targetRange }];
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

/**
 * LSP SymbolKind enum — the canonical numeric values servers send in
 * DocumentSymbol.kind. Stable since LSP 3.0; reproduced here from the
 * current spec so we reference kinds by name instead of magic numbers:
 * https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/#symbolKind
 */
const SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const;

/** Maps LSP SymbolKind enum values to human-readable labels. */
const SYMBOL_KINDS: Record<number, string> = {
  [SymbolKind.File]: "File",
  [SymbolKind.Module]: "Module",
  [SymbolKind.Namespace]: "Namespace",
  [SymbolKind.Package]: "Package",
  [SymbolKind.Class]: "Class",
  [SymbolKind.Method]: "Method",
  [SymbolKind.Property]: "Property",
  [SymbolKind.Field]: "Field",
  [SymbolKind.Constructor]: "Constructor",
  [SymbolKind.Enum]: "Enum",
  [SymbolKind.Interface]: "Interface",
  [SymbolKind.Function]: "Function",
  [SymbolKind.Variable]: "Variable",
  [SymbolKind.Constant]: "Constant",
  [SymbolKind.String]: "String",
  [SymbolKind.Number]: "Number",
  [SymbolKind.Boolean]: "Boolean",
  [SymbolKind.Array]: "Array",
  [SymbolKind.Object]: "Object",
  [SymbolKind.Key]: "Key",
  [SymbolKind.Null]: "Null",
  [SymbolKind.EnumMember]: "EnumMember",
  [SymbolKind.Struct]: "Struct",
  [SymbolKind.Event]: "Event",
  [SymbolKind.Operator]: "Operator",
  [SymbolKind.TypeParameter]: "TypeParameter",
};

/**
 * SymbolKinds that are structural containers — their children are themselves
 * declarations worth showing nested (methods on a class, fields on a struct,
 * variants of an enum, members of an interface, fns in a module/impl block).
 *
 * Every other kind is a body (function, method, property, field, constant,
 * variable, ...): LSP returns a scope tree for these, so their children are
 * local-scope noise (every const, every `.map()` callback, every destructured
 * property). Rendering that swamps the signal — one TS function can emit 200+
 * lines of locals. We render the body symbol itself but don't descend.
 *
 * This is the container/body axis tree-sitter skeleton tools (maki, ast-outline)
 * get implicitly from node-type selection. It is language-agnostic: the
 * distinction is structural and holds even when servers emit different
 * SymbolKind sets (rust-analyzer, tsserver, OmniSharp, ...). It only ever
 * drops body-locals, never declarations, so it's safe for languages we
 * haven't measured yet.
 */
const CONTAINER_KINDS = new Set<number>([
  SymbolKind.File, // root document
  SymbolKind.Module, // e.g. Rust `mod`
  SymbolKind.Namespace,
  SymbolKind.Package,
  SymbolKind.Class,
  SymbolKind.Enum, // children are EnumMembers
  SymbolKind.Interface, // children are methods/properties
  SymbolKind.Object, // e.g. Rust `impl` blocks
  SymbolKind.Struct, // children are fields
]);

/** Single-character icons for compact symbol display. Only the most common kinds. */
const SYMBOL_ICONS: Record<number, string> = {
  [SymbolKind.Class]: "C",
  [SymbolKind.Method]: "m",
  [SymbolKind.Property]: "p",
  [SymbolKind.Field]: "f",
  [SymbolKind.Constructor]: "K",
  [SymbolKind.Enum]: "E",
  [SymbolKind.Interface]: "I",
  [SymbolKind.Function]: "F",
  [SymbolKind.Variable]: "v",
  [SymbolKind.Constant]: "c",
  [SymbolKind.EnumMember]: "e",
  [SymbolKind.Struct]: "S",
  [SymbolKind.TypeParameter]: "T",
};

/**
 * 1-indexed line range string for a symbol's full extent (sym.range, which
 * covers doc comments and decorators, not the selectionRange name span).
 * Returns "line N" for single-line symbols, "lines S-E" otherwise.
 *
 * LSP range.end is exclusive: if it lands on a line boundary (character 0),
 * the last real line is the previous one, so we subtract rather than add 1.
 */
function symbolLineRange(sym: DocumentSymbol): string {
  const start = sym.range.start.line + 1;
  const rawEnd = sym.range.end.line + 1;
  const end = sym.range.end.character === 0 ? Math.max(start, rawEnd - 1) : rawEnd;
  return end <= start ? `line ${start}` : `lines ${start}-${end}`;
}

export function formatDocumentSymbol(sym: DocumentSymbol, indent = 0): string[] {
  const kind = SYMBOL_KINDS[sym.kind] ?? "Unknown";
  const icon = SYMBOL_ICONS[sym.kind] ?? "?";
  const detail = sym.detail ? ` — ${sym.detail}` : "";
  const prefix = " ".repeat(indent * 2);
  const lines = [`${prefix}[${icon}] ${sym.name} (${kind}) @ ${symbolLineRange(sym)}${detail}`];
  // Only descend into containers. Body kinds (Function, Method, Property,
  // Field, Constant, Variable, ...) carry local-scope children that are noise
  // — see CONTAINER_KINDS. Rendered as leaves here.
  if (sym.children && CONTAINER_KINDS.has(sym.kind)) {
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
 * Result of resolving a symbol position in a file.
 * Contains the 0-based line and column, plus whether the resolution succeeded.
 */
export interface ResolvedPosition {
  /** 0-based line number */
  line: number;
  /** 0-based column number */
  character: number;
  /** Whether the symbol was actually found at this position */
  found: boolean;
  /** Total occurrences of the symbol on the resolved line (for diagnostics) */
  occurrenceCount?: number;
  /** How the position was resolved (for error messages) */
  source?: "semantic" | "textual";
}

/** Escape a string for use in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find all word-boundary matches of `symbol` in a line. Returns column indices.
 * Word boundary = the symbol is surrounded by non-word characters or line edges.
 */
function findWordMatches(lineText: string, symbol: string): number[] {
  const re = new RegExp(`\\b${escapeRegex(symbol)}\\b`, "g");
  const indices: number[] = [];
  for (const match of lineText.matchAll(re)) {
    indices.push(match.index);
  }
  return indices;
}

/**
 * Search a DocumentSymbol tree for a symbol by name. Returns its selectionRange.
 * Searches depth-first, preferring the shallowest match.
 */
function findInSymbolTree(
  symbols: DocumentSymbol[],
  name: string,
  maxDepth = 10,
): { line: number; character: number } | null {
  if (maxDepth <= 0) return null;
  for (const sym of symbols) {
    if (sym.name === name) {
      return { line: sym.selectionRange.start.line, character: sym.selectionRange.start.character };
    }
    if (sym.children) {
      const found = findInSymbolTree(sym.children, name, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolve the position of a symbol in a file.
 *
 * Three resolution strategies (tried in order):
 * 1. Semantic (no line): if `documentSymbols` is provided and no `line` is specified,
 *    search the symbol tree by name. Uses `selectionRange` — the precise name span.
 *    This finds the declaration site, which is what you want for "find where X is defined."
 * 2. Textual (specific line): word-boundary match on the given line, occurrence N.
 *    This finds the usage site at the specified line, which is what you want for
 *    references/hover/type_definition at a specific usage.
 * 3. Textual (file-wide): if no line specified and no semantic match, first
 *    word-boundary match in file.
 *
 * Returns `found: false` when the symbol can't be located, so callers can
 * distinguish "not found" from "found at column 0".
 */
export function resolveSymbolPosition(
  filePath: string,
  line: number | undefined,
  symbol: string | undefined,
  occurrence?: number,
  documentSymbols?: DocumentSymbol[],
): ResolvedPosition {
  // No symbol: default to line start
  if (!symbol) {
    return { line: (line ?? 1) - 1, character: 0, found: false };
  }

  // Strategy 1: Semantic resolution from document symbol tree (only when no line specified)
  // When `line` is provided, the user is pointing at a specific usage site — use textual.
  if (line === undefined && documentSymbols && documentSymbols.length > 0) {
    const semantic = findInSymbolTree(documentSymbols, symbol);
    if (semantic) {
      return { line: semantic.line, character: semantic.character, found: true, source: "semantic" };
    }
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const fileLines = content.split("\n");

    // Strategy 2: Textual match on specific line
    if (line !== undefined) {
      const targetLine = fileLines[line - 1];

      const matches = targetLine ? findWordMatches(targetLine, symbol) : [];
      const occ = occurrence ?? 1;

      if (matches.length > 0 && occ <= matches.length) {
        return {
          line: line - 1,
          character: matches[occ - 1],
          found: true,
          occurrenceCount: matches.length,
          source: "textual",
        };
      }

      // Strategy 2b: Line is imprecise (symbol not on this line) — expand
      // outward from the given line to find the nearest textual match. More
      // predictable than semantic resolution (which can jump to a wrong symbol
      // when multiple share a name) and better than scanning from line 0
      // (which picks the first occurrence, not the nearest). Common case:
      // agent off by one, or pointing at a blank line after the declaration.
      if (matches.length === 0) {
        const maxDelta = Math.max(line - 1, fileLines.length - line);
        for (let d = 1; d <= maxDelta; d++) {
          for (const offset of [line - 1 - d, line - 1 + d]) {
            if (offset < 0 || offset >= fileLines.length) continue;
            const nearMatches = findWordMatches(fileLines[offset], symbol);
            if (nearMatches.length > 0) {
              return {
                line: offset,
                character: nearMatches[0],
                found: true,
                occurrenceCount: nearMatches.length,
                source: "textual",
              };
            }
          }
        }
      }

      // Strategy 2c: Symbol not found textually anywhere in the file. Last
      // resort: semantic resolution from the symbol tree. This handles the
      // case where the symbol name in the tree differs from its textual
      // representation (e.g., renamed import, macro expansion). Risk: if
      // multiple symbols share a name, picks the first in tree order, which
      // may not be what the agent intended.
      if (documentSymbols && documentSymbols.length > 0) {
        const semantic = findInSymbolTree(documentSymbols, symbol);
        if (semantic) {
          return { line: semantic.line, character: semantic.character, found: true, source: "semantic" };
        }
      }

      return { line: line - 1, character: 0, found: false, occurrenceCount: matches.length };
    }

    // Strategy 3: Textual match across entire file
    for (let i = 0; i < fileLines.length; i++) {
      const matches = findWordMatches(fileLines[i], symbol);
      if (matches.length > 0) {
        return { line: i, character: matches[0], found: true, source: "textual" };
      }
    }

    return { line: 0, character: 0, found: false };
  } catch {
    return { line: (line ?? 1) - 1, character: 0, found: false };
  }
}

// ── Workspace edit application ──

/**
 * Apply a set of TextEdits to one file on disk, in reverse order (end-to-start)
 * so character positions are preserved as each edit is applied.
 *
 * Returns the relative path and edit count on success. Throws on read/write
 * errors so callers can surface them.
 */
async function applyTextEdits(
  editUri: string,
  edits: TextEdit[],
  cwd: string,
  onFileWritten: (absolutePath: string) => void,
): Promise<{ path: string; count: number }> {
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
  onFileWritten(editPath);
  return { path: relPath, count: edits.length };
}

/**
 * Apply a WorkspaceEdit to files on disk.
 *
 * A WorkspaceEdit carries edits in two forms (per the LSP spec), and servers
 * differ in which they use:
 * - `changes`: a simple { uri → TextEdit[] } map.
 * - `documentChanges`: an ordered array of structured edits. rust-analyzer
 *   returns this form for `textDocument/rename` and most refactors; the
 *   `TextDocumentEdit` variant is the only one we apply.
 *
 * When BOTH are present, only `documentChanges` is applied (the spec says it
 * is authoritative and `changes` is legacy/optional). We apply per-file edits
 * in reverse order (end-to-start) to preserve character positions.
 *
 * Resource operations other than text edits (CreateFile/RenameFile/DeleteFile)
 * are collected into `unsupported` rather than executed, so callers can tell
 * the user the refix was only partially applied.
 *
 * @param edit - The WorkspaceEdit to apply
 * @param cwd - Current working directory for relative path reporting
 * @param onFileWritten - Callback invoked with each file's absolute path after writing.
 *   Used to sync modified content back to the LSP server via didChange.
 *   Pass a no-op `() => {}` if no sync is needed.
 * @returns Applied edits plus any unsupported resource operations.
 */
export async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  cwd: string,
  onFileWritten: (absolutePath: string) => void,
): Promise<{ applied: Array<{ path: string; count: number }>; unsupported: string[] }> {
  const applied: Array<{ path: string; count: number }> = [];
  const unsupported: string[] = [];

  // `documentChanges` is authoritative when present (LSP 3.x). rust-analyzer
  // uses it for rename; tsserver uses `changes`. Applying both would double-apply.
  if (edit.documentChanges && edit.documentChanges.length > 0) {
    for (const change of edit.documentChanges) {
      if (typeof change !== "object" || change === null) continue;
      if ("kind" in change) {
        // CreateFile/RenameFile/DeleteFile. Move-to-file returns a CreateFile
        // followed by a TextDocumentEdit that fills the created file, so run
        // these in documentChanges order (create, then fill). Text-syncing to
        // LSP happens via the following TextDocumentEdit's onFileWritten.
        const op = applyResourceOp(change as CreateFile | RenameFile | DeleteFile, cwd);
        if (op) {
          applied.push(op);
          continue;
        }
        const uri = "uri" in change ? change.uri : "oldUri" in change ? change.oldUri : "?";
        unsupported.push(`${change.kind}: ${path.relative(cwd, uriToFile(uri))}`);
        continue;
      }
      // TextDocumentEdit
      if ("textDocument" in change && "edits" in change) {
        const td = change as { textDocument: { uri: string }; edits: TextEdit[] };
        applied.push(await applyTextEdits(td.textDocument.uri, td.edits, cwd, onFileWritten));
      }
    }
    return { applied, unsupported };
  }

  /** Execute an LSP file resource op (create/rename/delete) on disk. Returns the
   * applied record, or null for an unknown shape. Creates target parent dirs; a
   * no-op create (file already exists) leaves content intact; a rename whose
   * source is missing is a no-op. */
  function applyResourceOp(
    change: CreateFile | RenameFile | DeleteFile,
    cwd: string,
  ): { path: string; count: number } | null {
    if (change.kind === "create") {
      const fp = uriToFile(change.uri);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      if (!fs.existsSync(fp)) fs.writeFileSync(fp, "", "utf-8");
      return { path: path.relative(cwd, fp), count: 1 };
    }
    if (change.kind === "rename") {
      const oldFp = uriToFile(change.oldUri);
      const newFp = uriToFile(change.newUri);
      fs.mkdirSync(path.dirname(newFp), { recursive: true });
      if (fs.existsSync(oldFp)) fs.renameSync(oldFp, newFp);
      return { path: path.relative(cwd, newFp), count: 1 };
    }
    if (change.kind === "delete") {
      const fp = uriToFile(change.uri);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      return { path: path.relative(cwd, fp), count: 1 };
    }
    return null;
  }

  if (edit.changes) {
    for (const [editUri, edits] of Object.entries(edit.changes)) {
      applied.push(await applyTextEdits(editUri, edits, cwd, onFileWritten));
    }
  }

  return { applied, unsupported };
}
