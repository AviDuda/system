import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverStartupLocalFiles, extractPath, getDirectoryChain } from "./loader.js";

const TEST_DIR = join(import.meta.dir, ".test-tmp");

describe("extractPath", () => {
  test("extracts path from read", () => {
    const result = extractPath("read", { path: "src/foo.ts" });
    expect(result).toEqual({ path: "src/foo.ts", isDirectory: false });
  });

  test("extracts path from write", () => {
    const result = extractPath("write", { path: "out/bar.js" });
    expect(result).toEqual({ path: "out/bar.js", isDirectory: false });
  });

  test("extracts path from edit", () => {
    const result = extractPath("edit", { path: "lib/baz.ts" });
    expect(result).toEqual({ path: "lib/baz.ts", isDirectory: false });
  });

  test("extracts path from ls as directory", () => {
    const result = extractPath("ls", { path: "src/components" });
    expect(result).toEqual({ path: "src/components", isDirectory: true });
  });

  test("extracts path from find as directory", () => {
    const result = extractPath("find", { path: "src" });
    expect(result).toEqual({ path: "src", isDirectory: true });
  });

  test("extracts path from grep as directory", () => {
    const result = extractPath("grep", { pattern: "foo", path: "lib" });
    expect(result).toEqual({ path: "lib", isDirectory: true });
  });

  test("returns undefined for bash", () => {
    expect(extractPath("bash", { command: "ls -la" })).toBeUndefined();
  });

  test("returns undefined for unknown tools", () => {
    expect(extractPath("unknown_tool", { pattern: "foo" })).toBeUndefined();
  });

  test("returns undefined when no path in input", () => {
    expect(extractPath("read", {})).toBeUndefined();
  });

  test("returns undefined when ls has no path", () => {
    expect(extractPath("ls", {})).toBeUndefined();
  });
});

describe("getDirectoryChain", () => {
  test("returns dirs between file and cwd", () => {
    const dirs = getDirectoryChain("src/components/Button.tsx", "/project");
    expect(dirs).toEqual(["/project/src/components", "/project/src"]);
  });

  test("returns single dir for one level deep", () => {
    const dirs = getDirectoryChain("src/index.ts", "/project");
    expect(dirs).toEqual(["/project/src"]);
  });

  test("returns empty for file at cwd root", () => {
    const dirs = getDirectoryChain("README.md", "/project");
    expect(dirs).toEqual([]);
  });

  test("returns empty for file outside cwd", () => {
    const dirs = getDirectoryChain("/other/place/file.ts", "/project");
    expect(dirs).toEqual([]);
  });

  test("handles deeply nested paths", () => {
    const dirs = getDirectoryChain("a/b/c/d/file.ts", "/project");
    expect(dirs).toEqual(["/project/a/b/c/d", "/project/a/b/c", "/project/a/b", "/project/a"]);
  });

  test("handles absolute paths under cwd", () => {
    const dirs = getDirectoryChain("/project/src/file.ts", "/project");
    expect(dirs).toEqual(["/project/src"]);
  });

  test("isDirectory=true includes the path itself", () => {
    const dirs = getDirectoryChain("src/components", "/project", true);
    expect(dirs).toEqual(["/project/src/components", "/project/src"]);
  });

  test("isDirectory=true for single level", () => {
    const dirs = getDirectoryChain("src", "/project", true);
    expect(dirs).toEqual(["/project/src"]);
  });

  test("isDirectory=false for same path excludes dir itself", () => {
    const dirs = getDirectoryChain("src/components", "/project", false);
    expect(dirs).toEqual(["/project/src"]);
  });
});

describe("discoverStartupLocalFiles", () => {
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("discovers AGENTS.local.md at cwd", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "AGENTS.local.md"), "local instructions");

    const loaded = new Set<string>();
    const results = discoverStartupLocalFiles(TEST_DIR, loaded);

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("local instructions");
    expect(results[0].relativePath).toBe("AGENTS.local.md");
  });

  test("discovers CLAUDE.local.md at cwd", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "CLAUDE.local.md"), "claude local");

    const loaded = new Set<string>();
    const results = discoverStartupLocalFiles(TEST_DIR, loaded);

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("claude local");
  });

  test("deduplicates symlinks by realpath", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "AGENTS.local.md"), "the real content");
    symlinkSync("AGENTS.local.md", join(TEST_DIR, "CLAUDE.local.md"));

    const loaded = new Set<string>();
    const results = discoverStartupLocalFiles(TEST_DIR, loaded);

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("the real content");
  });

  test("does not load AGENTS.md (pi handles that natively)", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "AGENTS.md"), "should be ignored");

    const loaded = new Set<string>();
    const results = discoverStartupLocalFiles(TEST_DIR, loaded);

    expect(results).toHaveLength(0);
  });

  test("discovers files in parent directories", () => {
    const subdir = join(TEST_DIR, "child");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(TEST_DIR, "AGENTS.local.md"), "parent local");
    writeFileSync(join(subdir, "AGENTS.local.md"), "child local");

    const loaded = new Set<string>();
    const results = discoverStartupLocalFiles(subdir, loaded);

    expect(results).toHaveLength(2);
    expect(results[0].relativePath).toBe("AGENTS.local.md");
    expect(results[0].content).toBe("child local");
    expect(results[1].relativePath).toBe("../AGENTS.local.md");
    expect(results[1].content).toBe("parent local");
  });

  test("respects already-loaded set", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "AGENTS.local.md"), "already seen");

    const loaded = new Set<string>();
    loaded.add(join(TEST_DIR, "AGENTS.local.md"));

    const results = discoverStartupLocalFiles(TEST_DIR, loaded);
    expect(results).toHaveLength(0);
  });
});
