/**
 * Web search via Claude Code CLI's WebSearch tool.
 * Fallback provider that shells out to `claude -p` with WebSearch enabled.
 * Slow (~13-15s) but requires no additional API keys.
 */

import { execFile, execFileSync } from "node:child_process";
import type { SearchProvider } from "./types";

export interface ClaudeSearchSource {
  title: string;
  url: string;
}

export interface ClaudeSearchResult {
  sources: ClaudeSearchSource[];
  rawText: string;
}

export class ClaudeSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeSearchError";
  }
}

/**
 * Search via Claude Code CLI.
 * Returns parsed title/url pairs plus the raw text output.
 */
export function searchViaClaude(
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<ClaudeSearchResult> {
  const limit = options.limit ?? 10;

  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      [
        "-p",
        "--allowedTools",
        "WebSearch",
        "--permission-mode",
        "auto",
        "--model",
        "haiku",
        "--no-session-persistence",
        `Use WebSearch to search for "${query}". Return up to ${limit} results. For each result, output exactly one line in this format: [Title](URL). Nothing else -- no numbering, no commentary, no headers.`,
      ],
      {
        timeout: 30_000,
        env: { ...process.env, LLM_VANILLA: "1" },
        cwd: "/tmp",
      },
      (error, stdout, _stderr) => {
        if (error) {
          if (options.signal?.aborted) {
            reject(new ClaudeSearchError("Search aborted"));
            return;
          }
          reject(new ClaudeSearchError(`Claude CLI failed: ${error.message}`));
          return;
        }

        const text = stdout.trim();
        if (!text) {
          reject(new ClaudeSearchError("Claude CLI returned empty output"));
          return;
        }

        resolve({ sources: parseMarkdownLinks(text), rawText: text });
      },
    );

    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => {
          child.kill();
        },
        { once: true },
      );
    }
  });
}

/** Parse [Title](URL) lines from Claude's output. */
export function parseMarkdownLinks(text: string): ClaudeSearchSource[] {
  const sources: ClaudeSearchSource[] = [];
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();

  match = linkRe.exec(text);
  while (match !== null) {
    const url = match[2];
    if (!seen.has(url)) {
      seen.add(url);
      sources.push({ title: match[1], url });
    }
    match = linkRe.exec(text);
  }

  return sources;
}

/** Format results for LLM consumption. Kept for direct CLI use; the
 *  claudeProvider adapter below maps to SearchHit so hosts use formatHits. */
export function formatClaudeResults(result: ClaudeSearchResult): string {
  if (result.sources.length === 0) {
    return result.rawText || "No results found.";
  }

  const lines: string[] = [];
  for (const [i, source] of result.sources.entries()) {
    lines.push(`[${i + 1}] ${source.title}`);
    lines.push(`    ${source.url}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ── Adapter ──
//
// Wraps the Claude CLI client in the shared SearchProvider interface so hosts
// can treat it generically. isAvailable checks the CLI binary exists; actual
// auth is validated at call time (fails gracefully if no subscription).
export const claudeProvider: SearchProvider = {
  name: "claude",
  label: "Claude CLI",
  isAvailable: () => {
    try {
      execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 3_000 });
      return true;
    } catch {
      return false;
    }
  },
  search: async (query, opts) => {
    const result = await searchViaClaude(query, { limit: opts.limit, signal: opts.signal });
    return {
      hits: result.sources.map((s) => ({ title: s.title, url: s.url })),
    };
  },
};
