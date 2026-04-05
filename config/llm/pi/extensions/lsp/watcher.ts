/**
 * File system watcher for LSP.
 *
 * Watches cwd recursively using Node's fs.watch, debounces events, and
 * reports file changes to the LSP extension for workspace/didChangeWatchedFiles.
 *
 * Ignores .git, node_modules, and common build output directories.
 * Deduplicates rapid events on the same file within the debounce window.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** LSP FileChangeType values */
export const WatchChangeType = { Created: 1, Changed: 2, Deleted: 3 } as const;
export type WatchChangeType = (typeof WatchChangeType)[keyof typeof WatchChangeType];

export interface FileChange {
  absolutePath: string;
  type: WatchChangeType;
}

export type FileChangeHandler = (changes: FileChange[]) => void;

/** Directories to ignore at any depth */
const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  ".build",
  ".swiftpm",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "target", // rust, java
  ".gradle",
  ".zig-cache",
  "zig-out",
]);

/** Debounce window for batching file events (ms) */
const DEBOUNCE_MS = 300;

/**
 * Check if a path should be ignored based on directory name.
 * The path is relative to the watched root.
 */
function shouldIgnore(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  return parts.some((p) => IGNORE_DIRS.has(p));
}

/**
 * Determine the change type for a file event.
 * fs.watch gives us "rename" (create or delete) and "change" (modify).
 * We stat the file to distinguish create vs delete.
 */
function classifyEvent(eventType: string, fullPath: string): WatchChangeType {
  if (eventType === "change") return WatchChangeType.Changed;
  // "rename" = created or deleted -- check if file exists
  try {
    fs.statSync(fullPath);
    return WatchChangeType.Created;
  } catch {
    return WatchChangeType.Deleted;
  }
}

export interface FileWatcher {
  /** Stop watching and clean up */
  close(): void;
}

/**
 * Watch a directory recursively for file changes.
 *
 * @param root - Directory to watch (usually cwd)
 * @param handler - Called with batched file changes after debounce
 * @returns FileWatcher with close() method
 */
export function createFileWatcher(root: string, handler: FileChangeHandler): FileWatcher {
  const pending = new Map<string, WatchChangeType>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function flush() {
    timer = null;
    if (pending.size === 0) return;
    const changes: FileChange[] = [];
    for (const [absolutePath, type] of pending) {
      changes.push({ absolutePath, type });
    }
    pending.clear();
    handler(changes);
  }

  function onEvent(eventType: string, filename: string | null) {
    if (closed || !filename) return;
    if (shouldIgnore(filename)) return;

    const fullPath = path.resolve(root, filename);
    const changeType = classifyEvent(eventType, fullPath);

    // Deduplicate: last event wins within the debounce window
    pending.set(fullPath, changeType);

    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  }

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(root, { recursive: true }, onEvent);
    watcher.on("error", () => {
      // Watcher errors are non-fatal (e.g., watched dir deleted)
    });
  } catch {
    // fs.watch can throw on unsupported platforms or permission errors
  }

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      pending.clear();
    },
  };
}
