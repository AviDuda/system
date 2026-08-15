/**
 * CLI-based linter clients.
 *
 * Unlike LSP servers (persistent JSON-RPC processes), linters run as one-shot
 * CLI commands per file. They produce Diagnostic[] in the same format as LSP
 * so they can be merged into the same diagnostic pipeline.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { type Diagnostic, findProjectRoot, resolveCommand } from "./client";
import { findDevcontainerRoot } from "./devcontainer";

const execFileAsync = promisify(execFile);

/** Timeout for CLI linter invocations (ms) */
const LINTER_TIMEOUT_MS = 10_000;

// ── Types ──

export interface LinterConfig {
  /** CLI command name */
  command: string;
  /** File extensions this linter handles */
  fileTypes: string[];
  /** Files/dirs that indicate this linter is used in the project */
  rootMarkers: string[];
}

export interface DetectedLinter {
  name: string;
  config: LinterConfig;
  resolvedCommand: string;
}

// ── golangci-lint JSON output types ──

interface GolangciOutput {
  Issues: GolangciIssue[];
}

interface GolangciIssue {
  FromLinter: string;
  Text: string;
  Severity: string;
  Pos: {
    Filename: string;
    Line: number;
    Column: number;
  };
}

// ── Known linters ──

export const KNOWN_LINTERS: Record<string, LinterConfig> = {
  "golangci-lint": {
    command: "golangci-lint",
    fileTypes: [".go"],
    rootMarkers: [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"],
  },
};

// ── Detection ──

/** Per-project linter overrides from `.lsp/linters.json` at the devcontainer root (git root). */
export interface LinterOverrides {
  /** Force-run these linters even without a root marker present. */
  enabled: Set<string>;
  /** Suppress these linters even when a root marker IS present. */
  disabled: Set<string>;
}

/**
 * Read `.lsp/linters.json` (`{ "enabled": [...], "disabled": [...] }`) from the
 * devcontainer root (git root) when present, else cwd. Same `.lsp/` location
 * convention as servers. Returns empty sets when absent or unparseable.
 */
export function readLinterOverrides(cwd: string): LinterOverrides {
  const base = findDevcontainerRoot(cwd) ?? cwd;
  const asSet = (v: unknown): Set<string> =>
    Array.isArray(v) ? new Set(v.filter((n): n is string => typeof n === "string")) : new Set<string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(base, ".lsp", "linters.json"), "utf-8")) as {
      enabled?: unknown;
      disabled?: unknown;
    };
    return { enabled: asSet(parsed.enabled), disabled: asSet(parsed.disabled) };
  } catch {
    return { enabled: new Set(), disabled: new Set() };
  }
}

/**
 * Decide whether a linter should run, applying `.lsp/linters.json` overrides on
 * top of the default marker gate: `disabled` wins, then `enabled`, else the
 * marker presence decides.
 */
function isLinterWanted(name: string, cwd: string, hasMarker: boolean): boolean {
  const { enabled, disabled } = readLinterOverrides(cwd);
  if (disabled.has(name)) return false;
  if (enabled.has(name)) return true;
  return hasMarker;
}

/** Detect linters available for a project by checking root markers + PATH. */
export function detectLinters(cwd: string): DetectedLinter[] {
  const detected: DetectedLinter[] = [];

  for (const [name, config] of Object.entries(KNOWN_LINTERS)) {
    const hasMarker = config.rootMarkers.some((marker) => {
      try {
        fs.accessSync(path.join(cwd, marker));
        return true;
      } catch {
        return false;
      }
    });
    if (!isLinterWanted(name, cwd, hasMarker)) continue;

    const resolved = resolveCommand(config.command, cwd);
    if (!resolved) continue;

    detected.push({ name, config, resolvedCommand: resolved });
  }

  return detected;
}

/**
 * Find a linter for a file extension by walking up from the file to the nearest
 * root marker. The marker (e.g. `biome.json`) — not just a binary on PATH — is
 * what says the project actually uses this linter by default; override that with
 * `.lsp/linters.json` `enabled` (force) or `disabled` (suppress).
 */
export function findLinterByExtension(filePath: string, cwd: string): DetectedLinter | null {
  const ext = path.extname(filePath).toLowerCase();

  for (const [name, config] of Object.entries(KNOWN_LINTERS)) {
    if (!config.fileTypes.includes(ext)) continue;
    const hasMarker = !!findProjectRoot(filePath, config.rootMarkers);
    if (!isLinterWanted(name, cwd, hasMarker)) continue;

    const resolved = resolveCommand(config.command, cwd);
    if (!resolved) continue;

    return { name, config, resolvedCommand: resolved };
  }

  return null;
}

/** Check which detected linters handle a given file. */
export function lintersForFile(filePath: string, detected: DetectedLinter[]): DetectedLinter[] {
  const ext = path.extname(filePath).toLowerCase();
  return detected.filter((l) => l.config.fileTypes.includes(ext));
}

// ── Lint execution ──

/** Run a linter on a single file and return diagnostics. */
export async function lintFile(linter: DetectedLinter, filePath: string, cwd: string): Promise<Diagnostic[]> {
  switch (linter.name) {
    case "golangci-lint":
      return runGolangciLint(linter.resolvedCommand, filePath, cwd);
    default:
      return [];
  }
}

// ── golangci-lint ──

async function runGolangciLint(command: string, filePath: string, cwd: string): Promise<Diagnostic[]> {
  const abs = path.resolve(cwd, filePath);
  const dir = path.dirname(abs);

  try {
    // golangci-lint works on packages, not individual files.
    // Run on the directory containing the file.
    const { stdout } = await execFileAsync(command, ["run", "--out-format=json", "--timeout=30s", "./..."], {
      cwd: dir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: LINTER_TIMEOUT_MS,
    });

    return parseGolangciOutput(stdout, abs);
  } catch (err: unknown) {
    // golangci-lint exits non-zero when it finds issues
    if (err && typeof err === "object" && "stdout" in err && typeof (err as { stdout: unknown }).stdout === "string") {
      return parseGolangciOutput((err as { stdout: string }).stdout, abs);
    }
    return [];
  }
}

function parseGolangciOutput(jsonOutput: string, targetFile: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  let parsed: GolangciOutput;
  try {
    parsed = JSON.parse(jsonOutput);
  } catch {
    return [];
  }

  for (const issue of parsed.Issues ?? []) {
    // Only include issues for the target file
    const issueAbs = path.isAbsolute(issue.Pos.Filename)
      ? issue.Pos.Filename
      : path.resolve(path.dirname(targetFile), issue.Pos.Filename);
    if (path.resolve(issueAbs) !== path.resolve(targetFile)) continue;

    const severity = issue.Severity === "error" ? 1 : 2;

    diagnostics.push({
      range: {
        start: { line: issue.Pos.Line - 1, character: issue.Pos.Column - 1 },
        end: { line: issue.Pos.Line - 1, character: issue.Pos.Column - 1 },
      },
      severity,
      code: issue.FromLinter,
      source: "golangci-lint",
      message: issue.Text,
    });
  }

  return diagnostics;
}

// ── Exported for testing ──

export { parseGolangciOutput };
