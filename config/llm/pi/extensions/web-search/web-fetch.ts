/**
 * Web page fetcher via agent-browser CLI.
 * Pure module — no pi imports, testable independently.
 *
 * Uses a persistent browser session (daemon model) for fast repeated fetches.
 * Session is named per-project to avoid collisions.
 */

import { execFile } from "node:child_process";
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
  options: { timeout?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeout = options.timeout ?? 30_000;

  return new Promise((resolve, reject) => {
    const child = execFile("agent-browser", args, { timeout, env: process.env }, (error, stdout, stderr) => {
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

  // Get title
  const titleResult = await run([...sessionArgs, "get", "title"], {
    timeout: 5_000,
    signal: options.signal,
  });
  const title = stripAnsi(titleResult.stdout).trim();

  // Get text content
  const textResult = await run([...sessionArgs, "get", "text", "body"], {
    timeout: 15_000,
    signal: options.signal,
  });

  const content = stripAnsi(textResult.stdout).trim();

  // Reset idle timer
  resetIdleTimer(options.cwd);

  return { url, title, content };
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
