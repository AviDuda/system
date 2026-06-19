/**
 * LSP JSON-RPC client over stdio.
 *
 * Spawns a language server process, speaks JSON-RPC 2.0 over stdin/stdout.
 * Handles initialization, text document sync, and request/response routing.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { deepMerge } from "../shared/deep-merge";

// ── Types ──

/** Glob pattern registered by a server for file watching */
export interface RegisteredWatcher {
  globPattern: string;
  /** Bitmask: 1=Create, 2=Change, 4=Delete. Default 7 (all). */
  kind: number;
}

/** Progress state for a work done token */
export interface WorkDoneProgress {
  /** Token identifying this progress */
  token: string | number;
  /** Current state */
  state: "started" | "reporting" | "done";
  /** Progress title (from 'begin') */
  title: string;
  /** Optional status message */
  message?: string;
  /** Optional percentage 0-100 */
  percentage?: number;
  /** Timestamp of last update (ms since epoch) */
  lastUpdated: number;
}

export interface LspClient {
  /** Server process */
  proc: ChildProcess;
  /** Server name (for logging) */
  name: string;
  /** Resolved server capabilities from initialize response */
  capabilities: ServerCapabilities;
  /** Currently open files (URI -> version) */
  openFiles: Map<string, number>;
  /** Latest diagnostics per URI */
  diagnostics: Map<string, Diagnostic[]>;
  /** Monotonic version counter for diagnostics (increments on any publish) */
  diagnosticsVersion: number;
  /** Glob patterns registered by the server via client/registerCapability */
  registeredWatchers: RegisteredWatcher[];
  /** Active work done progress tokens */
  progress: Map<string | number, WorkDoneProgress>;
  /** Callback invoked when progress state changes */
  onProgress: ((progress: WorkDoneProgress) => void) | undefined;
  /** Send a JSON-RPC request and wait for response */
  request: (method: string, params?: unknown) => Promise<unknown>;
  /** Send a JSON-RPC notification (no response expected) */
  notify: (method: string, params?: unknown) => void;
  /** Shut down gracefully */
  shutdown: () => Promise<void>;
  /** Whether the client has been shut down */
  dead: boolean;
  /** When this client was created (ms since epoch) */
  createdAt: number;
}

export interface ServerCapabilities {
  textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | { includeText?: boolean } };
  completionProvider?: unknown;
  hoverProvider?: boolean | object;
  definitionProvider?: boolean | object;
  typeDefinitionProvider?: boolean | object;
  implementationProvider?: boolean | object;
  referencesProvider?: boolean | object;
  documentSymbolProvider?: boolean | object;
  workspaceSymbolProvider?: boolean | object;
  codeActionProvider?: boolean | object;
  documentFormattingProvider?: boolean | object;
  renameProvider?: boolean | object;
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  originSelectionRange?: Range;
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}

export interface Diagnostic {
  range: Range;
  severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
  code?: number | string;
  source?: string;
  message: string;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: unknown[];
}

export interface Hover {
  contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>;
  range?: Range;
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string; reasonCode?: string };
  command?: { title: string; command: string; arguments?: unknown[] };
  edit?: WorkspaceEdit;
  editRange?: { range: Range; replacementText: string };
  data?: unknown;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

// ── JSON-RPC transport ──

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function createTransport(proc: ChildProcess) {
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  let buffer = "";
  let contentLength = -1;
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  const requestHandlers = new Map<string, (params: unknown) => unknown>();

  const stdout = proc.stdout;
  if (!stdout) throw new Error("LSP process has no stdout");
  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    while (true) {
      if (contentLength === -1) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const header = buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        contentLength = parseInt(match[1], 10);
        buffer = buffer.slice(headerEnd + 4);
      }

      if (buffer.length < contentLength) break;

      const body = buffer.slice(0, contentLength);
      buffer = buffer.slice(contentLength);
      contentLength = -1;

      try {
        const msg = JSON.parse(body) as JsonRpcMessage;
        if (msg.id !== undefined && !msg.method) {
          // Response to our request
          const req = pending.get(msg.id);
          if (req) {
            pending.delete(msg.id);
            if (msg.error) {
              req.reject(new Error(`LSP error: ${msg.error.message} (${msg.error.code})`));
            } else {
              req.resolve(msg.result);
            }
          }
        } else if (msg.method && msg.id !== undefined) {
          // Server-to-client request (needs response)
          const reqHandler = requestHandlers.get(msg.method);
          if (reqHandler) {
            try {
              const result = reqHandler(msg.params);
              send({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
            } catch (e) {
              send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } });
            }
          } else {
            send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
          }
        } else if (msg.method) {
          // Server-to-client notification (no response)
          const handler = notificationHandlers.get(msg.method);
          if (handler) handler(msg.params);
        }
      } catch {
        // Ignore parse errors
      }
    }
  });

  function send(msg: object) {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    const stdin = proc.stdin;
    if (!stdin) throw new Error("LSP process has no stdin");
    stdin.write(header + body);
  }

  function request(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`LSP request timed out: ${method} (${LSP_REQUEST_TIMEOUT_MS / 1000}s)`));
      }, LSP_REQUEST_TIMEOUT_MS);

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(method: string, params?: unknown) {
    send({ jsonrpc: "2.0", method, params });
  }

  function onNotification(method: string, handler: (params: unknown) => void) {
    notificationHandlers.set(method, handler);
  }

  function onRequest(method: string, handler: (params: unknown) => unknown) {
    requestHandlers.set(method, handler);
  }

  function cleanup() {
    for (const [, req] of pending) {
      req.reject(new Error("LSP client shut down"));
    }
    pending.clear();
  }

  return { request, notify, onNotification, onRequest, cleanup };
}

// ── Client lifecycle ──

/**
 * Per-request timeout for LSP calls (ms). When a request exceeds this the
 * client rejects with "LSP request timed out: <method> (Ns)"; callers decide
 * whether to surface that as an error or treat it as a cold-server signal
 * (e.g. the symbols action retries immediately and marks the server cold).
 */
export const LSP_REQUEST_TIMEOUT_MS = 10_000;

const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: {
      didSave: true,
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
    },
    hover: { contentFormat: ["markdown", "plaintext"], dynamicRegistration: false },
    definition: { dynamicRegistration: false, linkSupport: true },
    typeDefinition: { dynamicRegistration: false, linkSupport: true },
    implementation: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentSymbol: {
      dynamicRegistration: false,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
    },
    codeAction: { dynamicRegistration: false },
    formatting: { dynamicRegistration: false },
    rename: { dynamicRegistration: false, prepareSupport: true },
    publishDiagnostics: { relatedInformation: true },
  },
  window: {
    workDoneProgress: true,
  },
  workspace: {
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: false },
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    symbol: { dynamicRegistration: false },
  },
};

export interface ServerConfig {
  command: string;
  args?: string[];
  fileTypes: string[];
  rootMarkers: string[];
  initOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export function fileToUri(filePath: string): string {
  const abs = path.resolve(filePath);
  return `file://${abs}`;
}

export function uriToFile(uri: string): string {
  return uri.replace(/^file:\/\//, "");
}

/**
 * Detect language ID from file extension.
 */
export function detectLanguageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".rs": "rust",
    ".go": "go",
    ".mod": "gomod",
    ".py": "python",
    ".pyi": "python",
    ".nix": "nix",
    ".lua": "lua",
    ".sh": "shellscript",
    ".bash": "shellscript",
    ".zsh": "shellscript",
    ".json": "json",
    ".jsonc": "jsonc",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".md": "markdown",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".java": "java",
    ".rb": "ruby",
    ".ex": "elixir",
    ".exs": "elixir",
    ".hs": "haskell",
    ".swift": "swift",
  };
  return map[ext] ?? "plaintext";
}

/**
 * Strip reserved metadata keys from a config object. Currently supports:
 *   _comment  — string or array of strings (inline notes)
 *   _meta     — arbitrary object (future-proofing)
 * These are never passed to the LSP server.
 */
function stripMeta(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "_comment" || key === "_meta") continue;
    result[key] =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? stripMeta(value as Record<string, unknown>)
        : value;
  }
  return result;
}

/**
 * Load project-specific LSP settings from .lsp/<server-name>.json.
 * Supports _comment and _meta fields for inline notes (stripped before merging).
 * Settings are deep-merged with server defaults (project settings take priority).
 * Returns empty object if no .lsp/ directory or file exists.
 */
export async function loadLspSettings(cwd: string, serverName: string): Promise<Record<string, unknown>> {
  const lspDir = path.join(cwd, ".lsp");
  const settingsFile = path.join(lspDir, `${serverName}.json`);

  if (!fs.existsSync(lspDir)) return {};

  try {
    const raw = await fs.promises.readFile(settingsFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(".lsp/<server>.json must contain a JSON object");
    }
    return stripMeta(parsed);
  } catch {
    // No .lsp/ dir, no file, or parse error — return empty
    return {};
  }
}

/**
 * Check if any root marker exists in a directory.
 */
export function hasRootMarkers(cwd: string, markers: string[]): boolean {
  for (const marker of markers) {
    if (marker.includes("*")) {
      // Simple glob: check if any file matches
      try {
        const dir = fs.readdirSync(cwd);
        const pattern = marker.replace("*", "");
        if (dir.some((f) => f.endsWith(pattern))) return true;
      } catch {}
    } else if (fs.existsSync(path.join(cwd, marker))) {
      return true;
    }
  }
  return false;
}

/**
 * Create and initialize an LSP client.
 */
export async function createClient(
  name: string,
  config: ServerConfig,
  cwd: string,
  timeoutMs = 10_000,
): Promise<LspClient> {
  // Resolve command: check node_modules/.bin, .venv/bin, then PATH
  const resolvedCommand = resolveCommand(config.command, cwd);
  if (!resolvedCommand) {
    throw new Error(`LSP server binary not found: ${config.command}`);
  }

  const proc = spawn(resolvedCommand, config.args ?? [], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });

  // Collect stderr for error reporting
  let stderrBuf = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    // Keep only last 2KB
    if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048);
  });

  const transport = createTransport(proc);
  const diagnostics = new Map<string, Diagnostic[]>();
  let diagnosticsVersion = 0;

  const registeredWatchers: RegisteredWatcher[] = [];

  // Handle diagnostic notifications
  transport.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
    const p = params as { uri: string; diagnostics: Diagnostic[] };
    diagnostics.set(p.uri, p.diagnostics);
    diagnosticsVersion++;
  });

  // Handle server-to-client requests
  transport.onRequest("client/registerCapability", (params: unknown) => {
    const p = params as {
      registrations: Array<{
        id: string;
        method: string;
        registerOptions?: {
          watchers?: Array<{ globPattern: string | { baseUri?: string; pattern: string }; kind?: number }>;
        };
      }>;
    };
    for (const reg of p.registrations) {
      if (reg.method === "workspace/didChangeWatchedFiles" && reg.registerOptions?.watchers) {
        for (const w of reg.registerOptions.watchers) {
          const glob = typeof w.globPattern === "string" ? w.globPattern : w.globPattern.pattern;
          registeredWatchers.push({ globPattern: glob, kind: w.kind ?? 7 });
        }
      }
    }
    return null;
  });

  transport.onRequest("client/unregisterCapability", (params: unknown) => {
    const p = params as { unregisterations: Array<{ id: string; method: string }> };
    for (const unreg of p.unregisterations) {
      if (unreg.method === "workspace/didChangeWatchedFiles") {
        // Remove all watchers (unregister doesn't specify which patterns, just the registration ID)
        registeredWatchers.length = 0;
      }
    }
    return null;
  });

  transport.onRequest("workspace/configuration", (params: unknown) => {
    // Return empty settings for each requested item
    const p = params as { items?: unknown[] };
    return (p.items ?? []).map(() => ({}));
  });

  // Initialize
  // Merge server defaults with project-specific .lsp/<server>.json settings
  const projectSettings = await loadLspSettings(cwd, name);
  const initOptions = projectSettings
    ? deepMerge(config.initOptions ?? {}, projectSettings)
    : (config.initOptions ?? {});

  const initResult = (await Promise.race([
    transport.request("initialize", {
      processId: process.pid,
      capabilities: CLIENT_CAPABILITIES,
      rootUri: fileToUri(cwd),
      workspaceFolders: [{ uri: fileToUri(cwd), name: path.basename(cwd) }],
      initializationOptions: initOptions,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`LSP initialize timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ])) as { capabilities: ServerCapabilities };

  transport.notify("initialized", {});

  // Send initial settings if configured
  if (config.settings) {
    transport.notify("workspace/didChangeConfiguration", { settings: config.settings });
  }

  const openFiles = new Map<string, number>();
  const progressMap = new Map<string | number, WorkDoneProgress>();

  // Handle work done progress notifications
  // window/workDoneProgress/create is a server-to-client request
  transport.onRequest("window/workDoneProgress/create", (_params: unknown) => {
    // Just acknowledge -- the actual progress comes via $/progress
    return null;
  });

  transport.onNotification("$/progress", (params: unknown) => {
    const p = params as { token: string | number; value: Record<string, unknown> };
    const token = p.token;
    const kind = p.value.kind;

    if (kind === "begin") {
      const wp: WorkDoneProgress = {
        token,
        state: "started",
        title: (p.value.title as string) ?? "",
        message: p.value.message as string | undefined,
        percentage: p.value.percentage as number | undefined,
        lastUpdated: Date.now(),
      };
      progressMap.set(token, wp);
      client.onProgress?.(wp);
    } else if (kind === "report") {
      const existing = progressMap.get(token);
      if (existing) {
        existing.state = "reporting";
        existing.message = (p.value.message as string) ?? existing.message;
        existing.percentage = (p.value.percentage as number) ?? existing.percentage;
        existing.lastUpdated = Date.now();
        client.onProgress?.(existing);
      }
    } else if (kind === "end") {
      const existing = progressMap.get(token);
      if (existing) {
        existing.state = "done";
        existing.message = (p.value.message as string) ?? existing.message;
        existing.lastUpdated = Date.now();
        client.onProgress?.(existing);
      }
      progressMap.delete(token);
    }
  });

  const client: LspClient = {
    createdAt: Date.now(),
    proc,
    name,
    capabilities: initResult.capabilities,
    openFiles,
    diagnostics,
    diagnosticsVersion,
    registeredWatchers,
    progress: progressMap,
    onProgress: undefined,
    request: transport.request,
    notify: transport.notify,
    dead: false,

    async shutdown() {
      if (client.dead) return;
      client.dead = true;
      try {
        await Promise.race([transport.request("shutdown", null), new Promise((resolve) => setTimeout(resolve, 3000))]);
        transport.notify("exit", null);
      } catch {
        // Best effort
      }
      transport.cleanup();
      proc.kill();
    },
  };

  // Handle process exit
  proc.on("exit", () => {
    client.dead = true;
    transport.cleanup();
  });

  return client;
}

/**
 * Open a file in the LSP server (textDocument/didOpen).
 */
export async function openFile(client: LspClient, filePath: string): Promise<void> {
  const uri = fileToUri(filePath);
  if (client.openFiles.has(uri)) return;

  const content = await fs.promises.readFile(filePath, "utf-8");
  const languageId = detectLanguageId(filePath);
  client.openFiles.set(uri, 1);

  client.notify("textDocument/didOpen", {
    textDocument: { uri, languageId, version: 1, text: content },
  });
}

/**
 * Sync file content to LSP server (didOpen or didChange).
 * Returns the synced text (for passing to notifySaved with includeText).
 */
export async function syncFile(client: LspClient, filePath: string, content?: string): Promise<string> {
  const uri = fileToUri(filePath);
  const text = content ?? (await fs.promises.readFile(filePath, "utf-8"));

  if (!client.openFiles.has(uri)) {
    const languageId = detectLanguageId(filePath);
    client.openFiles.set(uri, 1);
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  } else {
    const version = (client.openFiles.get(uri) ?? 0) + 1;
    client.openFiles.set(uri, version);
    client.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }
  return text;
}

/**
 * Close a file in the LSP server (textDocument/didClose).
 * Removes from openFiles tracking. Servers drop their in-memory state for the file.
 */
export function closeFile(client: LspClient, filePath: string): void {
  const uri = fileToUri(filePath);
  if (!client.openFiles.has(uri)) return;
  client.openFiles.delete(uri);
  client.notify("textDocument/didClose", { textDocument: { uri } });
}

/**
 * Notify the server that a file was saved.
 * Includes file text if the server requested it via capabilities.
 */
export function notifySaved(client: LspClient, filePath: string, text?: string): void {
  const uri = fileToUri(filePath);
  const sync = client.capabilities.textDocumentSync;
  const wantsText = typeof sync === "object" && typeof sync.save === "object" && sync.save.includeText === true;

  if (wantsText && text !== undefined) {
    client.notify("textDocument/didSave", { textDocument: { uri }, text });
  } else {
    client.notify("textDocument/didSave", { textDocument: { uri } });
  }
}

/** FileChangeType from LSP spec */
export const FileChangeType = { Created: 1, Changed: 2, Deleted: 3 } as const;

/**
 * Notify the server about file create/change/delete events.
 * Sends workspace/didChangeWatchedFiles so servers can update their index.
 */
export function notifyFileChanges(
  client: LspClient,
  changes: Array<{ uri: string; type: (typeof FileChangeType)[keyof typeof FileChangeType] }>,
): void {
  if (changes.length === 0) return;
  client.notify("workspace/didChangeWatchedFiles", { changes });
}

/**
 * Resolve a command to an executable path.
 * Checks project-local bin directories, then PATH.
 */
export function resolveCommand(command: string, cwd: string): string | null {
  // Check node_modules/.bin
  const nmBin = path.join(cwd, "node_modules", ".bin", command);
  if (fs.existsSync(nmBin)) return nmBin;

  // Check .venv/bin
  const venvBin = path.join(cwd, ".venv", "bin", command);
  if (fs.existsSync(venvBin)) return venvBin;

  // Check PATH
  const { execSync } = require("node:child_process");
  try {
    const resolved = execSync(`which ${command}`, { encoding: "utf-8", timeout: 3000 }).trim();
    if (resolved) return resolved;
  } catch {
    // Not found
  }

  return null;
}
