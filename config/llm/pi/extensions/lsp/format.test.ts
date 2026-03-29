import { describe, expect, test } from "bun:test";
import type { Diagnostic, DocumentSymbol, Location } from "./client";
import {
  extractHoverText,
  formatDiagnostic,
  formatDiagnosticsSummary,
  formatDocumentSymbol,
  formatLocation,
  normalizeLocations,
  resolveSymbolColumn,
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
});

describe("resolveSymbolColumn", () => {
  test("returns 0 when no symbol", () => {
    expect(resolveSymbolColumn("/nonexistent", 1)).toBe(0);
  });

  test("returns 0 for nonexistent file", () => {
    expect(resolveSymbolColumn("/nonexistent", 1, "foo")).toBe(0);
  });
});
