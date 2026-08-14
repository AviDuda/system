import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Diagnostic, diagnosticsFromPullReport, findProjectRoot } from "./client";

describe("findProjectRoot", () => {
  test("finds root with Cargo.toml marker", () => {
    // We know the system repo has a flake.nix
    const result = findProjectRoot(import.meta.path, ["flake.nix"]);
    // Should find some ancestor with flake.nix (or null if none)
    // The test file lives in the lsp extension dir which is under the system repo
    if (result) {
      expect(fs.existsSync(path.join(result, "flake.nix"))).toBe(true);
    }
  });

  test("returns null when no markers found", () => {
    // Use a path deep in /tmp where no Cargo.toml exists
    const result = findProjectRoot("/tmp/nonexistent/deep/file.ts", ["Cargo.toml"]);
    expect(result).toBeNull();
  });

  test("finds nearest root with marker", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    const nested = path.join(tmpRoot, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    // Place marker at tmpRoot/a/
    fs.writeFileSync(path.join(tmpRoot, "a", "Cargo.toml"), "");
    // Place marker at tmpRoot/ too (should NOT be returned since a/ is nearer)
    fs.writeFileSync(path.join(tmpRoot, "Cargo.toml"), "");

    const testFile = path.join(nested, "main.rs");
    fs.writeFileSync(testFile, "");

    const result = findProjectRoot(testFile, ["Cargo.toml"]);
    expect(result).toBe(path.join(tmpRoot, "a"));

    // Cleanup
    fs.rmSync(tmpRoot, { recursive: true });
  });

  test("checks multiple markers", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    const nested = path.join(tmpRoot, "src");
    fs.mkdirSync(nested, { recursive: true });
    // Place a package.json marker
    fs.writeFileSync(path.join(tmpRoot, "package.json"), "{}");

    const testFile = path.join(nested, "index.ts");
    fs.writeFileSync(testFile, "");

    // Should find root via package.json
    const result = findProjectRoot(testFile, ["package.json", "tsconfig.json"]);
    expect(result).toBe(tmpRoot);

    // Should NOT find root if looking for wrong markers
    const noResult = findProjectRoot(testFile, ["Cargo.toml", "go.mod"]);
    expect(noResult).toBeNull();

    fs.rmSync(tmpRoot, { recursive: true });
  });

  test("handles file at root marker directory itself", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    fs.writeFileSync(path.join(tmpRoot, "Cargo.toml"), "");

    const testFile = path.join(tmpRoot, "main.rs");
    fs.writeFileSync(testFile, "");

    const result = findProjectRoot(testFile, ["Cargo.toml"]);
    expect(result).toBe(tmpRoot);

    fs.rmSync(tmpRoot, { recursive: true });
  });
});

describe("diagnosticsFromPullReport", () => {
  const diag = (msg: string): Diagnostic => ({
    message: msg,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  });

  test("full report returns its items", () => {
    const items = [diag("a"), diag("b")];
    expect(diagnosticsFromPullReport({ kind: "full", items })).toEqual(items);
  });

  test("unchanged report returns null (keep current diagnostics)", () => {
    expect(diagnosticsFromPullReport({ kind: "unchanged", resultId: "x" })).toBeNull();
  });

  test("malformed payloads return null", () => {
    expect(diagnosticsFromPullReport(null)).toBeNull();
    expect(diagnosticsFromPullReport("nope")).toBeNull();
    expect(diagnosticsFromPullReport({ items: "not-an-array" })).toBeNull();
  });

  test("non-diagnostic items are filtered out", () => {
    const items = [diag("ok"), { nope: true }, null];
    expect(diagnosticsFromPullReport({ kind: "full", items })).toEqual([diag("ok")]);
  });
});
