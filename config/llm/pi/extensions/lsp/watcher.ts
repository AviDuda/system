/**
 * File system watcher for LSP.
 *
 * Watches cwd recursively using Node's fs.watch, debounces events, and
 * reports file changes to the LSP extension for workspace/didChangeWatchedFiles.
 *
 * Ignores .git internals (fast path), then batch-filters through
 * `git check-ignore` to respect .gitignore rules. Falls back to a
 * hardcoded ignore list for non-git directories.
 * Deduplicates rapid events on the same file within the debounce window.
 */

import { execFileSync } from "node:child_process";
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

/** Debounce window for batching file events (ms) */
const DEBOUNCE_MS = 300;

/**
 * Fast check for .git directory -- always ignored, and fs.watch fires
 * many events during git operations. This avoids accumulating those
 * in the pending map before the git check-ignore batch filter runs.
 */
function isGitInternal(relativePath: string): boolean {
  return relativePath === ".git" || relativePath.startsWith(`.git${path.sep}`);
}

/**
 * Filter file paths through git's ignore rules (.gitignore, .git/info/exclude,
 * global gitignore). Runs `git check-ignore --stdin` on the batch.
 * Returns the set of paths that are NOT ignored.
 */
function filterGitIgnored(root: string, absolutePaths: string[]): Set<string> {
  if (absolutePaths.length === 0) return new Set();

  // Convert to paths relative to root for git check-ignore
  const relativePaths = absolutePaths.map((p) => path.relative(root, p));
  const input = relativePaths.join("\n");

  try {
    // git check-ignore --stdin prints ignored paths to stdout, exits 0 if any matched.
    // Exits 1 if none matched. We want the ones NOT printed.
    const stdout = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: root,
      input,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ignored = new Set(stdout.trim().split("\n").filter(Boolean));
    const kept = new Set<string>();
    for (let i = 0; i < relativePaths.length; i++) {
      if (!ignored.has(relativePaths[i])) {
        kept.add(absolutePaths[i]);
      }
    }
    return kept;
  } catch (err: unknown) {
    // Exit code 1 = no paths matched (none are ignored) -- keep all
    if (typeof err === "object" && err !== null && "status" in err && (err as { status: number }).status === 1) {
      return new Set(absolutePaths);
    }
    // Git not available or not a git repo -- fall back to common ignore dirs
    return filterByCommonIgnores(root, absolutePaths);
  }
}

/** Common directories to ignore when git is unavailable */
const FALLBACK_IGNORE_DIRS = new Set([
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
  "target",
  ".gradle",
  ".zig-cache",
  "zig-out",
]);

function filterByCommonIgnores(root: string, absolutePaths: string[]): Set<string> {
  const kept = new Set<string>();
  for (const abs of absolutePaths) {
    const rel = path.relative(root, abs);
    const parts = rel.split(path.sep);
    if (!parts.some((p) => FALLBACK_IGNORE_DIRS.has(p))) {
      kept.add(abs);
    }
  }
  return kept;
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

    // Batch-filter through git's ignore rules
    const allPaths = Array.from(pending.keys());
    const kept = filterGitIgnored(root, allPaths);

    const changes: FileChange[] = [];
    for (const [absolutePath, type] of pending) {
      if (kept.has(absolutePath)) {
        changes.push({ absolutePath, type });
      }
    }
    pending.clear();
    if (changes.length > 0) handler(changes);
  }

  function onEvent(eventType: string, filename: string | null) {
    if (closed || !filename) return;
    // Fast path: skip .git internals (high volume during git operations)
    if (isGitInternal(filename)) return;

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
