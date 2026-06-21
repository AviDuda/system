/**
 * LSP Extension for Pi
 *
 * Provides language server integration:
 * - `lsp` tool: diagnostics, definition, hover, references, symbols, rename
 * - Auto-diagnostics on edit/write via tool_result hooks
 * - Auto-detection of available servers from project markers + PATH
 *
 * Commands: /lsp (status), /lsp-restart
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  type CodeAction,
  closeFile,
  createClient,
  type Diagnostic,
  type DocumentSymbol,
  FileChangeType,
  fileToUri,
  findProjectRoot,
  type Hover,
  LSP_REQUEST_TIMEOUT_MS,
  type LspClient,
  notifyFileChanges,
  notifySaved,
  openFile,
  type SymbolInformation,
  syncFile,
  type TextEdit,
} from "./client";
import {
  applyWorkspaceEdit,
  extractHoverText,
  formatDiagnostic,
  formatDiagnosticsSummary,
  formatDocumentSymbol,
  formatLocation,
  formatLocationWithContext,
  formatSymbolInformation,
  normalizeLocations,
  readLocationContext,
  resolveSymbolPosition,
  sortDiagnostics,
} from "./format";
import { type DetectedLinter, detectLinters, findLinterByExtension, lintersForFile, lintFile } from "./linters";
import { type DetectedServer, detectServers, findServerByExtension, KNOWN_SERVERS, serversForFile } from "./servers";
import { createFileWatcher, type FileChange, type FileWatcher, WatchChangeType } from "./watcher";

// ── State ──

/** Active LSP clients, keyed by `serverName::rootPath` */
const clients = new Map<string, LspClient>();

/** Build a client map key from server name and project root. */
function clientKey(serverName: string, root: string): string {
  return `${serverName}::${root}`;
}

/** Parse a client key back into server name and root. */
function parseClientKey(key: string): { serverName: string; root: string } {
  const idx = key.indexOf("::");
  return { serverName: key.slice(0, idx), root: key.slice(idx + 2) };
}

/** Detected servers for current cwd */
let detectedServers: DetectedServer[] = [];

/** Detected linters for current cwd */
let detectedLinters: DetectedLinter[] = [];

/** Current working directory */
let currentCwd = "";

/** Stored UI context for lazy status updates */
let sessionCtx: ExtensionContext | null = null;

/** Active file watcher for cwd */
let fileWatcher: FileWatcher | null = null;

// ── Client management ──

/**
 * Get or create a client for a specific server at a specific root.
 */
async function getClientAt(serverName: string, root: string): Promise<LspClient | null> {
  const key = clientKey(serverName, root);
  const existing = clients.get(key);
  if (existing && !existing.dead) return existing;

  // Look up server config
  const config = KNOWN_SERVERS[serverName];
  if (!config) return null;

  try {
    const client = await createClient(serverName, config, root);
    client.onProgress = () => updateStatusBarThrottled();
    clients.set(key, client);
    return client;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[lsp] Failed to start ${serverName} at ${root}: ${msg}`);
    return null;
  }
}

async function getClient(serverName: string): Promise<LspClient | null> {
  return getClientAt(serverName, currentCwd);
}

function getServersForFile(filePath: string): DetectedServer[] {
  return serversForFile(filePath, detectedServers);
}

/**
 * Find the project root for a file using known servers' root markers.
 * Returns the root and which server matched, or null.
 */
function findRootForFile(filePath: string): { root: string; serverName: string } | null {
  for (const [name, config] of Object.entries(KNOWN_SERVERS)) {
    const root = findProjectRoot(filePath, config.rootMarkers);
    if (root) return { root, serverName: name };
  }
  return null;
}

async function getClientForFile(filePath: string): Promise<{ client: LspClient; server: DetectedServer } | null> {
  const abs = path.resolve(filePath);
  const isOutsideCwd = !abs.startsWith(currentCwd);

  // For files outside the session cwd, try project root detection first.
  // Pre-detected servers are rooted at currentCwd and won't work for external projects.
  if (isOutsideCwd) {
    const found = findRootForFile(abs);
    if (found) {
      const client = await getClientAt(found.serverName, found.root);
      if (client) {
        const config = KNOWN_SERVERS[found.serverName];
        return { client, server: { name: found.serverName, config, resolvedCommand: "" } };
      }
    }
  }

  // 1. Try pre-detected servers (session cwd) — fastest path for files inside cwd
  let servers = getServersForFile(abs);

  // 2. If no pre-detected server handles this extension, find project root
  if (servers.length === 0) {
    const found = findRootForFile(abs);
    if (found) {
      const client = await getClientAt(found.serverName, found.root);
      if (client) {
        const config = KNOWN_SERVERS[found.serverName];
        return { client, server: { name: found.serverName, config, resolvedCommand: "" } };
      }
    }

    // 3. Fallback: lazy detection by extension (original behavior)
    const lazyFound = findServerByExtension(abs, currentCwd);
    if (lazyFound && !detectedServers.some((s) => s.name === lazyFound.name)) {
      detectedServers.push(lazyFound);
      updateStatusBar();
    }
    servers = getServersForFile(abs);
    if (servers.length === 0) return null;
  }

  // Prefer first available (non-linter first in oh-my-pi, we just take first)
  for (const server of servers) {
    const client = await getClient(server.name);
    if (client) return { client, server };
  }
  return null;
}

/** Timeout for progress entries that haven't been updated (ms). */
const PROGRESS_STALE_MS = 30_000;

function updateStatusBar(): void {
  if (!sessionCtx) return;

  // Collect unique server names from both detected and dynamically-started clients
  const activeNames = new Set<string>();
  for (const key of clients.keys()) {
    const { serverName } = parseClientKey(key);
    activeNames.add(serverName);
  }
  for (const s of detectedServers) activeNames.add(s.name);
  for (const l of detectedLinters) activeNames.add(l.name);
  if (activeNames.size === 0) return;

  // Expire stale progress entries (servers that sent 'begin' but never 'end')
  const now = Date.now();
  for (const client of clients.values()) {
    for (const [token, wp] of client.progress) {
      if (now - wp.lastUpdated > PROGRESS_STALE_MS) {
        client.progress.delete(token);
      }
    }
  }

  // Check for active progress from any server
  const progressParts: string[] = [];
  for (const client of clients.values()) {
    if (client.dead) continue;
    for (const wp of client.progress.values()) {
      const pct = wp.percentage !== undefined ? ` ${wp.percentage}%` : "";
      progressParts.push(`${client.name} ${wp.title}${pct}`);
    }
  }

  let status: string;
  if (progressParts.length > 0) {
    status = sessionCtx.ui.theme.fg("accent", `lsp:${progressParts.join(", ")}`);
  } else {
    status = sessionCtx.ui.theme.fg("muted", `lsp:${[...activeNames].join(",")}`);
  }
  sessionCtx.ui.setStatus("lsp", status);
}

/** Throttled version of updateStatusBar for high-frequency progress updates. */
let statusThrottleTimer: ReturnType<typeof setTimeout> | undefined;
let statusThrottlePending = false;
const STATUS_THROTTLE_MS = 500;

function updateStatusBarThrottled(): void {
  if (statusThrottleTimer) {
    statusThrottlePending = true;
    return;
  }
  updateStatusBar();
  statusThrottleTimer = setTimeout(() => {
    statusThrottleTimer = undefined;
    if (statusThrottlePending) {
      statusThrottlePending = false;
      updateStatusBar();
    }
  }, STATUS_THROTTLE_MS);
}

async function shutdownAll(): Promise<void> {
  const shutdowns = Array.from(clients.values()).map((c) => c.shutdown());
  await Promise.allSettled(shutdowns);
  clients.clear();
}

// ── File tracking helpers ──

/** Check if any active LSP client has this file open (i.e., it's not new to the LSP). */
function isFileOpenInAnyClient(filePath: string, cwd: string): boolean {
  const abs = path.resolve(cwd, filePath);
  const uri = fileToUri(abs);
  for (const client of clients.values()) {
    if (!client.dead && client.openFiles.has(uri)) return true;
  }
  return false;
}

// ── File watcher ──

/** WatchKind bitmask values from LSP spec */
const WatchKind = { Create: 1, Change: 2, Delete: 4 } as const;

/**
 * Route file change events from the watcher to LSP servers.
 * Matches each change against server-registered watcher patterns,
 * falling back to file type extensions from detected servers.
 */
function handleFileChanges(changes: FileChange[]): void {
  // Group changes by client
  type ChangeType = (typeof FileChangeType)[keyof typeof FileChangeType];
  const clientChanges = new Map<string, Array<{ uri: string; type: ChangeType; absolutePath: string }>>();

  for (const change of changes) {
    const uri = fileToUri(change.absolutePath);

    for (const [clientName, client] of clients) {
      if (client.dead) continue;

      let matched = false;

      // Check registered watcher patterns
      if (client.registeredWatchers.length > 0) {
        for (const watcher of client.registeredWatchers) {
          // Check kind bitmask matches the change type
          if (change.type === WatchChangeType.Created && !(watcher.kind & WatchKind.Create)) continue;
          if (change.type === WatchChangeType.Changed && !(watcher.kind & WatchKind.Change)) continue;
          if (change.type === WatchChangeType.Deleted && !(watcher.kind & WatchKind.Delete)) continue;

          if (path.matchesGlob(change.absolutePath, watcher.globPattern)) {
            matched = true;
            break;
          }
        }
      } else {
        // Fallback: match against detected server file types
        const { serverName } = parseClientKey(clientName);
        const server = detectedServers.find((s) => s.name === serverName);
        if (server) {
          const ext = path.extname(change.absolutePath).toLowerCase();
          matched = server.config.fileTypes.some((ft) => ft === ext);
        }
      }

      if (matched) {
        let arr = clientChanges.get(clientName);
        if (!arr) {
          arr = [];
          clientChanges.set(clientName, arr);
        }
        arr.push({ uri, type: change.type, absolutePath: change.absolutePath });
      }
    }
  }

  // Send notifications to each client
  for (const [clientName, changes] of clientChanges) {
    const client = clients.get(clientName);
    if (client && !client.dead) {
      // For deleted files, send didClose first so the server drops its in-memory state.
      // Without this, servers like tsserver keep didOpen'd files cached even after
      // receiving didChangeWatchedFiles(Deleted).
      for (const change of changes) {
        if (change.type === FileChangeType.Deleted) {
          closeFile(client, change.absolutePath);
        }
      }
      notifyFileChanges(
        client,
        changes.map((c) => ({ uri: c.uri, type: c.type })),
      );
    }
  }
}

function startFileWatcher(): void {
  stopFileWatcher();
  if (!currentCwd) return;
  fileWatcher = createFileWatcher(currentCwd, handleFileChanges);
}

function stopFileWatcher(): void {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
}

// ── Diagnostics helpers ──

/** Timeout for LSP diagnostic polling (existing files) */
const DIAG_WAIT_MS = 3000;

/** Longer timeout for new files (server needs to re-index) */
const DIAG_WAIT_NEW_FILE_MS = 6000;

/**
 * Tracks servers that timed out during auto-diagnostics.
 * Value = timestamp of the timeout. Won't retry until WARMUP_RETRY_MS has passed.
 * Cleared once a server successfully returns diagnostics.
 */
const coldServers = new Map<string, number>();

/** Minimum time before retrying a server that timed out (ms) */
const WARMUP_RETRY_MS = 5_000;

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

async function getDiagnosticsForFile(
  filePath: string,
  cwd: string,
  opts: {
    /** If true, include cold servers (for explicit `lsp diagnostics` calls) */
    explicit?: boolean;
    /** Override diagnostic wait timeout (ms) */
    timeoutMs?: number;
    /** If true, send workspace/didChangeWatchedFiles Created notification */
    isNewFile?: boolean;
  } = {},
): Promise<{ messages: string[]; summary: string; errored: boolean; server?: string } | null> {
  const { explicit = false, timeoutMs, isNewFile = false } = opts;
  const abs = path.resolve(cwd, filePath);
  let servers = getServersForFile(abs);

  // Lazy detection: if no detected server handles this file, check by extension
  if (servers.length === 0) {
    const found = findServerByExtension(abs, cwd);
    if (found && !detectedServers.some((s) => s.name === found.name)) {
      detectedServers.push(found);
      updateStatusBar();
    }
    servers = getServersForFile(abs);
    if (servers.length === 0) return null;
  }

  const allDiags: Diagnostic[] = [];
  const sourceNames: string[] = [];

  // LSP server diagnostics
  for (const server of servers) {
    // In auto mode, skip servers that timed out recently
    if (!explicit) {
      const lastTimeout = coldServers.get(server.name);
      if (lastTimeout !== undefined && Date.now() - lastTimeout < WARMUP_RETRY_MS) {
        continue;
      }
    }

    const client = await getClient(server.name);
    if (!client) continue;
    sourceNames.push(server.name);

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

    if (!explicit && diags.length === 0) {
      // Timed out or empty -- mark cold, retry after WARMUP_RETRY_MS
      coldServers.set(server.name, Date.now());
    } else {
      // Got results -- server is warm
      coldServers.delete(server.name);
    }
    allDiags.push(...diags);
  }

  // CLI linter diagnostics
  let linters = lintersForFile(abs, detectedLinters);
  if (linters.length === 0) {
    const found = findLinterByExtension(abs, cwd);
    if (found && !detectedLinters.some((l) => l.name === found.name)) {
      detectedLinters.push(found);
      updateStatusBar();
    }
    linters = lintersForFile(abs, detectedLinters);
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
  const messages = unique.map((d) => formatDiagnostic(d, relPath));
  const summary = formatDiagnosticsSummary(unique);
  const errored = unique.some((d) => d.severity === 1);

  return { messages, summary, errored, server: sourceNames.join(", ") };
}

// ── Extension entry point ──

export default function (pi: ExtensionAPI) {
  // ── Session lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = ctx.cwd;
    sessionCtx = ctx;
    detectedServers = detectServers(currentCwd);
    detectedLinters = detectLinters(currentCwd);

    if (detectedServers.length === 0 && detectedLinters.length === 0) {
      // Don't spam -- just stay quiet if nothing found
      return;
    }

    updateStatusBar();

    // Warm up servers in background, then start file watcher
    setTimeout(async () => {
      for (const server of detectedServers) {
        try {
          await getClient(server.name);
        } catch {
          // Non-fatal: server will be started on demand
        }
      }
      // Start after servers are warm so registered watcher patterns are available
      startFileWatcher();
    }, 500);
  });

  pi.on("session_shutdown", async () => {
    stopFileWatcher();
    await shutdownAll();
  });

  // ── Auto-diagnostics on edit/write ──

  pi.on("tool_result", async (event, ctx) => {
    if (!isEditToolResult(event) && !isWriteToolResult(event)) return;

    // Extract the file path from tool input
    const filePath = event.input.path as string | undefined;
    if (!filePath) return;

    // Don't run diagnostics if the edit itself failed
    if (event.isError) return;

    // Detect if this file is new to the LSP (not yet opened by any server).
    // Write tool creates files but doesn't distinguish create vs overwrite.
    // If no server has this file open, it's new -- use longer timeout and
    // send workspace/didChangeWatchedFiles so servers re-index.
    const isNewFile = isWriteToolResult(event) && !isFileOpenInAnyClient(filePath, ctx.cwd);

    try {
      const result = await getDiagnosticsForFile(filePath, ctx.cwd, { isNewFile });
      if (!result || result.messages.length === 0) return;

      // Append diagnostics to the tool result so the LLM sees them
      const diagText = `\n\n[LSP diagnostics (${result.server}): ${result.summary}]\n${result.messages.join("\n")}`;
      const existingText = event.content[0]?.type === "text" ? event.content[0].text : "";

      // Notify the user in the UI
      const level = result.errored ? "error" : "warning";
      ctx.ui.notify(`LSP: ${result.summary}\n${result.messages.join("\n")}`, level);

      return {
        content: [{ type: "text" as const, text: existingText + diagText }],
      };
    } catch {
      // Non-fatal: don't break the edit/write flow
    }
  });

  // ── LSP tool ──

  const LSP_ACTIONS = [
    "diagnostics",
    "definition",
    "type_definition",
    "implementation",
    "references",
    "hover",
    "symbols",
    "workspace_symbol",
    "rename",
    "codeAction",
    "codeActionApply",
    "restart",
    "status",
  ] as const;

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: `Language Server Protocol operations. Actions: ${LSP_ACTIONS.join(", ")}. Requires a running language server for the target file's language.`,
    promptSnippet: `lsp: Language server operations (diagnostics, definition, type_definition, references, hover, symbols, workspace_symbol, rename, codeAction, codeActionApply, restart, status). Use for type errors, go-to-definition, finding references, and refactorings.`,
    promptGuidelines: [
      "Before `read`ing a large source file (Rust, TS/JS, C#, Go, and other languages with a capable LSP server), use `lsp` with action `symbols` first. It returns a compact skeleton — top-level functions, structs/classes/interfaces with their fields, and line ranges — so you can `read` with `offset`/`limit` for just the symbol you need instead of the whole file. Useless for you on languages with weak servers (nixd, bash-language-server); fall back to `read` there. If a symbols call reports the server is still indexing, retry it immediately or use `read` directly.",
      "Use `lsp` with action `diagnostics` after making changes to check for type errors.",
      "Use `lsp` with action `definition` or `references` to navigate code instead of grepping for definitions.",
      "Use `lsp` with action `rename` to rename symbols across files instead of rg+sed/sd. It's semantically aware and handles all references. Provide `symbol` and `new_name`.",
      "The `hover` action shows type information for a symbol at a given position.",
      "Always provide `file` for all actions except `status`, `workspace_symbol`, and `restart`.",
      "Use `line` and optionally `symbol` to target a specific position. When `symbol` is provided without `line`, the tool searches the file for the symbol — this is often more reliable for go-to-definition since it uses semantic resolution.",
      "Use `lsp` with action `codeAction` to list refactorings available at a position. Then use `codeActionApply` with the action index to execute it.",
      "Use `lsp` with action `workspace_symbol` to search for symbols across the entire project by name. Provide `query` (substring match, case-insensitive). Works across all active LSP servers. Useful for finding function/type definitions when you know the name but not the file.",
      "Use `lsp` with action `restart` to restart language servers. Without `file`, restarts all servers. With `file`, restarts only the server for that file's project. Use when a server is stuck, dead, or giving stale results.",
    ],
    parameters: Type.Object({
      action: StringEnum([...LSP_ACTIONS]),
      file: Type.Optional(Type.String({ description: "File path (relative to cwd)" })),
      line: Type.Optional(Type.Number({ description: "Line number (1-indexed)" })),
      symbol: Type.Optional(Type.String({ description: "Symbol name at the line (for precise column resolution)" })),
      occurrence: Type.Optional(
        Type.Number({ description: "Which occurrence of symbol on the line (1-indexed, default 1)" }),
      ),
      new_name: Type.Optional(Type.String({ description: "New name for rename action" })),
      query: Type.Optional(
        Type.String({ description: "Search query for workspace_symbol action (substring match, case-insensitive)" }),
      ),
      index: Type.Optional(Type.Number({ description: "Index of the code action to apply (from codeAction listing)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { action, file, line, symbol, occurrence, new_name } = params;

      // ── Status ──
      if (action === "status") {
        if (detectedServers.length === 0 && detectedLinters.length === 0 && clients.size === 0) {
          return text("No language servers or linters detected for this project.");
        }
        const lines: string[] = [];

        // Show pre-detected servers (session cwd)
        if (detectedServers.length > 0) {
          lines.push(`Detected ${detectedServers.length} language server(s) for ${currentCwd}:`);
          for (const s of detectedServers) {
            const client = clients.get(clientKey(s.name, currentCwd));
            const status = client && !client.dead ? `running (${formatUptime(client.createdAt)})` : "available";
            lines.push(`  ${s.name} (${s.config.fileTypes.join(", ")}) — ${status}`);
          }
        }

        // Show dynamically-started clients (other roots)
        const otherRoots = [...clients.entries()].filter(([key]) => {
          const { root } = parseClientKey(key);
          return root !== currentCwd;
        });
        if (otherRoots.length > 0) {
          lines.push(``);
          lines.push(`Active servers for other projects (${otherRoots.length}):`);
          for (const [key, client] of otherRoots) {
            const { serverName, root } = parseClientKey(key);
            const relRoot = path.relative(currentCwd, root);
            const status = !client.dead ? `running (${formatUptime(client.createdAt)})` : "dead";
            lines.push(`  ${serverName} @ ${relRoot} — ${status}`);
          }
        }

        if (detectedLinters.length > 0) {
          lines.push(``);
          lines.push(`Detected ${detectedLinters.length} linter(s):`);
          for (const l of detectedLinters) {
            lines.push(`  ${l.name} (${l.config.fileTypes.join(", ")}) — cli`);
          }
        }
        return text(lines.join("\n"));
      }

      // ── Workspace symbol search (no file required — broadcasts to all clients) ──
      if (action === "workspace_symbol") {
        const workspaceQuery = params.query;
        if (!workspaceQuery) return text("Error: query parameter required for workspace_symbol");

        const allResults: SymbolInformation[] = [];
        for (const [, c] of clients) {
          if (c.dead) continue;
          if (!c.capabilities.workspaceSymbolProvider) continue;
          try {
            const raw = (await c.request("workspace/symbol", {
              query: workspaceQuery,
            })) as SymbolInformation[] | null;
            if (raw && raw.length > 0) {
              allResults.push(...raw);
            }
          } catch {
            // Non-fatal: server may not support workspace symbols or timed out
          }
        }

        if (allResults.length === 0) return text(`No workspace symbols found for "${workspaceQuery}"`);

        allResults.sort((a, b) => a.name.localeCompare(b.name));
        const lines = allResults.map((s) => formatSymbolInformation(s, ctx.cwd));
        return text(`Workspace symbols matching "${workspaceQuery}" (${allResults.length}):\n${lines.join("\n")}`);
      }

      // ── Restart servers ──
      if (action === "restart") {
        if (file) {
          // Restart only the server for this file's project
          const abs = path.resolve(ctx.cwd, file);
          const pair = await getClientForFile(abs);
          if (!pair) return text(`No language server available for ${file}`);

          const { client } = pair;
          const serverName = client.name;

          // Find and remove the client key for this specific server+root
          let removedKey: string | undefined;
          for (const [key, c] of clients) {
            if (c === client) {
              removedKey = key;
              break;
            }
          }

          await client.shutdown();
          if (removedKey) clients.delete(removedKey);

          // Re-create the server
          const { root } = removedKey ? parseClientKey(removedKey) : { root: currentCwd };
          const newClient = await getClientAt(serverName, root);
          if (newClient) {
            updateStatusBar();
            return text(`Restarted ${serverName} (root: ${root})`);
          }
          return text(`Failed to restart ${serverName}`);
        }

        // Restart all servers
        const names = [...clients.values()].map((c) => c.name);
        await shutdownAll();

        // Re-warm session cwd servers
        for (const server of detectedServers) {
          try {
            await getClient(server.name);
          } catch {
            // Non-fatal
          }
        }
        updateStatusBar();
        return text(`Restarted ${names.length} server(s): ${names.join(", ") || "none"}`);
      }

      // ── File-based actions ──
      if (!file) {
        return text("Error: file parameter required for this action");
      }

      const abs = path.resolve(ctx.cwd, file);
      if (!fs.existsSync(abs)) {
        return text(`Error: file not found: ${file}`);
      }

      const pair = await getClientForFile(abs);
      if (!pair) {
        return text(`No language server available for ${file}`);
      }

      const { client, server } = pair;

      try {
        await openFile(client, abs);

        const uri = fileToUri(abs);

        // Fetch document symbols for semantic position resolution.
        // The server is already parsing the file from openFile, so this is fast.
        // Not all servers support documentSymbol, so gracefully handle failures.
        let docSymbols: DocumentSymbol[] | undefined;
        if (symbol && client.capabilities.documentSymbolProvider) {
          try {
            const raw = (await client.request("textDocument/documentSymbol", {
              textDocument: { uri },
            })) as (DocumentSymbol | SymbolInformation)[] | null;
            if (raw && raw.length > 0 && "selectionRange" in raw[0]) {
              docSymbols = raw as DocumentSymbol[];
            }
          } catch {
            // Non-fatal: fall back to textual resolution
          }
        }

        const resolved = resolveSymbolPosition(abs, line, symbol, occurrence, docSymbols);
        const position = { line: resolved.line, character: resolved.character };
        const displayLine = resolved.line + 1; // 1-based for display

        // Build diagnostic info about position resolution
        let posInfo: string;
        if (!symbol) {
          posInfo = ``;
        } else if (resolved.found) {
          const method = resolved.source === "semantic" ? "semantic" : "textual";
          const occInfo =
            resolved.occurrenceCount && resolved.occurrenceCount > 1
              ? ` (occurrence ${occurrence ?? 1} of ${resolved.occurrenceCount})`
              : "";
          posInfo = ` (symbol "${symbol}" at ${displayLine}:${resolved.character + 1} via ${method}${occInfo})`;
        } else if (line !== undefined) {
          // Symbol specified + line specified, but not found on that line
          const occInfo = resolved.occurrenceCount === 0 ? " — symbol not found on this line" : "";
          posInfo = ` (symbol "${symbol}" not found at line ${line}${occInfo})`;
        } else {
          // Symbol specified, no line, not found anywhere
          posInfo = ` (symbol "${symbol}" not found in file)`;
        }

        switch (action) {
          case "diagnostics": {
            const result = await getDiagnosticsForFile(file, ctx.cwd, { explicit: true });
            if (!result) return text("No language server found for this file");
            if (result.messages.length === 0) return text("No diagnostics");
            return text(`${result.summary}:\n${result.messages.join("\n")}`);
          }

          case "definition": {
            const raw = await client.request("textDocument/definition", {
              textDocument: { uri },
              position,
            });
            const locs = normalizeLocations(raw);
            if (locs.length === 0) {
              const ctx = readLocationContext(abs, displayLine, 2).join("\n");
              return text(`No definition found${posInfo}. Context around line ${displayLine}:\n${ctx}`);
            }
            const lines = locs.map((l) => formatLocationWithContext(l, ctx.cwd));
            return text(`Found ${locs.length} definition(s):\n${lines.join("\n")}`);
          }

          case "type_definition": {
            const raw = await client.request("textDocument/typeDefinition", {
              textDocument: { uri },
              position,
            });
            const locs = normalizeLocations(raw);
            if (locs.length === 0) {
              const ctx = readLocationContext(abs, displayLine, 2).join("\n");
              return text(`No type definition found${posInfo}. Context around line ${displayLine}:\n${ctx}`);
            }
            const lines = locs.map((l) => formatLocationWithContext(l, ctx.cwd));
            return text(`Found ${locs.length} type definition(s):\n${lines.join("\n")}`);
          }

          case "implementation": {
            const raw = await client.request("textDocument/implementation", {
              textDocument: { uri },
              position,
            });
            const locs = normalizeLocations(raw);
            if (locs.length === 0) {
              const ctx = readLocationContext(abs, displayLine, 2).join("\n");
              return text(`No implementation found${posInfo}. Context around line ${displayLine}:\n${ctx}`);
            }
            const lines = locs.map((l) => formatLocationWithContext(l, ctx.cwd));
            return text(`Found ${locs.length} implementation(s):\n${lines.join("\n")}`);
          }

          case "references": {
            const raw = await client.request("textDocument/references", {
              textDocument: { uri },
              position,
              context: { includeDeclaration: true },
            });
            const locs = normalizeLocations(raw);
            if (locs.length === 0) {
              const ctx = readLocationContext(abs, displayLine, 2).join("\n");
              return text(`No references found${posInfo}. Context around line ${displayLine}:\n${ctx}`);
            }
            const contextLimit = 30;
            const withContext = locs.slice(0, contextLimit);
            const rest = locs.slice(contextLimit);
            const lines = withContext.map((l) => formatLocationWithContext(l, ctx.cwd));
            if (rest.length > 0) {
              lines.push(`  ... ${rest.length} additional reference(s)`);
              lines.push(...rest.map((l) => `  ${formatLocation(l, ctx.cwd)}`));
            }
            return text(`Found ${locs.length} reference(s):\n${lines.join("\n")}`);
          }

          case "hover": {
            const raw = (await client.request("textDocument/hover", {
              textDocument: { uri },
              position,
            })) as Hover | null;
            if (!raw?.contents) {
              const ctx = readLocationContext(abs, displayLine, 2).join("\n");
              return text(`No hover information${posInfo}. Context around line ${displayLine}:\n${ctx}`);
            }
            return text(extractHoverText(raw.contents));
          }

          case "symbols": {
            let raw: (DocumentSymbol | SymbolInformation)[] | null;
            try {
              raw = (await client.request("textDocument/documentSymbol", {
                textDocument: { uri },
              })) as (DocumentSymbol | SymbolInformation)[] | null;
            } catch (err) {
              // Cold-server timeout: the server is still analyzing this file
              // (most common right after session start, before any edits warmed
              // it). Mark it cold for the auto-diagnostics path and tell the
              // agent to retry immediately — the analysis started by this call
              // continues in the background, so the next call usually succeeds.
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes("timed out")) {
                coldServers.set(server.name, Date.now());
                return text(
                  `${server.name} is still indexing ${path.relative(ctx.cwd, abs)} (timed out after ${LSP_REQUEST_TIMEOUT_MS / 1000}s). The file analysis continues in the background — try again immediately, or use read with offset/limit in the meantime.`,
                );
              }
              throw err;
            }

            if (!raw || raw.length === 0) return text("No symbols found");
            // A successful symbols call means the server is warm for this file.
            coldServers.delete(server.name);

            const relPath = path.relative(ctx.cwd, abs);
            if ("selectionRange" in raw[0]) {
              const lines = (raw as DocumentSymbol[]).flatMap((s) => formatDocumentSymbol(s));
              return text(`Symbols in ${relPath}:\n${lines.join("\n")}`);
            } else {
              const lines = (raw as SymbolInformation[]).map((s) => formatSymbolInformation(s, ctx.cwd));
              return text(`Symbols in ${relPath}:\n${lines.join("\n")}`);
            }
          }

          case "rename": {
            if (!new_name) return text("Error: new_name parameter required for rename");

            const raw = (await client.request("textDocument/rename", {
              textDocument: { uri },
              position,
              newName: new_name,
            })) as { changes?: Record<string, TextEdit[]> } | null;

            if (!raw?.changes) {
              const context = readLocationContext(abs, displayLine, 3).join("\n");
              return text(
                `Rename failed — no renameable symbol found at line ${displayLine}${symbol ? `, symbol "${symbol}"` : ""}.\n\nContext around line ${displayLine}:\n${context}\n\nCheck: is the line number correct? Use the \`symbol\` parameter to target a specific identifier.`,
              );
            }

            // Apply the edits
            const results: string[] = [];
            for (const [editUri, edits] of Object.entries(raw.changes)) {
              const editPath = editUri.replace(/^file:\/\//, "");
              const relPath = path.relative(ctx.cwd, editPath);
              const content = await fs.promises.readFile(editPath, "utf-8");
              const lines = content.split("\n");

              // Apply edits in reverse order to preserve positions
              const sorted = [...edits].sort((a, b) => {
                const lineDiff = b.range.start.line - a.range.start.line;
                return lineDiff !== 0 ? lineDiff : b.range.start.character - a.range.start.character;
              });

              for (const edit of sorted) {
                const startLine = edit.range.start.line;
                const endLine = edit.range.end.line;
                const startChar = edit.range.start.character;
                const endChar = edit.range.end.character;

                if (startLine === endLine) {
                  const line = lines[startLine];
                  lines[startLine] = line.slice(0, startChar) + edit.newText + line.slice(endChar);
                } else {
                  const firstLine = lines[startLine].slice(0, startChar) + edit.newText;
                  const lastLine = lines[endLine].slice(endChar);
                  lines.splice(startLine, endLine - startLine + 1, firstLine + lastLine);
                }
              }

              await fs.promises.writeFile(editPath, lines.join("\n"));

              // Sync the modified content back to the server so its in-memory
              // model matches disk. Without this, subsequent renames compute
              // edits against stale positions and corrupt the file.
              await syncFile(client, editPath);

              results.push(`${relPath}: ${edits.length} edit(s)`);
            }

            return text(`Renamed to "${new_name}":\n${results.map((r) => `  ${r}`).join("\n")}`);
          }

          case "codeAction": {
            // Query available code actions at the cursor position
            const raw = (await client.request("textDocument/codeAction", {
              textDocument: { uri },
              range: { start: { line: resolved.line, character: 0 }, end: { line: resolved.line, character: 0 } },
              context: { diagnostics: [] },
            })) as Array<{ title: string; kind?: string; isPreferred?: boolean; disabled?: { reason: string } }>;

            if (!raw || raw.length === 0) return text("No code actions available at this position");

            // Show available actions with context lines around cursor
            const context = readLocationContext(abs, displayLine, 5).join("\n");

            const lines: string[] = [`Available code actions (${raw.length}):`];
            for (let i = 0; i < raw.length; i++) {
              const a = raw[i];
              const preferred = a.isPreferred ? " [preferred]" : "";
              const disabled = a.disabled ? ` (disabled: ${a.disabled.reason})` : "";
              const kind = a.kind ? ` [${a.kind}]` : "";
              lines.push(`  [${i}]${kind} ${a.title}${preferred}${disabled}`);
            }
            lines.push("");
            lines.push(`Context around line ${displayLine}:`);
            lines.push(context);
            lines.push("");
            lines.push("To apply: use action 'codeActionApply' with the index of the action you want.");
            return text(lines.join("\n"));
          }

          case "codeActionApply": {
            const idx = params.index;
            if (idx === undefined || idx < 0) {
              return text("Error: index parameter required. Use 'codeAction' first to see available actions.");
            }

            // Query available code actions
            const raw = (await client.request("textDocument/codeAction", {
              textDocument: { uri },
              range: { start: { line: resolved.line, character: 0 }, end: { line: resolved.line, character: 0 } },
              context: { diagnostics: [] },
            })) as CodeAction[];

            if (!raw || raw.length === 0) return text("No code actions available at this position");
            if (idx >= raw.length) return text(`Invalid index ${idx}. Available actions: 0-${raw.length - 1}`);

            const selected = raw[idx];
            if (selected.disabled) {
              return text(`Code action "${selected.title}" is disabled: ${selected.disabled.reason}`);
            }

            // Resolve the code action to get the edit (servers defer edit for bandwidth)
            let resolvedAction: CodeAction = selected;
            if (!selected.edit && selected.data) {
              try {
                resolvedAction = (await client.request("codeAction/resolve", {
                  ...selected,
                })) as CodeAction;
              } catch {
                // Some servers don't support resolve — try applying directly
              }
            }

            if (!resolvedAction.edit) {
              return text(
                `Code action "${selected.title}" has no edit. It may be a command-only action.\n\nTry running it via the command: ${selected.command?.title ?? selected.title}`,
              );
            }

            // Apply the workspace edit, syncing each modified file back to the server
            const results = await applyWorkspaceEdit(resolvedAction.edit, ctx.cwd, (editPath) => {
              syncFile(client, editPath);
            });
            return text(
              `Applied "${selected.title}":\n${results.map((r) => `  ${r.path}: ${r.count} edit(s)`).join("\n")}`,
            );
          }

          default:
            return text(`Unknown action: ${action}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return text(`LSP error (${server.name}): ${msg}`);
      }
    },

    renderCall(args, theme) {
      const action = theme.fg("accent", theme.bold(String(args.action ?? "")));
      const label = theme.fg("toolTitle", theme.bold("lsp "));
      const file = args.file ? ` ${theme.fg("muted", String(args.file))}` : "";
      const line = args.line ? theme.fg("muted", `:${args.line}`) : "";
      const sym = args.symbol ? ` ${theme.fg("dim", String(args.symbol))}` : "";
      const rename = args.new_name ? ` ${theme.fg("muted", "→")} ${theme.fg("accent", String(args.new_name))}` : "";
      const query = args.query ? ` "${theme.fg("accent", String(args.query))}"` : "";
      const idx = args.index !== undefined ? ` [${args.index}]` : "";
      return new Text(`${label}${action}${file}${line}${sym}${rename}${query}${idx}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const content = result.content[0];
      const body = content?.type === "text" ? content.text : "";

      if (!expanded) {
        // Show first line only
        const firstLine = body.split("\n")[0] ?? "";
        return new Text(theme.fg("muted", firstLine), 0, 0);
      }

      return new Text(body, 0, 0);
    },
  });

  // ── Commands ──

  pi.registerCommand("lsp", {
    description: "Show LSP server and linter status",
    handler: async (_args, ctx) => {
      if (detectedServers.length === 0 && detectedLinters.length === 0) {
        ctx.ui.notify("No language servers or linters detected for this project", "warning");
        return;
      }
      const lines: string[] = [];
      for (const s of detectedServers) {
        const client = clients.get(s.name);
        const status = client && !client.dead ? `running (${formatUptime(client.createdAt)})` : "available";
        lines.push(`${s.name} (${s.config.fileTypes.join(", ")}) — ${status}`);
        // Show active progress for this server
        if (client && !client.dead && client.progress.size > 0) {
          for (const wp of client.progress.values()) {
            const pct = wp.percentage !== undefined ? ` ${wp.percentage}%` : "";
            const msg = wp.message ? `: ${wp.message}` : "";
            const stale = Date.now() - wp.lastUpdated > PROGRESS_STALE_MS ? " (stale)" : "";
            lines.push(`  → ${wp.title}${pct}${msg}${stale}`);
          }
        }
      }
      for (const l of detectedLinters) {
        lines.push(`${l.name} (${l.config.fileTypes.join(", ")}) — cli`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("lsp-restart", {
    description: "Restart all LSP servers and re-detect linters",
    handler: async (_args, ctx) => {
      await shutdownAll();
      detectedServers = detectServers(ctx.cwd);
      detectedLinters = detectLinters(ctx.cwd);
      // Re-warm LSP servers
      for (const server of detectedServers) {
        try {
          await getClient(server.name);
        } catch {
          // Non-fatal
        }
      }
      const names = [...detectedServers.map((s) => s.name), ...detectedLinters.map((l) => l.name)];
      if (names.length === 0) {
        ctx.ui.notify("No language servers or linters detected after restart", "warning");
      } else {
        ctx.ui.notify(`Restarted: ${names.join(", ")}`, "info");
      }
      updateStatusBar();
    },
  });
}

// ── Helpers ──

function formatUptime(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}
