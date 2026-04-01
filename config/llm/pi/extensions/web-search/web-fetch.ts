/**
 * Web page fetcher via agent-browser CLI.
 * Pure module — no pi imports, testable independently.
 *
 * Uses a persistent browser session (daemon model) for fast repeated fetches.
 * Session is named per-project to avoid collisions.
 */

import { execFile, spawn } from "node:child_process";
import { basename } from "node:path";

export interface FetchResult {
  url: string;
  title: string;
  content: string;
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// Serialize fetches to prevent concurrent navigations from clobbering each other.
// All fetches share one tab; the mutex ensures only one runs at a time.
let fetchQueue: Promise<void> = Promise.resolve();

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

// ── Session naming ──

/** Derive a session name from cwd to isolate browser state per project. */
export function sessionName(cwd: string): string {
  return `pi-fetch-${basename(cwd)}`;
}

// ── Browser commands ──

function run(
  args: string[],
  options: { timeout?: number; signal?: AbortSignal; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeout = options.timeout ?? 30_000;
  const maxBuffer = options.maxBuffer ?? 5 * 1024 * 1024; // 5MB default

  return new Promise((resolve, reject) => {
    const child = execFile("agent-browser", args, { timeout, maxBuffer, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        if (options.signal?.aborted) {
          reject(new FetchError("Fetch aborted"));
          return;
        }
        reject(new FetchError(`agent-browser failed: ${error.message}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    if (options.signal) {
      options.signal.addEventListener("abort", () => child.kill(), { once: true });
    }
  });
}

/** Strip ANSI escape codes from agent-browser output. */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are control chars by definition
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Public API ──

export async function fetchPage(
  url: string,
  options: { cwd: string; headed?: boolean; signal?: AbortSignal },
): Promise<FetchResult> {
  // Serialize: chain onto the queue so only one fetch navigates at a time.
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  const previous = fetchQueue;
  fetchQueue = gate;
  await previous;

  try {
    return await fetchPageInner(url, options);
  } finally {
    resolve();
  }
}

async function fetchPageInner(
  url: string,
  options: { cwd: string; headed?: boolean; signal?: AbortSignal },
): Promise<FetchResult> {
  const session = sessionName(options.cwd);
  const sessionArgs = ["--session", session];
  const headedArgs = options.headed ? ["--headed"] : [];
  const baseArgs = [...sessionArgs, ...headedArgs];

  // Navigate (safe: mutex ensures no concurrent navigation)
  await run([...baseArgs, "open", url], {
    timeout: 30_000,
    signal: options.signal,
  });

  // Get title and final URL (after redirects) in parallel
  const [titleResult, urlResult] = await Promise.all([
    run([...sessionArgs, "get", "title"], { timeout: 5_000, signal: options.signal }),
    run([...sessionArgs, "get", "url"], { timeout: 5_000, signal: options.signal }),
  ]);
  const title = stripAnsi(titleResult.stdout).trim();
  const finalUrl = stripAnsi(urlResult.stdout).trim();

  // Get HTML and convert to markdown via pandoc for structured output
  // (preserves headers, code blocks, links, lists).
  // Falls back to plain text extraction if pandoc fails.
  let content: string;
  try {
    const htmlResult = await run([...sessionArgs, "get", "html", "body"], {
      timeout: 15_000,
      signal: options.signal,
    });
    content = await htmlToMarkdown(htmlResult.stdout, options.signal);
  } catch {
    const textResult = await run([...sessionArgs, "get", "text", "body"], {
      timeout: 15_000,
      signal: options.signal,
    });
    content = stripAnsi(textResult.stdout).trim();
  }

  // Reset idle timer
  resetIdleTimer(options.cwd);

  return { url: finalUrl, title, content };
}

/** Convert HTML to markdown via pandoc. Strips data: URI images. */
function htmlToMarkdown(html: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("pandoc", ["-f", "html", "-t", "commonmark-raw_html", "--wrap=none"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    child.on("error", (err) => reject(new FetchError(`pandoc failed: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new FetchError(`pandoc exited ${code}: ${stderr}`));
        return;
      }
      resolve(cleanMarkdown(stdout));
    });

    if (signal) {
      signal.addEventListener("abort", () => child.kill(), { once: true });
    }

    child.stdin.write(html);
    child.stdin.end();
  });
}

/** Clean up pandoc markdown output: strip data: URI images, collapse blank lines. */
export function cleanMarkdown(md: string): string {
  return (
    md
      // Strip image links with data: URIs (e.g. GitHub anchor SVGs)
      .replace(/!?\[(?:[^\]]*)\]\(data:[^)]+\)/g, "")
      // Strip image links wrapping other images (common GitHub pattern)
      .replace(/\[!\[(?:[^\]]*)\]\([^)]+\)\]\([^)]+\)/g, "")
      // Collapse 3+ blank lines to 2
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function resetIdleTimer(cwd: string): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    closeSession(cwd).catch(() => {});
  }, IDLE_TIMEOUT_MS);
}

/** Close the browser session for a project. */
export async function closeSession(cwd: string): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const session = sessionName(cwd);
  try {
    await run(["--session", session, "close"], { timeout: 5_000 });
  } catch {
    // Session might already be closed
  }
}

/** Truncate content to a character limit, appending a note if truncated. */
export function truncateContent(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { text: content, truncated: false };
  }
  return {
    text: `${content.slice(0, maxChars)}\n\n[Truncated at ${maxChars} characters]`,
    truncated: true,
  };
}
