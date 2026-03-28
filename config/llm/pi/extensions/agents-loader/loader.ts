/**
 * Pure logic for agents file discovery, separated for testability.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const AGENTS_FILENAMES = ["AGENTS.md", "AGENTS.local.md", "CLAUDE.md", "CLAUDE.local.md"];
export const LOCAL_ONLY_FILENAMES = ["AGENTS.local.md", "CLAUDE.local.md"];

export interface ExtractedPath {
  path: string;
  /** If true, the path is a directory itself (ls/find/grep), not a file in a directory */
  isDirectory: boolean;
}

/** Extract file path from tool input, if any */
export function extractPath(toolName: string, input: Record<string, unknown>): ExtractedPath | undefined {
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
      return input.path ? { path: input.path as string, isDirectory: false } : undefined;
    case "ls":
    case "find":
    case "grep":
      return input.path ? { path: input.path as string, isDirectory: true } : undefined;
    default:
      return undefined;
  }
}

/**
 * Get all directories from the path up to (but not including) cwd.
 * When isDirectory=false (file tools), starts from the file's parent dir.
 * When isDirectory=true (ls/find/grep), includes the path itself.
 * Returns [] if the path is not strictly under cwd.
 */
export function getDirectoryChain(filePath: string, cwd: string, isDirectory = false): string[] {
  const abs = resolve(cwd, filePath);
  let dir = isDirectory ? abs : dirname(abs);
  const cwdNorm = cwd.endsWith(sep) ? cwd : cwd + sep;

  const dirs: string[] = [];
  while (dir.startsWith(cwdNorm)) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return dirs;
}

export interface DiscoveredFile {
  /** Path relative to cwd */
  relativePath: string;
  /** File content */
  content: string;
}

/**
 * Discover agents files in the directory chain for a given file path.
 * Returns newly discovered files (not in loadedRealpaths).
 * Mutates loadedRealpaths to track what's been seen.
 */
/**
 * Discover .local.md files from cwd and parent dirs at startup.
 * Pi already loads AGENTS.md/CLAUDE.md from these locations natively,
 * so we only need the .local.md variants here.
 */
export function discoverStartupLocalFiles(cwd: string, loadedRealpaths: Set<string>): DiscoveredFile[] {
  const results: DiscoveredFile[] = [];
  let dir = cwd;

  // Walk cwd and parents (mirrors pi's native AGENTS.md search)
  while (true) {
    for (const filename of LOCAL_ONLY_FILENAMES) {
      const candidate = join(dir, filename);
      if (!existsSync(candidate)) continue;

      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }

      if (loadedRealpaths.has(real)) continue;
      loadedRealpaths.add(real);

      try {
        const content = readFileSync(real, "utf-8");
        results.push({
          relativePath: relative(cwd, candidate),
          content,
        });
      } catch {
        // File disappeared
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return results;
}

/**
 * Discover agents files in subdirectories when tools access files there.
 * Returns newly discovered files (not in loadedRealpaths).
 * Mutates loadedRealpaths to track what's been seen.
 */
/**
 * Extract @path references from user input text.
 * Handles both @path and @"path with spaces" forms.
 */
export function discoverAgentsFiles(
  filePath: string,
  cwd: string,
  loadedRealpaths: Set<string>,
  isDirectory = false,
): DiscoveredFile[] {
  const dirs = getDirectoryChain(filePath, cwd, isDirectory);
  if (dirs.length === 0) return [];

  const results: DiscoveredFile[] = [];

  for (const dir of dirs) {
    for (const filename of AGENTS_FILENAMES) {
      const candidate = join(dir, filename);
      if (!existsSync(candidate)) continue;

      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }

      if (loadedRealpaths.has(real)) continue;
      loadedRealpaths.add(real);

      try {
        const content = readFileSync(real, "utf-8");
        results.push({
          relativePath: relative(cwd, candidate),
          content,
        });
      } catch {
        // File disappeared between exists check and read
      }
    }
  }

  return results;
}
