import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyWorkspaceEdit } from "./format";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
}

/** Returns the applied edits, throwing if any unsupported ops were reported. */
async function appliedOnly(
  edit: Parameters<typeof applyWorkspaceEdit>[0],
  cwd: string,
): Promise<Array<{ path: string; count: number }>> {
  const { applied, unsupported } = await applyWorkspaceEdit(edit, cwd, () => {});
  expect(unsupported).toEqual([]);
  return applied;
}

describe("applyWorkspaceEdit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("applies single edit", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    await fs.promises.writeFile(filePath, "const x = 1;\nconst y = 2;\n");

    const result = await appliedOnly(
      {
        changes: {
          [`file://${filePath}`]: [
            {
              range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } },
              newText: "42",
            },
          ],
        },
      },
      tmpDir,
    );

    expect(result).toEqual([{ path: "test.ts", count: 1 }]);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("const x = 42;\nconst y = 2;\n");
  });

  test("applies multiple edits in reverse order", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    // Input: "hello world foo bar\n" (19 chars on line 0)
    // Edit 2 (applied first): pos 16-19 "bar" → "universe"
    // Edit 1 (applied last): pos 0-5 "hello" → "goodbye"
    await fs.promises.writeFile(filePath, "hello world foo bar\n");

    const result = await appliedOnly(
      {
        changes: {
          [`file://${filePath}`]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              newText: "goodbye",
            },
            {
              range: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } },
              newText: "universe",
            },
          ],
        },
      },
      tmpDir,
    );

    expect(result).toEqual([{ path: "test.ts", count: 2 }]);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("goodbye world foo universe\n");
  });

  test("applies multi-line replacement", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    await fs.promises.writeFile(filePath, "line1\nline2\nline3\n");
    // Replace lines 0-1 ("line1\nline2\n") with "replaced\n"
    // splice(startLine, endLine - startLine + 1, firstLine + lastLine)
    // = splice(0, 2, "replaced\n" + "line3\n")
    const result = await appliedOnly(
      {
        changes: {
          [`file://${filePath}`]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 1, character: 5 } },
              newText: "replaced",
            },
          ],
        },
      },
      tmpDir,
    );

    expect(result).toEqual([{ path: "test.ts", count: 1 }]);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("replaced\nline3\n");
  });

  test("applies insertion (zero-length range)", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    await fs.promises.writeFile(filePath, "hello\n");

    const result = await appliedOnly(
      {
        changes: {
          [`file://${filePath}`]: [
            {
              range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
              newText: " world",
            },
          ],
        },
      },
      tmpDir,
    );

    expect(result).toEqual([{ path: "test.ts", count: 1 }]);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello world\n");
  });

  test("applies deletion (empty replacement)", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    await fs.promises.writeFile(filePath, "hello world\n");

    const result = await appliedOnly(
      {
        changes: {
          [`file://${filePath}`]: [
            {
              range: { start: { line: 0, character: 5 }, end: { line: 0, character: 11 } },
              newText: "",
            },
          ],
        },
      },
      tmpDir,
    );

    expect(result).toEqual([{ path: "test.ts", count: 1 }]);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello\n");
  });

  test("handles empty changes", async () => {
    const { applied, unsupported } = await applyWorkspaceEdit({ changes: {} }, tmpDir, () => {});
    expect(applied).toEqual([]);
    expect(unsupported).toEqual([]);
  });

  // rust-analyzer returns `documentChanges` (the structured form), not
  // `changes`. This is the regression test for the rename bug where the
  // extension only read `.changes` and reported "no renameable symbol" even
  // though the server returned a complete TextDocumentEdit[].
  test("applies documentChanges (TextDocumentEdit) — rust-analyzer rename form", async () => {
    const filePath = path.join(tmpDir, "test.rs");
    await fs.promises.writeFile(filePath, "struct Foo { scale: f64 }\nlet f = Foo { scale: 1.0 };\n");

    const result = await appliedOnly(
      {
        documentChanges: [
          {
            textDocument: { uri: `file://${filePath}`, version: 1 },
            edits: [
              // declaration ("scale" at 13:18)
              { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } }, newText: "ratio" },
              // usage ("scale" at 14:19)
              { range: { start: { line: 1, character: 14 }, end: { line: 1, character: 19 } }, newText: "ratio" },
            ],
          },
        ],
      },
      tmpDir,
    );

    expect(result).toEqual([{ path: "test.rs", count: 2 }]);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("struct Foo { ratio: f64 }\nlet f = Foo { ratio: 1.0 };\n");
  });

  test("documentChanges is authoritative when both are present (no double-apply)", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    await fs.promises.writeFile(filePath, "hello\n");

    const { applied, unsupported } = await applyWorkspaceEdit(
      {
        // A stale/decoy `changes` that would turn "hello" into "DECOY" if applied.
        changes: {
          [`file://${filePath}`]: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "DECOY" },
          ],
        },
        // `documentChanges` wins.
        documentChanges: [
          {
            textDocument: { uri: `file://${filePath}`, version: 1 },
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "world" }],
          },
        ],
      },
      tmpDir,
      () => {},
    );

    expect(applied).toEqual([{ path: "test.ts", count: 1 }]);
    expect(unsupported).toEqual([]);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("world\n");
  });

  test("executes create/rename/delete resource ops in documentChanges order", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    await fs.promises.writeFile(filePath, "a\n");

    // Move-to-file shape: create the new file, then a TextDocumentEdit fills it.
    const { applied, unsupported } = await applyWorkspaceEdit(
      {
        documentChanges: [
          { kind: "create", uri: `file://${path.join(tmpDir, "new.ts")}` },
          {
            textDocument: { uri: `file://${path.join(tmpDir, "new.ts")}`, version: 1 },
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "b" }],
          },
          { kind: "create", uri: `file://${path.join(tmpDir, "sub/deep.ts")}` },
        ],
      },
      tmpDir,
      () => {},
    );

    expect(unsupported).toEqual([]);
    expect(applied).toEqual([
      { path: "new.ts", count: 1 },
      { path: "new.ts", count: 1 },
      { path: "sub/deep.ts", count: 1 },
    ]);
    // Created file exists and the TextDocumentEdit filled it.
    expect(fs.readFileSync(path.join(tmpDir, "new.ts"), "utf-8")).toBe("b");
    // Parent dirs are created for nested targets.
    expect(fs.readFileSync(path.join(tmpDir, "sub/deep.ts"), "utf-8")).toBe("");
  });

  test("executes rename and delete resource ops", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    await fs.promises.writeFile(filePath, "a\n");

    const { applied, unsupported } = await applyWorkspaceEdit(
      {
        documentChanges: [
          { kind: "rename", oldUri: `file://${filePath}`, newUri: `file://${path.join(tmpDir, "moved.ts")}` },
          { kind: "delete", uri: `file://${path.join(tmpDir, "moved.ts")}` },
        ],
      },
      tmpDir,
      () => {},
    );

    expect(unsupported).toEqual([]);
    expect(applied).toEqual([
      { path: "moved.ts", count: 1 },
      { path: "moved.ts", count: 1 },
    ]);
    // Renamed, then deleted: neither file remains.
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "moved.ts"))).toBe(false);
  });
});
