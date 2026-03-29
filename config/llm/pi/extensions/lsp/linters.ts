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
import { type Diagnostic, resolveCommand } from "./client";

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

// ── Biome JSON output types ──

interface BiomeJsonOutput {
  diagnostics: BiomeDiagnostic[];
}

interface BiomeDiagnostic {
  category: string;
  severity: "error" | "warning" | "information";
  /** Plain string in modern biome, structured array in older versions */
  message: string | Array<{ content: string }>;
  description?: string;
  location: {
    path: string | { file: string };
    /** Modern biome uses line/column directly */
    start?: { line: number; column: number };
    end?: { line: number; column: number };
    /** Older biome uses byte offsets */
    span?: [number, number] | null;
    sourceCode?: string | null;
  };
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
  biome: {
    command: "biome",
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc"],
    rootMarkers: ["biome.json", "biome.jsonc"],
  },

  "golangci-lint": {
    command: "golangci-lint",
    fileTypes: [".go"],
    rootMarkers: [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"],
  },
};

// ── Detection ──

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
    if (!hasMarker) continue;

    const resolved = resolveCommand(config.command, cwd);
    if (!resolved) continue;

    detected.push({ name, config, resolvedCommand: resolved });
  }

  return detected;
}

/** Find a linter for a file extension, ignoring root markers. For lazy detection. */
export function findLinterByExtension(filePath: string, cwd: string): DetectedLinter | null {
  const ext = path.extname(filePath).toLowerCase();

  for (const [name, config] of Object.entries(KNOWN_LINTERS)) {
    if (!config.fileTypes.includes(ext)) continue;

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
    case "biome":
      return runBiome(linter.resolvedCommand, filePath, cwd);
    case "golangci-lint":
      return runGolangciLint(linter.resolvedCommand, filePath, cwd);
    default:
      return [];
  }
}

// ── Biome ──

/**
 * Find the nearest directory containing biome.json or biome.jsonc,
 * walking up from the file's directory. Biome errors on nested configs
 * if run from a parent that also has one.
 */
function findBiomeRoot(filePath: string, projectRoot: string): string {
  let dir = path.dirname(filePath);
  const root = path.resolve(projectRoot);
  while (dir.length >= root.length) {
    if (fs.existsSync(path.join(dir, "biome.json")) || fs.existsSync(path.join(dir, "biome.jsonc"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return projectRoot;
}

async function runBiome(command: string, filePath: string, cwd: string): Promise<Diagnostic[]> {
  const abs = path.resolve(cwd, filePath);
  const biomeRoot = findBiomeRoot(abs, cwd);

  try {
    const { stdout } = await execFileAsync(command, ["check", "--reporter=json", abs], {
      cwd: biomeRoot,
      maxBuffer: 10 * 1024 * 1024,
      timeout: LINTER_TIMEOUT_MS,
    });

    return parseBiomeOutput(stdout, abs, biomeRoot);
  } catch (err: unknown) {
    // biome exits non-zero when it finds issues -- stdout still has valid JSON
    if (err && typeof err === "object" && "stdout" in err && typeof (err as { stdout: unknown }).stdout === "string") {
      return parseBiomeOutput((err as { stdout: string }).stdout, abs, biomeRoot);
    }
    return [];
  }
}

function parseBiomeOutput(jsonOutput: string, targetFile: string, biomeRoot?: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  let parsed: BiomeJsonOutput;
  try {
    parsed = JSON.parse(jsonOutput);
  } catch {
    return [];
  }

  for (const d of parsed.diagnostics ?? []) {
    // Skip informational diagnostics
    if (d.severity === "information") continue;

    // Extract file path -- modern biome uses plain string, older uses { file: string }
    const locPath = d.location?.path;
    const file = typeof locPath === "string" ? locPath : locPath?.file;
    if (!file) continue;

    // Only include diagnostics for the target file
    // Relative paths are relative to biome's cwd (biomeRoot), not the file's directory
    const resolveBase = biomeRoot || path.dirname(targetFile);
    const diagAbs = path.isAbsolute(file) ? file : path.resolve(resolveBase, file);
    if (path.resolve(diagAbs) !== path.resolve(targetFile)) continue;

    // Extract position -- modern biome has start/end with line/column (1-based),
    // older has byte span + sourceCode
    let line: number;
    let column: number;
    if (d.location.start) {
      line = d.location.start.line - 1; // convert to 0-based
      column = d.location.start.column - 1;
    } else {
      const pos = biomeOffsetToPosition(d.location.sourceCode ?? null, d.location.span ?? null);
      line = pos.line;
      column = pos.column;
    }

    // Extract message -- plain string in modern biome, structured array in older
    const message =
      typeof d.message === "string"
        ? d.message
        : d.description || d.message?.map((m: { content: string }) => m.content).join("") || "";
    const rule = d.category || undefined;

    diagnostics.push({
      range: {
        start: { line, character: column },
        end: { line, character: column },
      },
      severity: d.severity === "error" ? 1 : 2,
      code: rule,
      source: "biome",
      message,
    });
  }

  return diagnostics;
}

/** Convert biome byte offset to 0-based line:column. */
function biomeOffsetToPosition(
  sourceCode: string | null,
  span: [number, number] | null,
): { line: number; column: number } {
  if (!sourceCode || !span) return { line: 0, column: 0 };

  const offset = span[0];
  const before = sourceCode.slice(0, offset);
  const line = before.match(/\n/g)?.length ?? 0;
  const lastNewline = before.lastIndexOf("\n");
  const column = lastNewline === -1 ? offset : offset - lastNewline - 1;

  return { line, column };
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

export { biomeOffsetToPosition, parseBiomeOutput, parseGolangciOutput };
