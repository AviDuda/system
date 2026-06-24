import { describe, expect, test } from "bun:test";
import {
  closestMatches,
  contextLines,
  countApplied,
  describeDiagnosis,
  detectBoundaryDuplication,
  diagnoseLineDiff,
  findNearMisses,
  formatClosestMatches,
  formatHitsWithContext,
  formatOutcomes,
  numberedLines,
  similarity,
} from "./diagnostics";
import { type MatchHit, planAll } from "./match";

function hit(line: number, lineCount = 1): MatchHit {
  return { line, lineCount, kind: "exact", fileIndent: "" };
}

// ── similarity ─────────────────────────────────────────────────────────────

describe("similarity", () => {
  test("identical strings score 1", () => {
    expect(similarity("hello world", "hello world")).toBe(1);
  });
  test("whitespace-only difference scores high", () => {
    expect(similarity("foo bar baz", "foo  bar  baz")).toBeGreaterThan(0.9);
  });
  test("unrelated strings score low", () => {
    expect(similarity("completely different", "zzzzzzzzzzzz")).toBeLessThan(0.2);
  });
  test("empty vs non-empty scores 0", () => {
    expect(similarity("", "abc")).toBe(0);
  });
  test("case-insensitive", () => {
    expect(similarity("Hello", "hello")).toBe(1);
  });
});

// ── numberedLines / contextLines ───────────────────────────────────────────

describe("numberedLines", () => {
  test("assigns 1-based numbers", () => {
    expect(numberedLines("a\nb\nc")).toEqual([
      { num: 1, text: "a" },
      { num: 2, text: "b" },
      { num: 3, text: "c" },
    ]);
  });
  test("drops trailing empty line from final newline", () => {
    expect(numberedLines("a\n")).toEqual([{ num: 1, text: "a" }]);
  });
});

describe("contextLines", () => {
  test("returns lines around target with context", () => {
    const content = "l1\nl2\nl3\nl4\nl5";
    const ctx = contextLines(content, 3, 1);
    expect(ctx.map((l) => l.num)).toEqual([2, 3, 4]);
  });
  test("clamps to file bounds", () => {
    const content = "l1\nl2\nl3";
    expect(contextLines(content, 1, 5).map((l) => l.num)).toEqual([1, 2, 3]);
  });
});

// ── closestMatches ─────────────────────────────────────────────────────────

describe("closestMatches", () => {
  test("finds the most similar window", () => {
    const content = "def alpha():\n    pass\ndef beta():\n    return 1";
    const matches = closestMatches(content, "def alpha():\n    pass");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.line).toBe(1);
    expect(matches[0]?.similarity).toBeGreaterThan(0.8);
  });

  test("returns empty when nothing is similar enough", () => {
    const content = "a\nb\nc";
    expect(closestMatches(content, "zzzzzzzzzzz")).toHaveLength(0);
  });

  test("ranks by similarity descending", () => {
    const content = "function foo() {}\nfunction bar() {}\nconst x = 1";
    const matches = closestMatches(content, "function foo() {}", 3);
    if (matches.length >= 2) {
      expect(matches[0]?.similarity).toBeGreaterThanOrEqual(matches[1]?.similarity ?? 0);
    }
  });
});

describe("formatClosestMatches", () => {
  test("handles empty matches", () => {
    const text = formatClosestMatches([]);
    expect(text).toContain("No similar text");
  });
  test("includes percentage and line numbers", () => {
    const content = "function foo() {}\nconst y = 2";
    const matches = closestMatches(content, "function foo() {}");
    const text = formatClosestMatches(matches);
    expect(text).toContain("% similar");
    expect(text).toContain("Lines");
  });
  test("shows structured diagnosis (whitespace vs content)", () => {
    // File uses tabs; oldText uses spaces — content identical, whitespace differs.
    const content = "\tfoo()\n\tbar()";
    const matches = closestMatches(content, "  foo()\n  bar()");
    const text = formatClosestMatches(matches);
    expect(text).toContain("whitespace");
    expect(text).toContain("content looks right");
  });
});

// ── diagnoseLineDiff (LCS line-level diagnosis) ───────────────────────────

describe("diagnoseLineDiff", () => {
  test("identical text → all zero", () => {
    const d = diagnoseLineDiff("a\nb\nc", "a\nb\nc");
    expect(d).toEqual({ whitespaceOnly: 0, contentDiffer: 0, missingFromOldText: 0, extraInOldText: 0 });
  });

  test("whitespace-only difference (tabs vs spaces)", () => {
    const d = diagnoseLineDiff("  foo\n  bar", "\tfoo\n\tbar");
    expect(d.whitespaceOnly).toBeGreaterThan(0);
    expect(d.contentDiffer).toBe(0);
  });

  test("trailing-whitespace-only difference", () => {
    const d = diagnoseLineDiff("foo   \nbar", "foo\nbar");
    expect(d.whitespaceOnly).toBeGreaterThan(0);
    expect(d.contentDiffer).toBe(0);
  });

  test("content difference", () => {
    const d = diagnoseLineDiff("foo\nbar\nbaz", "foo\nQUX\nbaz");
    expect(d.contentDiffer).toBeGreaterThan(0);
    expect(d.whitespaceOnly).toBe(0);
  });

  test("window has lines oldText lacks (oldText too short)", () => {
    const d = diagnoseLineDiff("foo\nbar", "foo\nbar\nbaz");
    expect(d.missingFromOldText).toBeGreaterThan(0);
  });

  test("oldText has lines the window lacks (oldText too long)", () => {
    const d = diagnoseLineDiff("foo\nbar\nbaz", "foo\nbar");
    expect(d.extraInOldText).toBeGreaterThan(0);
  });

  test("mixed: one whitespace line + one content line", () => {
    const d = diagnoseLineDiff("  foo\nbar", "\tfoo\nQUX");
    expect(d.whitespaceOnly).toBeGreaterThan(0);
    expect(d.contentDiffer).toBeGreaterThan(0);
  });
});

describe("describeDiagnosis", () => {
  test("empty → 'identical'", () => {
    expect(describeDiagnosis({ whitespaceOnly: 0, contentDiffer: 0, missingFromOldText: 0, extraInOldText: 0 })).toBe(
      "identical",
    );
  });
  test("whitespace-only → mentions whitespace, not content", () => {
    const s = describeDiagnosis({ whitespaceOnly: 2, contentDiffer: 0, missingFromOldText: 0, extraInOldText: 0 });
    expect(s).toContain("whitespace");
    expect(s).not.toContain("content");
  });
  test("lists each non-zero category", () => {
    const s = describeDiagnosis({ whitespaceOnly: 1, contentDiffer: 2, missingFromOldText: 1, extraInOldText: 0 });
    expect(s).toContain("1 line");
    expect(s).toContain("whitespace");
    expect(s).toContain("2 line");
    expect(s).toContain("actual text");
    expect(s).toContain("missing 1");
    expect(s).not.toContain("extra");
  });
});

// ── findNearMisses ───────────────────────────────────────────────────────

describe("findNearMisses", () => {
  test("finds normalized-equal occurrences excluded from exact hits", () => {
    // 4-space version matches exactly, 2-space version is a near-miss.
    const content = "  result = validate(data)\n    result = validate(data)\n    result = validate(data)";
    const exactLines = new Set([2, 3]); // lines 2,3 are exact (4-space)
    const miss = findNearMisses(content, "    result = validate(data)", exactLines);
    expect(miss).toHaveLength(1);
    expect(miss[0]?.line).toBe(1);
    expect(miss[0]?.text).toContain("  result = validate(data)");
  });

  test("returns empty when normalization doesn't change oldText", () => {
    const content = "foo\nfoo";
    // normalizeForFuzzyMatch("foo") === "foo", so no near-misses possible.
    expect(findNearMisses(content, "foo", new Set([1]))).toHaveLength(0);
  });

  test("excludes windows overlapping exact hits", () => {
    const content = "foo\nfoo\nfoo";
    const miss = findNearMisses(content, "foo", new Set([1, 2, 3]));
    expect(miss).toHaveLength(0);
  });

  test("finds multi-line near-misses", () => {
    const content = "  if (x) {\n    return 1;\n  }\nif (x) {\n  return 1;\n}";
    const exactLines = new Set([1, 2, 3]); // 2-space version on lines 1-3
    const miss = findNearMisses(content, "  if (x) {\n    return 1;\n  }", exactLines);
    expect(miss).toHaveLength(1);
    expect(miss[0]?.line).toBe(4);
  });
});

// ── formatOutcomes (near-miss case) ──────────────────────────────────────

describe("formatOutcomes near-miss diagnostic", () => {
  test("ambiguous outcome includes normalized-equal near-misses", () => {
    // 4-space indent matches exactly at lines 2,3; 2-space indent at line 1 is a near-miss.
    const content = "  result = validate(data)\n    result = validate(data)\n    result = validate(data)";
    const plan = planAll(content, [{ oldText: "    result = validate(data)", newText: "x" }]);
    const messages = formatOutcomes(content, plan, [{ oldText: "    result = validate(data)" }]);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("2 occurrences");
    // Near-miss should be mentioned.
    expect(messages[0]).toContain("normalized-equal");
  });
});

// ── formatHitsWithContext ──────────────────────────────────────────────────

describe("formatHitsWithContext", () => {
  test("marks the hit line with >>", () => {
    const content = "l1\nl2\nl3\nl4\nl5";
    const text = formatHitsWithContext(content, [hit(3)]);
    expect(text).toContain(">> 3: l3");
    expect(text).toContain("   1: l1"); // context lines have "  " marker
  });
});

// ── formatOutcomes ─────────────────────────────────────────────────────────

describe("formatOutcomes", () => {
  test("no-match outcome includes closest matches", () => {
    const content = "def foo():\n    return 1";
    const plan = planAll(content, [{ oldText: "def foo():\n    return 99", newText: "x" }]);
    const messages = formatOutcomes(content, plan, [{ oldText: "def foo():\n    return 99" }]);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("not found");
  });

  test("ambiguous outcome includes occurrences with context", () => {
    const content = "x = 1\nx = 1";
    const plan = planAll(content, [{ oldText: "x = 1", newText: "x = 2" }]);
    const messages = formatOutcomes(content, plan, [{ oldText: "x = 1" }]);
    expect(messages[0]).toContain("2 occurrences");
    expect(messages[0]).toContain("anchor");
  });

  test("applied outcomes produce no message", () => {
    const content = "foo\nbar";
    const plan = planAll(content, [{ oldText: "foo", newText: "FOO" }]);
    expect(formatOutcomes(content, plan, [{ oldText: "foo" }])).toHaveLength(0);
  });

  test("no-op outcome produces a self-contained message", () => {
    const content = "let scale_factor = output_sf;\n";
    const plan = planAll(content, [
      { oldText: "let scale_factor = output_sf;", newText: "let scale_factor = output_sf;" },
    ]);
    const messages = formatOutcomes(content, plan, [{ oldText: "let scale_factor = output_sf;" }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("no-op");
    expect(messages[0]).toContain("identical");
  });
});

// ── detectBoundaryDuplication ──────────────────────────────────────────────

describe("detectBoundaryDuplication", () => {
  test("detects before-edge duplication", () => {
    const content = "line A\nline B\nline C";
    // Replacing line B (hit at line 2) but newText starts with "line A".
    const result = detectBoundaryDuplication(content, hit(2, 1), "line A\nline B CHANGED");
    expect(result?.edge).toBe("before");
    expect(result?.neighborLine).toBe(1);
  });

  test("detects after-edge duplication", () => {
    const content = "line A\nline B\nline C";
    // Replacing line B but newText ends with "line C".
    const result = detectBoundaryDuplication(content, hit(2, 1), "line B CHANGED\nline C");
    expect(result?.edge).toBe("after");
    expect(result?.neighborLine).toBe(3);
  });

  test("no duplication returns null", () => {
    const content = "line A\nline B\nline C";
    expect(detectBoundaryDuplication(content, hit(2, 1), "line B CHANGED")).toBeNull();
  });

  test("catches lone closing brace duplication (the doubled-brace case)", () => {
    const content = "  foo()\n}\n  bar()";
    // Replacing `  foo()` but newText ends with `}` — the neighbor-after line.
    // No punctuation exemption: for oldText-exact-match this is always a
    // duplicate (oldText didn't include the `}`, so it stays on disk).
    const result = detectBoundaryDuplication(content, hit(1, 1), "  REPLACED\n}");
    expect(result?.edge).toBe("after");
    expect(result?.neighborLine).toBe(2);
  });

  test("flags braces with content", () => {
    const content = "} else {\n  target line\nnext";
    // The line before the hit (line 2) is "} else {" — brace WITH content,
    // so repeating it in newText is flagged.
    const result = detectBoundaryDuplication(content, hit(2, 1), "} else {\n  REPLACED");
    expect(result?.edge).toBe("before");
  });
});

// ── countApplied ───────────────────────────────────────────────────────────

describe("countApplied", () => {
  test("counts distinct edit indices and total occurrences", () => {
    const plan = planAll("a\nb\na", [
      { oldText: "a", newText: "x", replaceAll: true },
      { oldText: "b", newText: "y" },
    ]);
    const { edits, occurrences } = countApplied(plan.replacements);
    expect(edits).toBe(2);
    expect(occurrences).toBe(3); // 2 from replaceAll + 1
  });
});
