/**
 * Per-repo path→server overrides from `.lsp/config.json`:
 *
 * ```json
 * { "paths": { "generated/*.sqlinc": "sqls" } }
 * ```
 *
 * The extension routes a file to a server by extension; some repos have files
 * whose content is a language their name hides (e.g. generated text files
 * holding SQL commands). Content sniffing can't rescue those — enry reads the
 * same SQL as `Text` in a `.txt`, and pygments' guesser does too — so an
 * explicit glob→server map is the reliable escape hatch.
 *
 * Pure (node:path + fs only) — the wiring lives in index.ts (getServersForFile).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface PathOverrides {
  /** glob → server key */
  paths: Record<string, string>;
}

/**
 * Load `.lsp/config.json` at the repo root (devcontainer root when one exists,
 * else cwd). Returns empty overrides when absent or malformed. Sync — this is
 * read on file resolution, where an async hop per file is wasted.
 */
export function loadPathOverrides(cwd: string): PathOverrides {
  const lspDir = path.join(cwd, ".lsp");
  const file = path.join(lspDir, "config.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const paths = (parsed as { paths?: unknown })?.paths;
    if (typeof paths !== "object" || paths === null || Array.isArray(paths)) return { paths: {} };
    return { paths: paths as Record<string, string> };
  } catch {
    return { paths: {} };
  }
}

/**
 * First override whose glob matches the absolute file path, or null.
 * Iteration order = object insertion order (JSON preserves it).
 */
export function matchPathOverride(absFile: string, overrides: PathOverrides): string | null {
  for (const [glob, server] of Object.entries(overrides.paths)) {
    if (path.matchesGlob(absFile, glob)) return server;
  }
  return null;
}
