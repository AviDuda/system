import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyWorkspaceEdit } from "./format";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
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

    const result = await applyWorkspaceEdit(
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

    const result = await applyWorkspaceEdit(
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
    const result = await applyWorkspaceEdit(
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

    const result = await applyWorkspaceEdit(
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

    const result = await applyWorkspaceEdit(
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
    const result = await applyWorkspaceEdit({ changes: {} }, tmpDir);
    expect(result).toEqual([]);
  });
});
