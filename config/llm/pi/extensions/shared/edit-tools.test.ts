import { describe, expect, test } from "bun:test";
import { collectToolPaths, EDIT_LIKE_TOOLS } from "./edit-tools";

describe("EDIT_LIKE_TOOLS", () => {
  test("contains the file-mutating tools", () => {
    expect(EDIT_LIKE_TOOLS).toEqual(["write", "edit", "patch"]);
  });
  test("is exhaustive for current built-in + custom edit tools", () => {
    // Read-only tools must NOT be present.
    expect(EDIT_LIKE_TOOLS).not.toContain("read");
    expect(EDIT_LIKE_TOOLS).not.toContain("grep");
    expect(EDIT_LIKE_TOOLS).not.toContain("bash");
  });
});

describe("collectToolPaths", () => {
  test("single-path tools return one path", () => {
    expect(collectToolPaths("write", { path: "src/a.ts" })).toEqual(["src/a.ts"]);
    expect(collectToolPaths("edit", { path: "src/a.ts" })).toEqual(["src/a.ts"]);
    expect(collectToolPaths("read", { path: "src/a.ts" })).toEqual(["src/a.ts"]);
    expect(collectToolPaths("ls", { path: "src" })).toEqual(["src"]);
  });

  test("patch: collects top-level + per-edit paths (multi-file)", () => {
    const input = {
      path: "src/a.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d", path: "src/b.ts" },
      ],
    };
    expect(collectToolPaths("patch", input)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("patch: per-edit path overrides top-level", () => {
    const input = {
      path: "src/default.ts",
      edits: [{ oldText: "a", newText: "b", path: "src/actual.ts" }],
    };
    expect(collectToolPaths("patch", input)).toEqual(["src/actual.ts"]);
  });

  test("patch: falls back to top-level when an edit has no path", () => {
    const input = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    expect(collectToolPaths("patch", input)).toEqual(["src/a.ts"]);
  });

  test("patch: dedupes repeated top-level paths (common multi-edit case)", () => {
    // 3 edits, all targeting the top-level path → ONE path, not three.
    // Without dedup, consumers (LSP diagnostics, permission checks) repeat
    // work once per duplicate.
    const input = {
      path: "src/a.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
        { oldText: "e", newText: "f" },
      ],
    };
    expect(collectToolPaths("patch", input)).toEqual(["src/a.ts"]);
  });

  test("patch: dedupes a mix of top-level and per-edit paths", () => {
    const input = {
      path: "src/a.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d", path: "src/b.ts" },
        { oldText: "e", newText: "f" }, // back to top-level a.ts (dup)
        { oldText: "g", newText: "h", path: "src/b.ts" }, // dup of b.ts
      ],
    };
    expect(collectToolPaths("patch", input)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("returns raw paths verbatim — no @-stripping or resolution", () => {
    // Normalization (leading @, ~, etc.) is deliberately the consumer's job,
    // not this helper's. Verified to pass through untouched.
    expect(collectToolPaths("read", { path: "@src/a.ts" })).toEqual(["@src/a.ts"]);
    expect(collectToolPaths("patch", { path: "@x", edits: [{ oldText: "a", newText: "b" }] })).toEqual(["@x"]);
  });

  test("returns [] for tools without a path", () => {
    expect(collectToolPaths("bash", { command: "ls" })).toEqual([]);
    expect(collectToolPaths("web_search", { query: "foo" })).toEqual([]);
    expect(collectToolPaths("read", {})).toEqual([]);
  });

  test("returns [] for patch with no resolvable path", () => {
    expect(collectToolPaths("patch", { edits: [{ oldText: "a", newText: "b" }] })).toEqual([]);
    expect(collectToolPaths("patch", { path: "", edits: [{ oldText: "a", newText: "b" }] })).toEqual([]);
  });
});
