/**
 * Equivalence tests: the vendored matcher in edit-match.ts must behave exactly
 * like pi's internal edit-diff.js for every input shape, so previews predict
 * what the built-in edit tool will do. Pi's implementation is located at test
 * time (env override, package alias, brew/npm layouts); the equivalence suite
 * skips when no install is found.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  applyEditsToNormalizedContent,
  type EditOp,
  fuzzyFindText,
  normalizeToLF,
  resolveEditPath,
} from "./edit-match";

// --- Always-on unit tests ---

describe("resolveEditPath", () => {
  const cwd = "/tmp/proj";
  it("joins relative onto cwd", () => {
    expect(resolveEditPath("src/a.ts", cwd)).toBe("/tmp/proj/src/a.ts");
  });
  it("keeps absolute", () => {
    expect(resolveEditPath("/etc/hosts", cwd)).toBe("/etc/hosts");
  });
  it("strips @ prefix", () => {
    expect(resolveEditPath("@src/a.ts", cwd)).toBe("/tmp/proj/src/a.ts");
  });
  it("expands ~ and ~/ forms", () => {
    expect(resolveEditPath("~", cwd)).toBe(homedir());
    expect(resolveEditPath("~/x.txt", cwd)).toBe(join(homedir(), "x.txt"));
  });
  it("normalizes unicode spaces in path", () => {
    expect(resolveEditPath("my\u00A0file.ts", cwd)).toBe("/tmp/proj/my file.ts");
  });
  it("converts file:// URLs", () => {
    expect(resolveEditPath("file:///etc/hosts", cwd)).toBe("/etc/hosts");
  });
});

describe("fuzzyFindText", () => {
  it("exact match wins", () => {
    expect(fuzzyFindText("hello world", "world")).toMatchObject({ found: true, index: 6, usedFuzzyMatch: false });
  });
  it("falls back to fuzzy space", () => {
    expect(fuzzyFindText("say \u201Chello\u201D", 'say "hello"')).toMatchObject({ found: true, usedFuzzyMatch: true });
  });
  it("misses stay misses", () => {
    expect(fuzzyFindText("abc", "xyz").found).toBe(false);
  });
});

describe("normalizeToLF", () => {
  it("handles crlf and lone cr", () => {
    expect(normalizeToLF("a\r\nb\rc")).toBe("a\nb\nc");
  });
});

// --- Equivalence against pi's compiled implementation ---

/** Shape of the internal module we depend on (only what the tests use). */
interface PiEditDiffModule {
  applyEditsToNormalizedContent(
    content: string,
    edits: EditOp[],
    path: string,
  ): { baseContent: string; newContent: string };
  generateDiffString(oldContent: string, newContent: string): { diff: string; firstChangedLine?: number };
  computeEditsDiff(
    path: string,
    edits: EditOp[],
    cwd: string,
  ): Promise<{ diff: string; firstChangedLine?: number } | { error: string }>;
}

function installedPiRoots(): string[] {
  const roots: string[] = [];
  const pushIf = (root?: string) => {
    if (!root) return;
    const pkg = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(join(pkg, "dist", "core", "tools", "edit-diff.js"))) roots.push(pkg);
  };
  const tryCmd = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf-8" }).trim();
    } catch {
      return undefined;
    }
  };
  pushIf(tryCmd("npm", ["root", "-g"]));
  const brewPrefix = tryCmd("brew", ["--prefix", "pi-coding-agent"]);
  if (brewPrefix) pushIf(join(brewPrefix, "lib"));
  for (const opt of ["/opt/homebrew/opt", "/home/linuxbrew/.linuxbrew/opt"]) {
    pushIf(join(opt, "pi-coding-agent", "libexec", "lib"));
  }
  for (const rel of [".nix-profile", ".local/share/npm", ".npm-global"]) pushIf(join(homedir(), rel));
  return [...new Set(roots)];
}

async function loadReal(): Promise<PiEditDiffModule | null> {
  const direct = process.env.PI_EDIT_DIFF;
  if (direct && existsSync(direct)) return (await import(direct)) as PiEditDiffModule;
  try {
    const spec = "@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js";
    return (await import(spec)) as PiEditDiffModule;
  } catch {
    // fall through to filesystem scan
  }
  for (const pkg of installedPiRoots()) {
    return (await import(join(pkg, "dist", "core", "tools", "edit-diff.js"))) as PiEditDiffModule;
  }
  return null;
}

const loadedReal = await loadReal();
const describeEq = loadedReal ? describe : describe.skip;

describeEq("edit-match vs pi edit-diff.js", () => {
  // Suite body executes only when pi's implementation was found.
  const real = loadedReal as PiEditDiffModule;

  function outcome(run: () => { baseContent: string; newContent: string }): Record<string, unknown> {
    try {
      const r = run();
      return { ok: true, baseContent: r.baseContent, newContent: r.newContent };
    } catch {
      return { ok: false };
    }
  }

  /** Both implementations over the same content must agree exactly. */
  function expectSame(content: string, edits: EditOp[]) {
    const mine = outcome(() => applyEditsToNormalizedContent(content, edits, "test.ts"));
    const theirs = outcome(() => real.applyEditsToNormalizedContent(content, edits, "test.ts"));
    expect(mine).toEqual(theirs);
  }

  it("matches pi on single exact replacement", () => {
    expectSame("one\ntwo\nthree\n", [{ oldText: "two", newText: "TWO" }]);
  });

  it("matches pi on multiple disjoint edits", () => {
    expectSame("a\nb\nc\nd\ne\n", [
      { oldText: "b", newText: "B" },
      { oldText: "d", newText: "D" },
    ]);
  });

  it("matches pi on adjacent-line edits", () => {
    expectSame("a\nb\nc\n", [
      { oldText: "a", newText: "A" },
      { oldText: "b", newText: "B" },
      { oldText: "c", newText: "C" },
    ]);
  });

  it("matches pi on full-file replacement to empty", () => {
    expectSame("only line\nkeep me\n", [{ oldText: "only line\n", newText: "" }]);
  });

  it("matches pi on CRLF content", () => {
    expectSame("alpha\r\nbeta\r\n", [{ oldText: "beta", newText: "BETA" }]);
  });

  it("matches pi on fuzzy match (smart quotes, dashes, NBSP, trailing whitespace)", () => {
    const content = 'const s = \u201Cvalue\u201D;  \nconst range = 1\u20134;\nconst gap = "a\u00A0b";\n';
    // oldText written in clean ASCII — only the fuzzy path can find it
    expectSame(content, [{ oldText: 'const s = "value";', newText: 'const s = "VALUE";' }]);
  });

  it("matches pi when any fuzzy match forces whole-call rebase", () => {
    const content = "clean line\n\u2018quoted\u2019 line  \nanother\n";
    expectSame(content, [
      { oldText: "clean line", newText: "CLEAN" },
      { oldText: "'quoted' line", newText: "QUOTED" },
    ]);
  });

  it("matches pi when oldText itself carries the imprecision", () => {
    const content = "na\u00EFve\u00A0caf\u00E9\nplain\n";
    expectSame(content, [{ oldText: "naive cafe", newText: "changed" }]);
  });

  it("matches pi on rejection: text not found", () => {
    expectSame("a\nb\n", [{ oldText: "nope", newText: "x" }]);
  });

  it("matches pi on rejection: duplicate occurrences", () => {
    expectSame("dup\ndup\n", [{ oldText: "dup", newText: "x" }]);
  });

  it("matches pi on rejection: empty oldText", () => {
    expectSame("a\n", [{ oldText: "", newText: "x" }]);
  });

  it("matches pi on rejection: net no-change", () => {
    expectSame("same\n", [{ oldText: "same", newText: "same" }]);
  });

  it("matches pi on rejection: overlapping edits", () => {
    expectSame("abcdef\n", [
      { oldText: "abcd", newText: "X" },
      { oldText: "cdef", newText: "Y" },
    ]);
  });

  it("matches pi with unicode-heavy content", () => {
    const content =
      "// \u65E5\u672C\u8A9E \u{1F636}\u200D\u{1F32B}\uFE0F comment\nlet x = 1;\n// \u0442\u0435\u0441\u0442\n";
    expectSame(content, [{ oldText: "let x = 1;", newText: "let x = 42;" }]);
  });

  it("full preview equals pi computeEditsDiff end-to-end (relative path + cwd)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edit-match-test-"));
    try {
      const rel = "fixture/sample.ts";
      const abs = join(dir, "fixture", "sample.ts");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, "first\nsecond\u2019s\nthird\n");
      const edits: EditOp[] = [{ oldText: "second's", newText: "second" }];

      const theirs = await real.computeEditsDiff(rel, edits, dir);
      const rawContent = readFileSync(abs, "utf-8");
      const bomless = rawContent.startsWith("\uFEFF") ? rawContent.slice(1) : rawContent;
      const mine = outcome(() => applyEditsToNormalizedContent(normalizeToLF(bomless), edits, rel));
      const preview =
        mine.ok === true ? real.generateDiffString(mine.baseContent as string, mine.newContent as string) : mine;

      expect(preview).toEqual(theirs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
