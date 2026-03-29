/**
 * LSP JSON-RPC client over stdio.
 *
 * Spawns a language server process, speaks JSON-RPC 2.0 over stdin/stdout.
 * Handles initialization, text document sync, and request/response routing.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──

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
          // Response
          const req = pending.get(msg.id);
          if (req) {
            pending.delete(msg.id);
            if (msg.error) {
              req.reject(new Error(`LSP error: ${msg.error.message} (${msg.error.code})`));
            } else {
              req.resolve(msg.result);
            }
          }
        } else if (msg.method) {
          // Notification or server request
          const handler = notificationHandlers.get(msg.method);
          if (handler) handler(msg.params);
          // Server requests (with id) that we don't handle -- respond with method not found
          if (msg.id !== undefined) {
            send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
          }
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
      const REQUEST_TIMEOUT_MS = 10_000;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`LSP request timed out: ${method} (${REQUEST_TIMEOUT_MS / 1000}s)`));
      }, REQUEST_TIMEOUT_MS);

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

  function cleanup() {
    for (const [, req] of pending) {
      req.reject(new Error("LSP client shut down"));
    }
    pending.clear();
  }

  return { request, notify, onNotification, cleanup };
}

// ── Client lifecycle ──

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
  workspace: {
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: false },
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

  // Handle diagnostic notifications
  transport.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
    const p = params as { uri: string; diagnostics: Diagnostic[] };
    diagnostics.set(p.uri, p.diagnostics);
    diagnosticsVersion++;
  });

  // Handle workspace/configuration requests (some servers require this)
  transport.onNotification("workspace/configuration", () => {
    // Return empty settings
  });

  // Initialize
  const initResult = (await Promise.race([
    transport.request("initialize", {
      processId: process.pid,
      capabilities: CLIENT_CAPABILITIES,
      rootUri: fileToUri(cwd),
      workspaceFolders: [{ uri: fileToUri(cwd), name: path.basename(cwd) }],
      initializationOptions: config.initOptions ?? {},
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

  const client: LspClient = {
    createdAt: Date.now(),
    proc,
    name,
    capabilities: initResult.capabilities,
    openFiles,
    diagnostics,
    diagnosticsVersion,
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
 */
export async function syncFile(client: LspClient, filePath: string, content?: string): Promise<void> {
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
}

/**
 * Notify the server that a file was saved.
 */
export function notifySaved(client: LspClient, filePath: string): void {
  const uri = fileToUri(filePath);
  client.notify("textDocument/didSave", { textDocument: { uri } });
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
