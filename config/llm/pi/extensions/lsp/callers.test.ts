import { describe, expect, test } from "bun:test";
import {
  changedLines,
  formatCallerLocation,
  formatCallerWarnings,
  isEditedLineCaller,
  MAX_CALLER_SYMBOLS,
  touchedSymbols,
} from "./callers";
import type { DocumentSymbol } from "./client";

function sym(name: string, startLine: number, endLine: number): DocumentSymbol {
  return {
    name,
    kind: 12,
    range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 0 } },
    selectionRange: { start: { line: startLine, character: 0 }, end: { line: startLine, character: 1 } },
  };
}

describe("touchedSymbols", () => {
  const symbols = [sym("alpha", 0, 2), sym("beta", 3, 6), sym("gamma", 7, 9)];

  test("empty changed lines → no symbols", () => {
    expect(touchedSymbols(symbols, [])).toEqual([]);
  });

  test("a change inside a symbol's range touches that symbol", () => {
    // beta spans 1-based lines 4-7; changing line 5 touches beta.
    const touched = touchedSymbols(symbols, [5]);
    expect(touched.map((s) => s.name)).toEqual(["beta"]);
  });

  test("a change on the boundary line touches the containing symbol", () => {
    // line 4 1-based = beta start (0-based 3). Boundary inclusive.
    expect(touchedSymbols(symbols, [4]).map((s) => s.name)).toEqual(["beta"]);
  });

  test("multiple changed lines across symbols touch each", () => {
    const touched = touchedSymbols(symbols, [1, 5, 9]);
    expect(touched.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("changed lines above all symbols touch nothing", () => {
    expect(touchedSymbols(symbols, [999])).toEqual([]);
  });
});

describe("changedLines", () => {
  test("wraps the shared diff", () => {
    expect(changedLines("a\nb\nc\n", "a\nX\nc\n")).toEqual([2]);
    expect(changedLines("a\nb\n", "a\nb\n")).toEqual([]);
  });
});

describe("formatCallerWarnings", () => {
  test("renders a bounded caller list with an overflow count", () => {
    const out = formatCallerWarnings("ts", "src/util.ts", [
      { name: "doThing", line: 4, callers: ["src/api.ts:2", "src/app.ts:10"], totalCallers: 3 },
      { name: "noCallers", line: 9, callers: [], totalCallers: 0 },
    ]);
    expect(out).toContain("[LSP callers (ts): 2 symbol(s) changed");
    expect(out).toContain("doThing (src/util.ts:4): src/api.ts:2, src/app.ts:10 (+1 more)");
    expect(out).toContain("noCallers (src/util.ts:9): (no call sites)");
  });
});

describe("formatCallerLocation", () => {
  test("relative path with 1-based line", () => {
    expect(formatCallerLocation("/work/x/proj/src/a.ts", 0, "/work/x/proj")).toBe("src/a.ts:1");
  });
});

describe("isEditedLineCaller", () => {
  const abs = "/work/proj/a.ts";
  const changed = [2, 5, 17]; // 1-based new-side

  test("same-file caller on a changed line → edited (skip)", () => {
    // 0-based line 1 → 1-based 2, which is in `changed`.
    expect(isEditedLineCaller(abs, 1, abs, changed)).toBe(true);
    expect(isEditedLineCaller("/work/proj/a.ts", 4, abs, changed)).toBe(true);
  });

  test("same-file caller on an unchanged line → keep", () => {
    expect(isEditedLineCaller(abs, 3, abs, changed)).toBe(false); // 1-based 4
  });

  test("cross-file caller is never edited (diff lines can't collide)", () => {
    expect(isEditedLineCaller("/work/proj/b.ts", 1, abs, changed)).toBe(false);
  });

  test("empty changed list → never edited", () => {
    expect(isEditedLineCaller(abs, 1, abs, [])).toBe(false);
  });
});

describe("caps", () => {
  test("MAX_CALLER_SYMBOLS is a positive constant", () => {
    expect(MAX_CALLER_SYMBOLS).toBeGreaterThan(0);
  });
});
