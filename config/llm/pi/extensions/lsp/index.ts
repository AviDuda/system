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
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { collectToolPaths, EDIT_LIKE_TOOLS } from "../shared/edit-tools";
import {
  type CallerWarningSymbol,
  changedLines,
  formatCallerLocation,
  formatCallerWarnings,
  identifierAt,
  isEditedLineCaller,
  MAX_CALLER_SYMBOLS,
  MAX_CALLERS_PER_SYMBOL,
  touchedSymbols,
} from "./callers";
import {
  type CallHierarchyIncomingCall,
  type CallHierarchyOutgoingCall,
  type CodeAction,
  closeFile,
  createClient,
  type Diagnostic,
  type DocumentSymbol,
  FileChangeType,
  fileToUri,
  findProjectRoot,
  type Hover,
  incomingCalls,
  LSP_REQUEST_TIMEOUT_MS,
  type LspClient,
  notifyFileChanges,
  notifySaved,
  openFile,
  outgoingCalls,
  prepareCallHierarchy,
  resolveCommand,
  type SymbolInformation,
  serverUriFor,
  syncFile,
  translateLocationUri,
  translateWorkspaceEdit,
  uriToFile,
  type WorkspaceEdit,
} from "./client";
import { DiagnosticsLedger } from "./dedup";
import {
  type ContainerTarget,
  detectTsFlavor,
  findDevcontainerRoot,
  readServerContainerConfig,
  resolveServerTarget,
} from "./devcontainer";
import {
  applyWorkspaceEdit,
  extractHoverText,
  formatDiagnostic,
  formatDiagnosticsSummary,
  formatDocumentSymbol,
  formatLocation,
  formatLocationWithContext,
  formatSymbolInformation,
  formatUnchangedLine,
  normalizeLocations,
  readLocationContext,
  resolveSymbolPosition,
  sortDiagnostics,
} from "./format";
import { type DetectedLinter, detectLinters, findLinterByExtension, lintersForFile, lintFile } from "./linters";
import { loadPathOverrides, matchPathOverride } from "./overrides";
import {
  configForTsFlavor,
  type DetectedServer,
  detectServers,
  findGatedLintersForFile,
  findServerByExtension,
  KNOWN_SERVERS,
  serverDisplayName,
  serversForFile,
} from "./servers";
import { createFileWatcher, type FileChange, type FileWatcher, WatchChangeType } from "./watcher";

// ── State ──

/** Active LSP clients, keyed by `serverName::rootPath` */
const clients = new Map<string, LspClient>();

/**
 * Diagnostics the agent has already been shown in post-edit blocks, so
 * repeated reports collapse unchanged errors to a single line. Cleared on
 * session start (a new conversation hasn't seen anything).
 */
const diagLedger = new DiagnosticsLedger();

/**
 * Whether the post-edit block collapses unchanged diagnostics (see diagLedger).
 * Toggled by `/lsp-dedup`; in-memory, resets on reload. Default on.
 */
let dedupEnabled = true;

/**
 * Resolved devcontainer targets per `serverName::rootPath`. Discovery (docker
 * inspect + binary probe + optional install) is non-trivial, so cache per session:
 * successes indefinitely, nulls for a short TTL so a container started mid-session
 * gets picked up. Cleared on shutdown and `/lsp-restart`.
 */
const targetCache = new Map<string, { target: ContainerTarget | null; expires: number }>();
const TARGET_NULL_TTL_MS = 60_000;

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

/**
 * Pre-edit file contents captured at `tool_call` (files touched by an edit
 * tool). Consumed by the post-edit caller warning in `tool_result`. Bounded:
 * an edit whose tool_result never fires (or is a cold server) can't leak the
 * map.
 */
const pendingPreEdit = new Map<string, string>();
const MAX_PENDING_EDIT = 200;

/**
 * Host-relative paths applied by the server via inbound `workspace/applyEdit`
 * during the most recent executeCommand (e.g. command-only actions like
 * move-to-file that typescript-language-server applies itself). Reset before
 * each executeCommand so codeActionApply can report what actually landed.
 */
let lastServerAppliedPaths: string[] | null = null;

// ── Client management ──

/**
 * Request code actions at a range. `context.diagnostics` carries the file's
 * known diagnostics on the queried range — required in practice: the TS7
 * native server returns NOTHING without them (verified live; VS Code passes
 * them too), and an empty unfiltered response is additionally retried with
 * the standard kinds since tsgo returns none without `only`.
 */
async function requestCodeActions(
  client: LspClient,
  uri: string,
  hostFile: string,
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
): Promise<CodeAction[]> {
  const known = client.diagnostics.get(fileToUri(hostFile)) ?? [];
  const inRange = known.filter((d) => d.range.start.line <= range.end.line && d.range.end.line >= range.start.line);
  const query = async (only?: string[]) =>
    (await client.request("textDocument/codeAction", {
      textDocument: { uri },
      range,
      context: { diagnostics: inRange, ...(only ? { only } : {}) },
    })) as CodeAction[];
  const raw = await query();
  if (raw && raw.length > 0) return raw;
  return query(["quickfix", "refactor", "source"]);
}
async function getClientAt(serverName: string, root: string): Promise<LspClient | null> {
  const key = clientKey(serverName, root);
  const existing = clients.get(key);
  if (existing && !existing.dead) return existing;

  // Look up server config
  const config = KNOWN_SERVERS[serverName];
  if (!config) return null;

  // The typescript server's command depends on the workspace's TypeScript
  // flavor: TS ≤6 runs typescript-language-server (spawns lib/tsserver.js);
  // TS7 (native) ships no tsserver.js — its own `tsc --lsp` speaks LSP
  // directly. `.lsp/<server>.json` `_command`/`_args` override the detection.
  // Containers are probed for `tsc` (globally installed alongside the server
  // in managed containers, present for BOTH flavors) so container selection is
  // flavor-independent; the actual spawn command is decided after, when the
  // workspace (which may live only in the container) can be inspected.
  const isTsServer = serverName === "typescript-language-server";
  const lspBase = findDevcontainerRoot(root) ?? root;
  const srv = readServerContainerConfig(lspBase, serverName);
  const probeCommand = srv.command ?? (isTsServer ? "tsc" : config.command);

  // Resolve a devcontainer target (null = host mode). Cached per session.
  let target: ContainerTarget | null = null;
  const cached = targetCache.get(key);
  if (cached && (cached.target !== null || cached.expires > Date.now())) {
    target = cached.target;
  } else {
    try {
      target = await resolveServerTarget(root, serverName, probeCommand, undefined, (msg) => {
        sessionCtx?.ui.notify(msg, "warning");
      });
    } catch {
      target = null;
    }
    targetCache.set(key, { target, expires: Date.now() + TARGET_NULL_TTL_MS });
  }

  // Effective spawn config: explicit `_command`/`_args` win; else auto-detect
  // the TypeScript flavor (container probe or host fs) and pick the command.
  let effective = config;
  if (srv.command) {
    effective = { ...config, command: srv.command, args: srv.args ?? [] };
  } else if (isTsServer) {
    const flavor = await detectTsFlavor(root, target);
    effective = configForTsFlavor(config, flavor);
  }

  try {
    let client: LspClient;
    client = await createClient(serverName, effective, root, target, {
      // Command-only actions (move-to-file et al.) have the server push the edit
      // back via inbound workspace/applyEdit; apply it and record what landed so
      // codeActionApply can report it (the executeCommand result itself is void).
      onApplyEdit: async (edit) => {
        const { applied } = await applyWorkspaceEdit(translateWorkspaceEdit(edit, client.pathMap), root, (editPath) => {
          syncFile(client, editPath);
        });
        lastServerAppliedPaths = applied.map((r) => r.path);
        return applied.length > 0;
      },
      // tls follows applyEdit with an inbound `_typescript.rename` refresh: rename
      // the symbol at the given location to itself (a no-op on content) so the
      // server's rename pipeline settles.
      onRename: async (params) => {
        try {
          const hostFile = uriToFile(translateLocationUri(params.textDocument.uri, client.pathMap));
          const name = identifierAt(hostFile, params.position);
          if (!name) return null;
          return await client.request("textDocument/rename", {
            textDocument: params.textDocument,
            position: params.position,
            newName: name,
          });
        } catch {
          return null; // best-effort refresh; the refactor edits already landed
        }
      },
    });
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
  const base = serversForFile(filePath, detectedServers);
  // Per-repo path overrides (.lsp/config.json `paths`): a glob may map a file
  // to a server its name hides (e.g. generated text holding SQL).
  const override = matchPathOverride(filePath, loadPathOverrides(currentCwd));
  let result: DetectedServer[];
  if (override) {
    const existing = detectedServers.find((s) => s.name === override);
    if (existing) {
      result = base.includes(existing) ? base : [...base, existing];
    } else {
      const config = KNOWN_SERVERS[override];
      const resolved = config ? resolveCommand(config.command, currentCwd) : null;
      if (!resolved) return base;
      const ds: DetectedServer = { name: override, config, resolvedCommand: resolved };
      detectedServers.push(ds);
      result = [...base, ds];
    }
  } else {
    result = base;
  }
  return appendGatedLinters(filePath, result);
}

/**
 * Repo-gated linters (oxlint, biome) serve any file whose tree carries
 * their config marker (or an `enabled` override), even when the session started
 * in a different directory. Detect on first touch and cache in detectedServers
 * so later calls are stable.
 */
function appendGatedLinters(filePath: string, base: DetectedServer[]): DetectedServer[] {
  let result = base;
  for (const ds of findGatedLintersForFile(filePath, currentCwd)) {
    if (detectedServers.some((s) => s.name === ds.name)) continue;
    detectedServers.push(ds);
    result = [...result, ds];
  }
  return result;
}

/**
 * Read-time warming: when the agent `read`s a code file, open it in its LSP
 * server in the background (didOpen) so the first interactive call
 * (symbols/hover/incoming) is warm instead of paying cold-parse latency.
 * Fire-and-forget — never blocks the read.
 *
 * Gated to pre-detected servers only: a `read` never triggers lazy discovery
 * (that stays an `lsp` tool concern). The server itself starts on demand if
 * not already running, matching session-start warming.
 */
async function warmRead(abs: string): Promise<void> {
  const servers = getServersForFile(abs);
  if (servers.length === 0) return;
  for (const server of servers) {
    const client = await getClientAt(server.name, rootForServer(server, abs));
    if (client) {
      await openFile(client, abs);
      return;
    }
  }
}

/**
 * Resolve the server root for a file: walk up from the file to the nearest
 * ancestor holding one of the server's root markers, falling back to currentCwd.
 * This is what makes a subproject file (e.g. a frontend under a repo root that
 * owns the devcontainer but has no package.json at its own root) root the server
 * at the subproject rather than at currentCwd.
 */
function rootForServer(server: DetectedServer, absFile: string): string {
  return findProjectRoot(absFile, server.config.rootMarkers) ?? currentCwd;
}

async function getClientForFile(filePath: string): Promise<{ client: LspClient; server: DetectedServer } | null> {
  const abs = path.resolve(filePath);

  // Find servers that handle this file's extension — pre-detected first, then a
  // lazy detect-by-extension if none.
  let servers = getServersForFile(abs);
  if (servers.length === 0) {
    const lazyFound = findServerByExtension(abs, currentCwd);
    if (lazyFound && !detectedServers.some((s) => s.name === lazyFound.name)) {
      detectedServers.push(lazyFound);
      updateStatusBar();
    }
    servers = getServersForFile(abs);
    if (servers.length === 0) return null;
  }

  // For each candidate server, resolve the root by walking up from the file to
  // the nearest root marker. Rooting at currentCwd is wrong when the server root
  // is a subproject inside (or outside) cwd — e.g. a frontend under a repo root
  // that owns the devcontainer but has no package.json at its own root. The
  // per-server walk-up handles inside-cwd, outside-cwd, and multi-root uniformly.
  for (const server of servers) {
    const client = await getClientAt(server.name, rootForServer(server, abs));
    if (client) return { client, server };
  }
  return null;
}

/** Timeout for progress entries that haven't been updated (ms). */
const PROGRESS_STALE_MS = 30_000;

function updateStatusBar(): void {
  if (!sessionCtx) return;

  // Expire stale progress entries (servers that sent 'begin' but never 'end')
  const now = Date.now();
  for (const client of clients.values()) {
    for (const [token, wp] of client.progress) {
      if (now - wp.lastUpdated > PROGRESS_STALE_MS) {
        client.progress.delete(token);
      }
    }
  }

  // Active progress takes over the pill (transient, user-relevant).
  const progressParts: string[] = [];
  for (const client of clients.values()) {
    if (client.dead) continue;
    for (const wp of client.progress.values()) {
      const pct = wp.percentage !== undefined ? ` ${wp.percentage}%` : "";
      progressParts.push(`${serverDisplayName(client.name)} ${wp.title}${pct}`);
    }
  }
  if (progressParts.length > 0) {
    sessionCtx.ui.setStatus("lsp", sessionCtx.ui.theme.fg("accent", `lsp:${progressParts.join(", ")}`));
    return;
  }

  // Otherwise show only RUNNING servers, capped. Detected-but-idle servers
  // and linters belong in `lsp status`, not the footer — with ~20 registered
  // servers a name list of everything detectable is pure noise.
  const running = [...new Set([...clients.values()].filter((c) => !c.dead).map((c) => serverDisplayName(c.name)))];
  if (running.length === 0) {
    sessionCtx.ui.setStatus("lsp", undefined);
    return;
  }
  const MAX_FOOTER_SERVERS = 4;
  const shown = running.slice(0, MAX_FOOTER_SERVERS).join(",");
  const more = running.length > MAX_FOOTER_SERVERS ? `,+${running.length - MAX_FOOTER_SERVERS}` : "";
  sessionCtx.ui.setStatus("lsp", sessionCtx.ui.theme.fg("muted", `lsp:${shown}${more}`));
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
  targetCache.clear();
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
    /**
     * If true (post-edit auto path), run the dedup ledger: only diagnostics
     * not previously shown are returned in `messages`, the rest in
     * `unchanged`. Explicit `lsp diagnostics` calls skip this — a deliberate
     * query always shows the full set.
     */
    dedupe?: boolean;
  } = {},
): Promise<{
  messages: string[];
  summary: string;
  errored: boolean;
  server?: string;
  unchanged?: Diagnostic[];
} | null> {
  const { explicit = false, timeoutMs, isNewFile = false, dedupe = false } = opts;
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

    const client = await getClientAt(server.name, rootForServer(server, abs));
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
  const summary = formatDiagnosticsSummary(unique);
  const errored = unique.some((d) => d.severity === 1);
  const server = sourceNames.join(", ");

  if (dedupe && dedupEnabled) {
    const split = diagLedger.reduce(abs, unique);
    return {
      messages: split.fresh.map((d) => formatDiagnostic(d, relPath)),
      summary,
      errored,
      server,
      unchanged: split.unchanged,
    };
  }

  return { messages: unique.map((d) => formatDiagnostic(d, relPath)), summary, errored, server };
}

/**
 * Best-effort caller warning for a just-edited file: which top-level symbols
 * the edit touched (diff of pre-edit vs on-disk content), and who calls them
 * via call-hierarchy. Bounded by MAX_CALLER_SYMBOLS / MAX_CALLERS_PER_SYMBOL.
 * Returns the `[LSP callers ...]` block or null when there's nothing worth
 * reporting (no server, no call-hierarchy support, nothing touched, no callers).
 * Never throws — it's a nudge, not a gate.
 */
async function editCallerWarnings(filePath: string, cwd: string): Promise<string | null> {
  const abs = path.resolve(cwd, filePath);
  const pre = pendingPreEdit.get(abs);
  pendingPreEdit.delete(abs);
  if (pre === undefined) return null; // not captured at tool_call, or a new file

  let post: string;
  try {
    post = fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
  if (pre === post) return null; // no-op edit

  const pair = await getClientForFile(abs);
  if (!pair) return null;
  const { client } = pair;
  // Gate on documentSymbol only: callHierarchyProvider is UNDERVERTISED by
  // several servers (classic typescript-language-server omits it from the
  // initialize response yet answers prepareCallHierarchy fine), so the flag
  // is an unreliable proxy — per-symbol try/catch handles unsupported servers.
  if (!client.capabilities.documentSymbolProvider) return null;

  await openFile(client, abs);
  await syncFile(client, abs);
  const uri = serverUriFor(client, abs);
  const raw = (await client.request("textDocument/documentSymbol", {
    textDocument: { uri },
  })) as (DocumentSymbol | SymbolInformation)[] | null;
  if (!raw || raw.length === 0 || !("selectionRange" in raw[0])) return null;
  const symbols = raw as DocumentSymbol[];

  const changed = changedLines(pre, post);
  const touched = touchedSymbols(symbols, changed).slice(0, MAX_CALLER_SYMBOLS);
  if (touched.length === 0) return null;

  const warnings: CallerWarningSymbol[] = [];
  for (const sym of touched) {
    try {
      const items = await prepareCallHierarchy(client, uri, sym.selectionRange.start);
      if (items.length === 0) continue;
      const item = items.find((it) => it.name === sym.name) ?? items[0];
      const calls = await incomingCalls(client, item);
      if (calls.length === 0) continue;
      // A caller item's `selectionRange` is the caller's own declaration — for
      // module-level call sites that's the file top (useless as a location).
      // The real call-site coordinates live in `fromRanges`; fall back for
      // servers that don't fill it.
      const sites: { hostFile: string; line0: number }[] = [];
      for (const c of calls) {
        const hostFile = uriToFile(translateLocationUri(c.from.uri, client.pathMap));
        const ranges = c.fromRanges.length > 0 ? c.fromRanges : [c.from.selectionRange];
        for (const r of ranges) sites.push({ hostFile, line0: r.start.line });
      }
      // Skip the edit's own new references (call sites on changed lines in the
      // edited file) — the diff already shows those. Keep external blast
      // radius: callers in unchanged parts of the file or other files.
      const kept = sites.filter((s) => !isEditedLineCaller(s.hostFile, s.line0, abs, changed));
      if (kept.length === 0) continue;
      const callers = kept.slice(0, MAX_CALLERS_PER_SYMBOL).map((s) => formatCallerLocation(s.hostFile, s.line0, cwd));
      warnings.push({
        name: sym.name,
        line: sym.selectionRange.start.line + 1,
        callers,
        totalCallers: kept.length,
      });
    } catch {
      // Per-symbol best-effort: one failing lookup shouldn't drop the others.
    }
  }
  if (warnings.length === 0) return null;

  return formatCallerWarnings(serverDisplayName(client.name), path.relative(cwd, abs), warnings);
}

// ── Extension entry point ──

export default function (pi: ExtensionAPI) {
  // ── Session lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = ctx.cwd;
    sessionCtx = ctx;
    detectedServers = detectServers(currentCwd);
    detectedLinters = detectLinters(currentCwd);
    diagLedger.clear();

    if (detectedServers.length === 0 && detectedLinters.length === 0) {
      // Don't spam -- just stay quiet if nothing found
      return;
    }

    updateStatusBar();

    // File watcher routes external changes (bash, git, other editors) to the
    // servers that care. Servers start on demand instead — read-time warming
    // and the lsp tool cover responsiveness, and eager-starting every
    // detected server (incl. JVM/.NET ones) at session start is waste.
    setTimeout(() => startFileWatcher(), 500);
  });

  pi.on("session_shutdown", async () => {
    stopFileWatcher();
    await shutdownAll();
  });

  // ── tool_call: read-time warming + pre-edit capture ──

  pi.on("tool_call", (event, ctx) => {
    // Read-time warming: background-open a read file in its LSP server so the
    // first interactive LSP call is already warm. Best-effort, never blocks.
    if (event.toolName === "read") {
      const p = (event.input as { path?: string } | undefined)?.path;
      if (p) void warmRead(path.resolve(ctx.cwd, p));
      return;
    }

    // Only file-mutating tools can invalidate callers.
    if (!EDIT_LIKE_TOOLS.includes(event.toolName)) return;
    const paths = collectToolPaths(event.toolName, event.input as Record<string, unknown>);
    if (paths.length === 0) return;
    for (const filePath of paths) {
      const abs = path.resolve(ctx.cwd, filePath);
      // Only matters for files an LSP server handles (skip big non-code files).
      if (getServersForFile(abs).length === 0) continue;
      try {
        pendingPreEdit.set(abs, fs.readFileSync(abs, "utf-8"));
      } catch {
        // Not on disk yet (a new `write` target): no callers to find.
      }
      if (pendingPreEdit.size > MAX_PENDING_EDIT) {
        pendingPreEdit.delete(pendingPreEdit.keys().next().value as string);
      }
    }
  });
  // ── Auto-diagnostics on edit/write ──

  pi.on("tool_result", async (event, ctx) => {
    const toolName = event.toolName;
    // LSP diagnostics only make sense after a file-mutating tool. The shared
    // set covers write/edit + the custom `patch` tool so diagnostics run after
    // patch too (else the reactive `}}`/`;;` catching silently skips it).
    if (!EDIT_LIKE_TOOLS.includes(toolName)) return;
    // Only `write` can create a file; edit/patch require oldText to match.
    const isWrite = toolName === "write";

    // Don't run diagnostics if the edit itself failed
    if (event.isError) return;

    // Collect target paths via the shared helper (patch may be multi-file).
    const paths = collectToolPaths(toolName, event.input as Record<string, unknown>);
    if (paths.length === 0) return;

    // Run diagnostics per path and accumulate. Only write can create new files.
    const multi = paths.length > 1;
    const diagParts: string[] = [];
    const callerParts: string[] = [];
    let anyErrored = false;
    for (const filePath of paths) {
      const isNewFile = isWrite && !isFileOpenInAnyClient(filePath, ctx.cwd);
      try {
        const result = await getDiagnosticsForFile(filePath, ctx.cwd, { isNewFile, dedupe: true });
        if (result) {
          const abs = path.resolve(ctx.cwd, filePath);
          const relPath = path.relative(ctx.cwd, abs);
          const label = multi ? ` ${relPath}` : "";
          const unchanged = result.unchanged ?? [];
          const unchangedCount = unchanged.length;
          if (result.messages.length === 0 && unchangedCount === 0) {
            diagParts.push(`[LSP diagnostics (${result.server})${label}: no errors, no warnings]`);
          } else {
            if (result.errored) anyErrored = true;
            // Collapse diagnostics the agent already saw: full detail only for
            // new ones; unchanged ones shrink to one location line.
            const delta = unchangedCount > 0 ? ` — ${result.messages.length} new, ${unchangedCount} unchanged` : "";
            const lines = [
              `[LSP diagnostics (${result.server})${label}: ${result.summary}${delta}]`,
              ...result.messages,
            ];
            if (unchangedCount > 0) lines.push(formatUnchangedLine(unchanged, relPath));
            diagParts.push(lines.join("\n"));
          }
        }
      } catch {
        // Non-fatal per file: continue with the rest
      }

      // Post-edit caller warning: symbols the edit touched + who calls them,
      // so the agent checks call sites that a clean type-check misses.
      try {
        const callers = await editCallerWarnings(filePath, ctx.cwd);
        if (callers) callerParts.push(callers);
      } catch {
        // Non-fatal / best-effort (cold server, no callHierarchy support).
      }
    }

    if (diagParts.length === 0 && callerParts.length === 0) return;
    const diagText = `\n\n${diagParts.join("\n\n")}`;
    const callerText = callerParts.length > 0 ? `\n\n${callerParts.join("\n\n")}` : "";
    const existingText = event.content[0]?.type === "text" ? event.content[0].text : "";

    // Notify the user in the UI about actual issues (skip clean notifications as noise)
    const hasIssues = diagParts.some((p) => !p.includes("no errors, no warnings"));
    if (hasIssues) {
      const level = anyErrored ? "error" : "warning";
      ctx.ui.notify(`LSP: ${diagParts.join("\n\n")}`, level);
    }

    return {
      content: [{ type: "text" as const, text: existingText + diagText + callerText }],
    };
  });

  // ── LSP tool ──

  const LSP_ACTIONS = [
    "diagnostics",
    "definition",
    "type_definition",
    "implementation",
    "references",
    "incoming",
    "outgoing",
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
    promptSnippet: `lsp: Language server operations (diagnostics, definition, type_definition, references, incoming, outgoing, hover, symbols, workspace_symbol, rename, codeAction, codeActionApply, restart, status). Use for type errors, go-to-definition, finding references, and refactorings.`,
    promptGuidelines: [
      "Before `read`ing a large source file (Rust, TS/JS, C#, Go, and other languages with a capable LSP server), use `lsp` with action `symbols` first. It returns a compact skeleton — top-level functions, structs/classes/interfaces with their fields, and line ranges — so you can `read` with `offset`/`limit` for just the symbol you need instead of the whole file. Useless for you on languages with weak servers (nixd, bash-language-server); fall back to `read` there. If a symbols call reports the server is still indexing, retry it immediately or use `read` directly.",
      "LSP diagnostics and lint results are automatically checked after every edit/write/patch and reported in the tool result. Call `lsp diagnostics` explicitly for fresh diagnostics after non-edit file changes (e.g., bash commands).",
      "Use `lsp` with action `definition` or `references` to navigate code instead of grepping for definitions.",
      "Use `lsp` with action `rename` to rename symbols across files instead of rg+sed/sd. It's semantically aware and handles all references. Provide `symbol` and `new_name`.",
      "Use `lsp` with action `references` or `incoming` to find who uses/ calls a symbol; `outgoing` shows what it calls. `incoming`/`outgoing` use call hierarchy (nearest callable definition), useful for blast-radius before a refactor.",
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
      name: Type.Optional(
        Type.String({
          description:
            "For codeActionApply: apply the action whose title contains this substring (case-insensitive) instead of by index",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { action, file, line, symbol, occurrence, new_name } = params;

      // ── Status ──
      if (action === "status") {
        return text(statusReport() ?? "No language servers or linters detected for this project.");
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
              // Translate each result's location URI server→host for that client.
              if (c.pathMap) {
                for (const s of raw) {
                  if (s?.location) s.location = { ...s.location, uri: translateLocationUri(s.location.uri, c.pathMap) };
                }
              }
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

        // Requests must carry the server's view of the path (container-translated
        // when mapped); host paths are for display and host-keyed maps only.
        const uri = serverUriFor(client, abs);

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
          // Hint when the resolved line differs from what the agent asked for.
          // The agent should know the fallback happened so it can calibrate trust.
          const fallbackHint = line !== undefined && displayLine !== line ? ` (resolved from nearby line ${line})` : "";
          posInfo = ` (symbol "${symbol}" at ${displayLine}:${resolved.character + 1} via ${method}${occInfo}${fallbackHint})`;
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
            const locs = normalizeLocations(raw, client.pathMap);
            if (locs.length === 0) {
              const ctx = readLocationContext(abs, displayLine, 2).join("\n");
              return text(`No definition found${posInfo}. Context around line ${displayLine}:\n${ctx}`);
            }
            const lines = locs.map((l) => formatLocationWithContext(l, ctx.cwd));
            return text(`Found ${locs.length} definition(s)${posInfo}:\n${lines.join("\n")}`);
          }

          case "type_definition": {
            const raw = await client.request("textDocument/typeDefinition", {
              textDocument: { uri },
              position,
            });
            const locs = normalizeLocations(raw, client.pathMap);
            if (locs.length === 0) {
              const ctx = readLocationContext(abs, displayLine, 2).join("\n");
              return text(`No type definition found${posInfo}. Context around line ${displayLine}:\n${ctx}`);
            }
            const lines = locs.map((l) => formatLocationWithContext(l, ctx.cwd));
            return text(`Found ${locs.length} type definition(s)${posInfo}:\n${lines.join("\n")}`);
          }

          case "implementation": {
            const raw = await client.request("textDocument/implementation", {
              textDocument: { uri },
              position,
            });
            const locs = normalizeLocations(raw, client.pathMap);
            if (locs.length === 0) {
              const ctx = readLocationContext(abs, displayLine, 2).join("\n");
              return text(`No implementation found${posInfo}. Context around line ${displayLine}:\n${ctx}`);
            }
            const lines = locs.map((l) => formatLocationWithContext(l, ctx.cwd));
            return text(`Found ${locs.length} implementation(s)${posInfo}:\n${lines.join("\n")}`);
          }

          case "references": {
            const raw = await client.request("textDocument/references", {
              textDocument: { uri },
              position,
              context: { includeDeclaration: true },
            });
            const locs = normalizeLocations(raw, client.pathMap);
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
            // Include posInfo when fallback resolved to a different line
            return text(`Found ${locs.length} reference(s)${posInfo}:\n${lines.join("\n")}`);
          }

          case "incoming":
          case "outgoing": {
            // Who calls this / what does this call (call hierarchy).
            const items = await prepareCallHierarchy(client, uri, position);
            if (items.length === 0) {
              return text(
                `No callable definition found${posInfo}. Context around line ${displayLine}:\n${readLocationContext(abs, displayLine, 2).join("\n")}`,
              );
            }
            const item = items.find((i) => i.name === (symbol ?? items[0].name)) ?? items[0];
            const calls = action === "incoming" ? await incomingCalls(client, item) : await outgoingCalls(client, item);
            if (calls.length === 0) {
              return text(action === "incoming" ? `No callers found${posInfo}` : `No outgoing calls found${posInfo}`);
            }
            // Caller items' `selectionRange` is the caller's own declaration;
            // for module-level call sites that's the file top. Use fromRanges
            // (the precise call-site coordinates) when present, so the line
            // shown is where the call actually happens.
            const MAX_HIERARCHY_RESULTS = 30;
            const nodes =
              action === "incoming"
                ? (calls as CallHierarchyIncomingCall[]).map((c) => ({
                    item: c.from,
                    line0: (c.fromRanges[0] ?? c.from.selectionRange).start.line,
                  }))
                : (calls as CallHierarchyOutgoingCall[]).map((c) => ({
                    item: c.to,
                    line0: c.to.selectionRange.start.line,
                  }));
            const lines = nodes.slice(0, MAX_HIERARCHY_RESULTS).map(({ item, line0 }) => {
              const hostFile = uriToFile(translateLocationUri(item.uri, client.pathMap));
              return `  ${formatCallerLocation(hostFile, line0, ctx.cwd)} — ${item.name}`;
            });
            if (nodes.length > MAX_HIERARCHY_RESULTS) lines.push(`  ... ${nodes.length - MAX_HIERARCHY_RESULTS} more`);
            const verb = action === "incoming" ? "callers" : "calls";
            return text(`Found ${calls.length} ${verb}${posInfo}:\n${lines.join("\n")}`);
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
            const hoverText = extractHoverText(raw.contents);
            if (line !== undefined && displayLine !== line) {
              return text(`${posInfo}\n${hoverText}`);
            }
            return text(hoverText);
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
                  `${serverDisplayName(server.name)} is still indexing ${path.relative(ctx.cwd, abs)} (timed out after ${LSP_REQUEST_TIMEOUT_MS / 1000}s). The file analysis continues in the background — try again immediately, or use read with offset/limit in the meantime.`,
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
            })) as WorkspaceEdit | null;

            if (!raw || ((!raw.changes || Object.keys(raw.changes).length === 0) && !raw.documentChanges?.length)) {
              const context = readLocationContext(abs, displayLine, 3).join("\n");
              // If the symbol resolved (semantically or textually) but the
              // server returned no edits, the most common cause is a server
              // that hasn't finished indexing this file for the rename/
              // references provider yet — the read-only providers (hover,
              // references, documentSymbol) often warm up before rename does.
              // The reliable fix is to run `references` first (it confirms the
              // symbol AND warms the index), then retry rename.
              const warmHint = resolved.found
                ? "\n\nThe symbol resolved at this position, so the server may still be indexing for the rename provider. This is often transient — retry, or run `references` first (it warms the index and confirms the symbol)."
                : "";
              return text(
                `Rename failed — no renameable symbol found at line ${displayLine}${symbol ? `, symbol "${symbol}"` : ""}.${warmHint}\n\nContext around line ${displayLine}:\n${context}\n\nCheck: is the line number correct? Use the \`symbol\` parameter to target a specific identifier.`,
              );
            }

            // Apply the edits. rust-analyzer returns `documentChanges`;
            // tsserver/others may return `changes`. applyWorkspaceEdit handles
            // both (documentChanges is authoritative when present) and syncs
            // each file back to the server so subsequent renames use fresh
            // positions instead of corrupting the file.
            const { applied, unsupported } = await applyWorkspaceEdit(
              translateWorkspaceEdit(raw, client.pathMap),
              ctx.cwd,
              (editPath) => {
                syncFile(client, editPath);
              },
            );

            const lines = applied.map((r) => `  ${r.path}: ${r.count} edit(s)`);
            if (unsupported.length > 0) {
              lines.push(`  (skipped unsupported resource ops: ${unsupported.join(", ")})`);
            }
            return text(`Renamed to "${new_name}":\n${lines.join("\n")}`);
          }

          case "codeAction": {
            // Query available code actions at the cursor position. Use the
            // RESOLVED symbol position (the identifier, not line-start) —
            // servers like tsserver only offer declaration refactors
            // (e.g. move-to-file) when the cursor is on the declaration name.
            const raw = await requestCodeActions(client, uri, abs, {
              start: { line: resolved.line, character: resolved.character },
              end: { line: resolved.line, character: resolved.character },
            });

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
            lines.push(
              "To apply: use action 'codeActionApply' with the index of the action (or `name` for a substring of the title).",
            );
            return text(lines.join("\n"));
          }

          case "codeActionApply": {
            const idx = params.index;
            const name = params.name;
            if ((idx === undefined || idx < 0) && !name) {
              return text("Error: index or name parameter required. Use 'codeAction' first to see available actions.");
            }

            // Query available code actions (same resolved-name position as
            // the listing above, so declaration refactors surface).
            const raw = await requestCodeActions(client, uri, abs, {
              start: { line: resolved.line, character: resolved.character },
              end: { line: resolved.line, character: resolved.character },
            });

            if (!raw || raw.length === 0) return text("No code actions available at this position");

            // Select by name (substring, case-insensitive) when given — index
            // ordering can shift between queries — else by index.
            let selected: CodeAction;
            if (name) {
              const q = name.toLowerCase();
              const found = raw.find((a) => a.title.toLowerCase().includes(q));
              if (!found) {
                return text(
                  `No code action matching "${name}". Available: ${raw.map((a) => `"${a.title}"`).join(", ")}`,
                );
              }
              selected = found;
            } else {
              if (idx === undefined || idx >= raw.length) {
                return text(`Invalid index ${idx}. Available actions: 0-${raw.length - 1}`);
              }
              selected = raw[idx];
            }

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

            const apply = async (edit: WorkspaceEdit): Promise<string> => {
              const { applied, unsupported } = await applyWorkspaceEdit(
                translateWorkspaceEdit(edit, client.pathMap),
                ctx.cwd,
                (editPath) => {
                  syncFile(client, editPath);
                },
              );
              const appliedLines = applied.map((r) => `  ${r.path}: ${r.count} edit(s)`);
              if (unsupported.length > 0) {
                appliedLines.push(`  (skipped unsupported resource ops: ${unsupported.join(", ")})`);
              }
              return appliedLines.join("\n");
            };

            // Declarative edit → apply it directly.
            if (resolvedAction.edit) {
              return text(`Applied "${selected.title}":\n${await apply(resolvedAction.edit)}`);
            }

            // Command-only action (e.g. Move to a new file): execute the command
            // and apply the WorkspaceEdit it returns. The action's own arguments
            // carry the position/range. Two outcomes: the server returns the edit
            // as the result, OR (typescript-language-server) the server pushes it
            // back via inbound workspace/applyEdit and the result is void — those
            // applied paths are recorded on lastServerApplied.
            if (resolvedAction.command) {
              lastServerAppliedPaths = null;
              const result = (await client.request("workspace/executeCommand", {
                command: resolvedAction.command.command,
                arguments: resolvedAction.command.arguments ?? [],
              })) as WorkspaceEdit | null;
              const serverApplied = lastServerAppliedPaths as string[] | null;
              if (serverApplied && serverApplied.length > 0) {
                return text(
                  `Executed "${selected.title}" (${resolvedAction.command.command}):\n${serverApplied
                    .map((p) => `  ${p}`)
                    .join("\n")}`,
                );
              }
              if (
                result &&
                ((result.changes && Object.keys(result.changes).length > 0) || result.documentChanges?.length)
              ) {
                return text(
                  `Executed "${selected.title}" (${resolvedAction.command.command}):\n${await apply(result)}`,
                );
              }
              return text(
                `Command "${resolvedAction.command.command}" executed but returned no edits. It may require editor-side confirmation or act outside the workspace.`,
              );
            }

            return text(`Code action "${selected.title}" has no edit and no executable command.`);
          }

          default:
            return text(`Unknown action: ${action}`);
        }
      } catch (err) {
        // The client prepends "LSP error: " to JSON-RPC error rejections; strip
        // it here so we don't get the doubled "LSP error (server): LSP error: …".
        const raw = err instanceof Error ? err.message : String(err);
        const msg = raw.replace(/^LSP error:\s*/, "");
        // Some server errors right after opening a file are transient: the
        // server hasn't finished indexing the rename/references provider even
        // though it parsed the file for read-only queries. JSON-RPC codes:
        //   -32602 InvalidParams (rust-analyzer: "No references found at position")
        //   -32801 ContentModified (the document changed under the server)
        // Neither means the call is permanently wrong. Tell the agent it's
        // likely transient and how to warm the index, rather than letting it
        // bail to a manual fallback on the first failure.
        const transientHint = /\(-32602\)|\(-32801\)/.test(msg)
          ? " This is often transient (the server may still be indexing after opening the file) — retry, or run `references` first to warm the index and confirm the symbol resolves."
          : "";
        return text(`LSP error (${serverDisplayName(server.name)}): ${msg}${transientHint}`);
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
      const report = statusReport();
      ctx.ui.notify(report ?? "No language servers or linters detected for this project", report ? "info" : "warning");
    },
  });

  pi.registerCommand("lsp-dedup", {
    description: "Toggle collapsing of unchanged diagnostics in post-edit blocks",
    handler: async (_args, ctx) => {
      dedupEnabled = !dedupEnabled;
      ctx.ui.notify(`LSP: unchanged diagnostics ${dedupEnabled ? "collapse" : "reported in full"} after edits`, "info");
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

/** Host vs container label for status output, so it's visible where each server runs. */
function modeLabel(client: LspClient): string {
  return client.containerName ? `[container:${client.containerName}]` : "[host]";
}

/**
 * Command annotation for status lines: the effective spawn command when it
 * differs from the server key's default (flavor detection or `_command`
 * override picked another binary — e.g. `ts (tsc --lsp)` for a TS7 project).
 */
function commandLabel(name: string, client: LspClient | undefined): string {
  if (!client) return "";
  const def = KNOWN_SERVERS[name];
  const defaultCmd = def ? [def.command, ...(def.args ?? [])].join(" ") : undefined;
  return client.command !== defaultCmd ? ` (${client.command})` : "";
}

/**
 * Unified status report: detected servers at cwd + active clients at OTHER roots
 * (e.g. a subproject's container-routed server) + linters. Shared by the `lsp
 * status` tool action and the `/lsp` command so they can't drift apart. Returns
 * null when there's nothing to show.
 */
function statusReport(): string | null {
  if (detectedServers.length === 0 && detectedLinters.length === 0 && clients.size === 0) return null;
  const lines: string[] = [];
  if (detectedServers.length > 0) {
    lines.push(`Detected ${detectedServers.length} language server(s) for ${currentCwd}:`);
    for (const s of detectedServers) {
      const client = clients.get(clientKey(s.name, currentCwd));
      const status =
        client && !client.dead ? `running (${formatUptime(client.createdAt)}) ${modeLabel(client)}` : "available";
      const cmd = client && !client.dead ? commandLabel(s.name, client) : "";
      lines.push(`  ${serverDisplayName(s.name)}${cmd} (${s.config.fileTypes.join(", ")}) — ${status}`);
    }
  }
  const otherRoots = [...clients.entries()].filter(([key]) => parseClientKey(key).root !== currentCwd);
  if (otherRoots.length > 0) {
    lines.push(``);
    lines.push(`Active servers for other projects (${otherRoots.length}):`);
    for (const [key, client] of otherRoots) {
      const { serverName, root } = parseClientKey(key);
      const relRoot = path.relative(currentCwd, root);
      const status = !client.dead ? `running (${formatUptime(client.createdAt)}) ${modeLabel(client)}` : "dead";
      const cmd = !client.dead ? commandLabel(serverName, client) : "";
      lines.push(`  ${serverDisplayName(serverName)}${cmd} @ ${relRoot} — ${status}`);
    }
  }
  if (detectedLinters.length > 0) {
    lines.push(``);
    lines.push(`Detected ${detectedLinters.length} linter(s):`);
    for (const l of detectedLinters) {
      lines.push(`  ${l.name} (${l.config.fileTypes.join(", ")}) — cli`);
    }
  }
  if (!dedupEnabled) {
    lines.push(``);
    lines.push(`Diagnostic collapse: off (unchanged errors reported in full after every edit)`);
  }
  return lines.join("\n");
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}
