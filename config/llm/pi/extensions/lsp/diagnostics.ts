/**
 * Diagnostic collection and rendering.
 *
 * `getDiagnosticsForFile` is the core pipeline: sync a file to its LSP
 * servers (+ CLI linters), wait for their diagnostics, dedupe, sort, format,
 * and optionally run the dedup ledger, format-drift check, and quickfix hint
 * queries. `diagBlock` renders the result into the post-tool text block.
 * Pure engine logic — see state.ts for the shared state.
 */

import * as path from "node:path";
import {
  type CodeAction,
  type Diagnostic,
  FileChangeType,
  fileToUri,
  type LspClient,
  notifyFileChanges,
  notifySaved,
  serverUriFor,
  syncFile,
} from "./client";
import { getClientAt, getServersForFile, rootForServer } from "./client-mgmt";
import { formatDriftLines } from "./drift";
import { formatDiagnostic, formatDiagnosticsSummary, formatUnchangedLine, sortDiagnostics } from "./format";
import { findLinterByExtension, lintersForFile, lintFile } from "./linters";
import { findServerByExtension, serverDisplayName } from "./servers";
import {
  DIAG_WAIT_MS,
  DIAG_WAIT_NEW_FILE_MS,
  type DiagnosticsOptions,
  type DiagnosticsResult,
  type EngineState,
  MAX_QUICKFIX_HINTS,
  WARMUP_RETRY_MS,
} from "./state";
import { updateStatusData } from "./status";

/**
 * Collect diagnostics for a file from every server/linter that handles it.
 * Returns null when nothing serves the file. See DiagnosticsOptions for the
 * post-edit auto-path extras (dedup, drift, quickfixes).
 */
export async function getDiagnosticsForFile(
  state: EngineState,
  filePath: string,
  cwd: string,
  opts: DiagnosticsOptions = {},
): Promise<DiagnosticsResult | null> {
  const {
    explicit = false,
    timeoutMs,
    isNewFile = false,
    dedupe = false,
    checkDrift = false,
    checkQuickfixes = false,
  } = opts;
  const abs = path.resolve(cwd, filePath);
  let servers = getServersForFile(state, abs);

  // Lazy detection: if no detected server handles this file, check by extension
  if (servers.length === 0) {
    const found = findServerByExtension(abs, cwd);
    if (found && !state.detectedServers.some((s) => s.name === found.name)) {
      state.detectedServers.push(found);
      updateStatusData(state);
    }
    servers = getServersForFile(state, abs);
    if (servers.length === 0) return null;
  }

  const allDiags: Diagnostic[] = [];
  const sourceNames: string[] = [];

  // LSP server diagnostics
  for (const server of servers) {
    // In auto mode, skip servers that timed out recently
    if (!explicit) {
      const lastTimeout = state.coldServers.get(server.name);
      if (lastTimeout !== undefined && Date.now() - lastTimeout < WARMUP_RETRY_MS) {
        continue;
      }
    }

    const client = await getClientAt(state, server.name, rootForServer(state, server, abs));
    if (!client) continue;
    sourceNames.push(serverDisplayName(server.name));

    const prevVersion = client.diagnosticsVersion;

    // For new files, notify the server about the file creation before syncing.
    // This lets servers like sourcekit-lsp and tsserver update their project index.
    if (isNewFile) {
      notifyFileChanges(client, [{ uri: fileToUri(abs), type: FileChangeType.Created }]);
    }

    const text = await syncFile(client, abs);
    notifySaved(client, abs, text);

    const uri = fileToUri(abs);
    const waitMs = timeoutMs ?? (isNewFile ? DIAG_WAIT_NEW_FILE_MS : DIAG_WAIT_MS);
    const diags = await waitForDiagnostics(client, uri, waitMs, prevVersion);

    // Cold only when the server never responded to this change (timed out):
    // the diagnostics version didn't advance. Marking cold on an EMPTY result
    // treated a genuinely clean file as a hung server — the next edit then
    // skipped the server and reported a false "no errors" even when the edit
    // had broken the file.
    const responded = client.diagnosticsVersion > prevVersion;
    if (!explicit && !responded) {
      state.coldServers.set(server.name, Date.now());
    } else {
      // Got results -- server is warm
      state.coldServers.delete(server.name);
    }
    allDiags.push(...diags);
  }

  // Format drift (post-edit only): repo-gated servers (allowLazy: false —
  // biome) opt in to a formatter via config marker; report where it would
  // change the file so the agent's next patch doesn't target stale content.
  // Non-mutating — reports, never applies. Other servers (rust-analyzer,
  // gopls) are skipped; revisit if rustfmt/gofmt drift proves worth reporting.
  let drift: string | null = null;
  if (checkDrift) {
    for (const server of servers) {
      if (server.config.allowLazy !== false) continue;
      const client = await getClientAt(state, server.name, rootForServer(state, server, abs));
      if (!client) continue;
      const ranges = await formatDriftLines(client, abs);
      if (ranges) {
        drift = `line ${ranges} (${serverDisplayName(server.name)})`;
        break;
      }
    }
  }

  // Quickfix hints (post-edit only): for each server, ask which of its
  // diagnostics on this file have an available quickfix (codeAction with
  // edits) and report the titles — the agent sees "this is auto-fixable"
  // without calling the lsp tool. Server-agnostic (tsserver "Add import…"
  // works the same as biome's rule fixes). One query per server; suppress/
  // disable actions are filtered out. Display-capped in diagBlock.
  let quickfixes: string[] = [];
  if (checkQuickfixes) {
    const hints = new Set<string>();
    for (const server of servers) {
      const client = await getClientAt(state, server.name, rootForServer(state, server, abs));
      if (!client) continue;
      const titles = await availableQuickfixTitles(client, abs, client.diagnostics.get(fileToUri(abs)) ?? []);
      for (const t of titles) hints.add(t);
    }
    quickfixes = [...hints];
  }

  // CLI linter diagnostics
  let linters = lintersForFile(abs, state.detectedLinters);
  if (linters.length === 0) {
    const found = findLinterByExtension(abs, cwd);
    if (found && !state.detectedLinters.some((l) => l.name === found.name)) {
      state.detectedLinters.push(found);
      updateStatusData(state);
    }
    linters = lintersForFile(abs, state.detectedLinters);
  }
  for (const linter of linters) {
    sourceNames.push(linter.name);
    const diags = await lintFile(linter, abs, cwd);
    allDiags.push(...diags);
  }

  if (sourceNames.length === 0) return null;

  // Deduplicate
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const d of allDiags) {
    const key = `${d.range.start.line}:${d.range.start.character}:${d.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(d);
    }
  }

  sortDiagnostics(unique);
  const relPath = path.relative(cwd, abs);
  const summary = formatDiagnosticsSummary(unique);
  const errored = unique.some((d) => d.severity === 1);
  const server = sourceNames.join(", ");

  if (dedupe && state.dedupEnabled) {
    const split = state.diagLedger.reduce(abs, unique);
    return {
      messages: split.fresh.map((d) => formatDiagnostic(d, relPath)),
      summary,
      errored,
      server,
      unchanged: split.unchanged,
      drift: drift ?? undefined,
      quickfixes,
    };
  }

  return {
    messages: unique.map((d) => formatDiagnostic(d, relPath)),
    summary,
    errored,
    server,
    drift: drift ?? undefined,
    quickfixes,
  };
}

/**
 * Render a diagnostics result into the post-tool block: the header, fresh
 * messages, the unchanged-collapse line, and the format-drift line.
 */
export function diagBlock(result: DiagnosticsResult, relPath: string, label: string): string {
  const unchangedCount = (result.unchanged ?? []).length;
  const header =
    result.messages.length === 0 && unchangedCount === 0
      ? `[LSP diagnostics (${result.server})${label}: no errors, no warnings]`
      : `[LSP diagnostics (${result.server})${label}: ${result.summary}${
          unchangedCount > 0 ? ` — ${result.messages.length} new, ${unchangedCount} unchanged` : ""
        }]`;
  const lines = [header, ...result.messages];
  const qs = result.quickfixes ?? [];
  for (const q of qs.slice(0, MAX_QUICKFIX_HINTS)) lines.push(`  quickfix: ${q} — apply via lsp codeActionApply`);
  if (qs.length > MAX_QUICKFIX_HINTS) lines.push(`  …and ${qs.length - MAX_QUICKFIX_HINTS} more quickfixes available`);
  if (unchangedCount > 0) lines.push(formatUnchangedLine(result.unchanged ?? [], relPath));
  if (result.drift) lines.push(`  format drift: ${result.drift}`);
  return lines.join("\n");
}

// ── Internals ──

async function waitForDiagnostics(
  client: LspClient,
  uri: string,
  timeoutMs = DIAG_WAIT_MS,
  minVersion?: number,
): Promise<Diagnostic[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const diags = client.diagnostics.get(uri);
    const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
    if (diags !== undefined && versionOk) return diags;
    await new Promise((r) => setTimeout(r, 100));
  }
  return client.diagnostics.get(uri) ?? [];
}

/** Suppress/disable code actions are noise — hint only real fixes. */
const SUPPRESS_TITLE_RE = /^(suppress|disable)/i;

/**
 * Ask a server which quickfixes (codeAction with edits or commands) exist for
 * its diagnostics on a file. One request per server: a merged range spanning
 * the diagnostics + all of them in context returns every quickfix at once.
 * Returns real-fix titles only, suppress/disable excluded. Short timeout:
 * this is a hint, not worth blocking the tool result on.
 */
async function availableQuickfixTitles(client: LspClient, abs: string, diags: Diagnostic[]): Promise<string[]> {
  if (diags.length === 0) return [];
  const range = {
    start: { line: Math.min(...diags.map((d) => d.range.start.line)), character: 0 },
    end: { line: Math.max(...diags.map((d) => d.range.end.line)), character: 9999 },
  };
  try {
    const raw = (await client.request(
      "textDocument/codeAction",
      {
        textDocument: { uri: serverUriFor(client, abs) },
        range,
        context: { diagnostics: diags, only: ["quickfix"] },
      },
      2000,
    )) as CodeAction[] | null;
    if (!Array.isArray(raw)) return [];
    return raw.filter((a) => (a.edit || a.command) && !SUPPRESS_TITLE_RE.test(a.title)).map((a) => a.title);
  } catch {
    return [];
  }
}
