import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFileWatcher, WatchChangeType } from "./watcher";

describe("createFileWatcher", () => {
  test("detects new file creation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-watcher-"));
    const changes: Array<{ absolutePath: string; type: number }> = [];

    const watcher = createFileWatcher(dir, (batch) => {
      changes.push(...batch);
    });

    try {
      // Create a file
      const filePath = path.join(dir, "test.ts");
      fs.writeFileSync(filePath, "export const x = 1;");

      // Wait for debounce (300ms) + some buffer
      await new Promise((r) => setTimeout(r, 600));

      expect(changes.length).toBeGreaterThan(0);
      const created = changes.find((c) => c.absolutePath === filePath);
      expect(created).toBeDefined();
      // fs.watch "rename" for new file should classify as Created
      expect(created?.type).toBe(WatchChangeType.Created);
    } finally {
      watcher.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects file deletion", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-watcher-"));
    const filePath = path.join(dir, "test.ts");
    fs.writeFileSync(filePath, "export const x = 1;");

    // Wait a bit for the initial write to settle
    await new Promise((r) => setTimeout(r, 100));

    const changes: Array<{ absolutePath: string; type: number }> = [];
    const watcher = createFileWatcher(dir, (batch) => {
      changes.push(...batch);
    });

    try {
      fs.unlinkSync(filePath);

      await new Promise((r) => setTimeout(r, 600));

      const deleted = changes.find((c) => c.absolutePath === filePath && c.type === WatchChangeType.Deleted);
      expect(deleted).toBeDefined();
    } finally {
      watcher.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores .git directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-watcher-"));
    const gitDir = path.join(dir, ".git");
    fs.mkdirSync(gitDir);

    const changes: Array<{ absolutePath: string; type: number }> = [];
    const watcher = createFileWatcher(dir, (batch) => {
      changes.push(...batch);
    });

    try {
      fs.writeFileSync(path.join(gitDir, "index"), "data");

      await new Promise((r) => setTimeout(r, 600));

      const gitChange = changes.find((c) => c.absolutePath.includes(".git"));
      expect(gitChange).toBeUndefined();
    } finally {
      watcher.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores node_modules via .gitignore", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-watcher-"));
    // Init a git repo with .gitignore so git check-ignore works
    execSync("git init && echo 'node_modules/' > .gitignore", { cwd: dir });
    const nmDir = path.join(dir, "node_modules", "pkg");
    fs.mkdirSync(nmDir, { recursive: true });

    const changes: Array<{ absolutePath: string; type: number }> = [];
    const watcher = createFileWatcher(dir, (batch) => {
      changes.push(...batch);
    });

    try {
      fs.writeFileSync(path.join(nmDir, "index.js"), "module.exports = {}");

      await new Promise((r) => setTimeout(r, 600));

      const nmChange = changes.find((c) => c.absolutePath.includes("node_modules"));
      expect(nmChange).toBeUndefined();
    } finally {
      watcher.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("debounces rapid events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-watcher-"));
    let batchCount = 0;

    const watcher = createFileWatcher(dir, () => {
      batchCount++;
    });

    try {
      // Create multiple files rapidly
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(dir, `file${i}.ts`), `export const x${i} = ${i};`);
      }

      await new Promise((r) => setTimeout(r, 600));

      // Should have been batched into 1-2 calls, not 5
      expect(batchCount).toBeLessThanOrEqual(2);
    } finally {
      watcher.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("close stops further events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-watcher-"));
    const changes: Array<{ absolutePath: string; type: number }> = [];

    const watcher = createFileWatcher(dir, (batch) => {
      changes.push(...batch);
    });

    watcher.close();

    fs.writeFileSync(path.join(dir, "test.ts"), "export const x = 1;");
    await new Promise((r) => setTimeout(r, 600));

    expect(changes.length).toBe(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
