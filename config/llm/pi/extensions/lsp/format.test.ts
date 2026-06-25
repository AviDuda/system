import { describe, expect, test } from "bun:test";
import type { Diagnostic, DocumentSymbol, Location } from "./client";
import {
  extractHoverText,
  formatDiagnostic,
  formatDiagnosticsSummary,
  formatDocumentSymbol,
  formatLocation,
  normalizeLocations,
  resolveSymbolPosition,
  sortDiagnostics,
} from "./format";

describe("formatDiagnostic", () => {
  test("formats error with source and code", () => {
    const d: Diagnostic = {
      range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } },
      severity: 1,
      source: "ts",
      code: 2345,
      message: "Argument of type 'string' is not assignable",
    };
    expect(formatDiagnostic(d, "src/main.ts")).toBe(
      "src/main.ts:10:5 [error] (ts) [2345] Argument of type 'string' is not assignable",
    );
  });

  test("formats warning without source", () => {
    const d: Diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 2,
      message: "Unused variable",
    };
    expect(formatDiagnostic(d, "lib.ts")).toBe("lib.ts:1:1 [warning] Unused variable");
  });

  test("defaults to info when severity missing", () => {
    const d: Diagnostic = {
      range: { start: { line: 3, character: 2 }, end: { line: 3, character: 8 } },
      message: "Something",
    };
    expect(formatDiagnostic(d, "x.ts")).toContain("[info]");
  });
});

describe("formatDiagnosticsSummary", () => {
  test("summarizes mixed diagnostics", () => {
    const diags: Diagnostic[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 1, message: "a" },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 1, message: "b" },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 2, message: "c" },
    ];
    expect(formatDiagnosticsSummary(diags)).toBe("2 errors, 1 warning");
  });

  test("returns no issues for empty array", () => {
    expect(formatDiagnosticsSummary([])).toBe("no issues");
  });
});

describe("sortDiagnostics", () => {
  test("errors before warnings, then by line", () => {
    const diags: Diagnostic[] = [
      { range: { start: { line: 10, character: 0 }, end: { line: 10, character: 0 } }, severity: 2, message: "warn" },
      { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 0 } }, severity: 1, message: "err" },
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, severity: 1, message: "err2" },
    ];
    sortDiagnostics(diags);
    expect(diags.map((d) => d.message)).toEqual(["err2", "err", "warn"]);
  });
});

describe("formatLocation", () => {
  test("formats relative path with line and column", () => {
    const loc: Location = {
      uri: "file:///home/user/project/src/main.ts",
      range: { start: { line: 41, character: 8 }, end: { line: 41, character: 20 } },
    };
    expect(formatLocation(loc, "/home/user/project")).toBe("src/main.ts:42:9");
  });
});

describe("normalizeLocations", () => {
  test("handles single Location", () => {
    const loc: Location = {
      uri: "file:///a.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    };
    expect(normalizeLocations(loc)).toEqual([loc]);
  });

  test("handles LocationLink", () => {
    const link = {
      targetUri: "file:///b.ts",
      targetRange: { start: { line: 10, character: 0 }, end: { line: 15, character: 0 } },
      targetSelectionRange: { start: { line: 10, character: 4 }, end: { line: 10, character: 10 } },
    };
    const result = normalizeLocations(link);
    expect(result).toHaveLength(1);
    expect(result[0].uri).toBe("file:///b.ts");
    expect(result[0].range).toEqual(link.targetSelectionRange);
  });

  test("handles null", () => {
    expect(normalizeLocations(null)).toEqual([]);
  });

  test("handles array", () => {
    const locs: Location[] = [
      { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
      { uri: "file:///b.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } } },
    ];
    expect(normalizeLocations(locs)).toHaveLength(2);
  });
});

describe("extractHoverText", () => {
  test("extracts from string", () => {
    expect(extractHoverText("hello")).toBe("hello");
  });

  test("extracts from MarkupContent", () => {
    expect(extractHoverText({ kind: "markdown", value: "## Type\n`string`" })).toBe("## Type\n`string`");
  });

  test("extracts from array", () => {
    expect(extractHoverText(["one", { kind: "markdown", value: "two" }])).toBe("one\n\ntwo");
  });
});

describe("formatDocumentSymbol", () => {
  test("formats with children", () => {
    const sym: DocumentSymbol = {
      name: "MyClass",
      kind: 5,
      range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
      selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
      children: [
        {
          name: "constructor",
          kind: 9,
          range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
          selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 13 } },
        },
      ],
    };
    const lines = formatDocumentSymbol(sym);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("MyClass");
    expect(lines[0]).toContain("Class");
    expect(lines[1]).toContain("constructor");
    expect(lines[1]).toMatch(/^\s{2}/); // indented
  });

  // Container/body filter: LSP returns a scope tree, but we only want
  // declarations. Bodies (functions/methods/properties/fields) carry
  // local-scope children that are noise; containers (class/interface/struct/
  // enum/module/object) carry declarations worth nesting. See CONTAINER_KINDS.
  test("does not descend into function body locals", () => {
    // Mirrors the tsserver failure mode: a function whose children are every
    // local const and every `.map()` callback. These must not be rendered.
    const sym: DocumentSymbol = {
      name: "runSingleAgent",
      kind: 12, // Function — body, not a container
      range: { start: { line: 242, character: 0 }, end: { line: 800, character: 0 } },
      selectionRange: { start: { line: 242, character: 9 }, end: { line: 242, character: 25 } },
      children: [
        {
          name: "proc",
          kind: 14, // Constant — local scope
          range: { start: { line: 468, character: 8 }, end: { line: 468, character: 20 } },
          selectionRange: { start: { line: 468, character: 8 }, end: { line: 468, character: 12 } },
        },
        {
          name: "map callback",
          kind: 12, // nested Function — local scope
          range: { start: { line: 500, character: 10 }, end: { line: 510, character: 6 } },
          selectionRange: { start: { line: 500, character: 10 }, end: { line: 500, character: 14 } },
        },
      ],
    };
    const lines = formatDocumentSymbol(sym);
    expect(lines).toHaveLength(1); // the function only — no locals
    expect(lines[0]).toContain("runSingleAgent");
    expect(lines.join("\n")).not.toContain("proc");
    expect(lines.join("\n")).not.toContain("map callback");
  });

  test("descends into interface members", () => {
    const sym: DocumentSymbol = {
      name: "UsageStats",
      kind: 11, // Interface — container
      range: { start: { line: 41, character: 0 }, end: { line: 49, character: 1 } },
      selectionRange: { start: { line: 41, character: 10 }, end: { line: 41, character: 21 } },
      children: [
        {
          name: "input",
          kind: 7, // Property — declaration, rendered as a leaf
          range: { start: { line: 42, character: 2 }, end: { line: 42, character: 15 } },
          selectionRange: { start: { line: 42, character: 2 }, end: { line: 42, character: 7 } },
        },
        {
          name: "output",
          kind: 7,
          range: { start: { line: 43, character: 2 }, end: { line: 43, character: 16 } },
          selectionRange: { start: { line: 43, character: 2 }, end: { line: 43, character: 8 } },
        },
      ],
    };
    const lines = formatDocumentSymbol(sym);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("UsageStats");
    expect(lines[1]).toContain("input");
    expect(lines[2]).toContain("output");
    expect(lines[1]).toMatch(/^\s{2}/); // indented under interface
  });

  test("descends into struct fields (rust-analyzer shape)", () => {
    const sym: DocumentSymbol = {
      name: "Click",
      kind: 23, // Struct — container
      range: { start: { line: 47, character: 0 }, end: { line: 63, character: 1 } },
      selectionRange: { start: { line: 47, character: 7 }, end: { line: 47, character: 12 } },
      children: [
        {
          name: "target",
          kind: 8, // Field — declaration, rendered as a leaf
          range: { start: { line: 49, character: 4 }, end: { line: 49, character: 18 } },
          selectionRange: { start: { line: 49, character: 4 }, end: { line: 49, character: 10 } },
        },
      ],
    };
    const lines = formatDocumentSymbol(sym);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Click");
    expect(lines[1]).toContain("target");
  });

  test("shows start-end range for multi-line symbols (range.end exclusive at line boundary)", () => {
    // Closing brace on 1-indexed line 5; server sends end at start of next line
    // (character 0). Must report "3-5", not "3-6".
    const sym: DocumentSymbol = {
      name: "main",
      kind: 12, // Function
      range: { start: { line: 2, character: 0 }, end: { line: 5, character: 0 } },
      selectionRange: { start: { line: 2, character: 3 }, end: { line: 2, character: 7 } },
    };
    expect(formatDocumentSymbol(sym)[0]).toContain("@ lines 3-5");
  });

  test("shows single line for one-line symbols", () => {
    const sym: DocumentSymbol = {
      name: "MAX",
      kind: 14, // Constant
      range: { start: { line: 17, character: 6 }, end: { line: 17, character: 48 } },
      selectionRange: { start: { line: 17, character: 6 }, end: { line: 17, character: 9 } },
    };
    expect(formatDocumentSymbol(sym)[0]).toContain("@ line 18");
  });
});

describe("resolveSymbolPosition", () => {
  test("returns found=false with no symbol", () => {
    const result = resolveSymbolPosition("/nonexistent", undefined, undefined);
    expect(result.found).toBe(false);
    expect(result.line).toBe(0);
    expect(result.character).toBe(0);
  });

  test("returns found=false for nonexistent file", () => {
    const result = resolveSymbolPosition("/nonexistent", 1, "foo");
    expect(result.found).toBe(false);
  });

  test("finds symbol on line in real file", () => {
    // Use this test file itself — we know 'describe' appears on line 1 area
    const result = resolveSymbolPosition(import.meta.path, 1, "describe");
    expect(result.found).toBe(true);
    expect(result.character).toBeGreaterThanOrEqual(0);
  });

  test("searches entire file when no line specified", () => {
    const result = resolveSymbolPosition(import.meta.path, undefined, "resolveSymbolPosition");
    expect(result.found).toBe(true);
    expect(result.line).toBeGreaterThan(0);
  });

  test("returns found=false for symbol not in file", () => {
    // Generate a random string at runtime so it can't appear in the source
    const randomSymbol = `sym_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const result = resolveSymbolPosition(import.meta.path, undefined, randomSymbol);
    expect(result.found).toBe(false);
  });

  test("falls back to nearest textual match when line is wrong", () => {
    // Simulates: symbol on line N, agent asks for N+1 (blank line). The
    // outward scan finds the nearest textual match.
    const result = resolveSymbolPosition(import.meta.path, 2, "resolveSymbolPosition");
    expect(result.found).toBe(true);
    // Line 2 is near line 1 where describe() uses it, so the nearest match
    // should be close to the provided line (not jumping to line 300+).
    expect(result.line).toBeLessThan(50); // near the top of the file
  });

  test("falls back to semantic resolution when symbol not in file textually", () => {
    // Symbol exists in doc-symbols tree but not as text in the file
    // (e.g., macro expansion, renamed import). This is the only case where
    // semantic resolution is used as a fallback.
    const docSymbols: DocumentSymbol[] = [
      {
        name: "IconClassParser",
        kind: 23, // Struct
        range: { start: { line: 10, character: 0 }, end: { line: 50, character: 1 } },
        selectionRange: { start: { line: 10, character: 11 }, end: { line: 10, character: 27 } },
      },
    ];
    const randomSymbol = `sym_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const result = resolveSymbolPosition(import.meta.path, 12, randomSymbol, undefined, docSymbols);
    expect(result.found).toBe(false); // not in file textually AND not in doc symbols by this name
  });
});
