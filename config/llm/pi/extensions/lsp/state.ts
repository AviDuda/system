/**
 * Engine state and shared types for the LSP engine.
 *
 * The engine is a set of focused modules (client-mgmt, file-events,
 * diagnostics, hooks, status, actions) that all operate on a single
 * `EngineState` created here. No pi imports — the adapter (index.ts) wires
 * this to a harness through the `LspHost` interface.
 */

import type { Diagnostic, LspClient } from "./client";
import { DiagnosticsLedger } from "./dedup";
import type { ContainerTarget } from "./devcontainer";
import type { DetectedLinter } from "./linters";
import type { DetectedServer } from "./servers";
import type { FileWatcher, WatchChangeType } from "./watcher";

// ── Host interface ──

/** Status facts the engine pushes when they change. Presentation (pill, colors,
 * labels) is the adapter's job — a different harness may render progress and
 * running servers differently. */
export interface EngineStatusData {
  /** Active progress entries (servers that sent `begin` without `end`). */
  progress: Array<{ server: string; title: string; percentage?: number }>;
  /** Display names of running (non-dead) clients, deduped. */
  running: string[];
}

/** Minimal UI seam the engine needs from the host. Everything else the engine
 * returns as plain strings/structured data for the adapter to render. */
export interface LspHost {
  notify(message: string, type: "info" | "warning" | "error"): void;
  /** Status facts changed (progress entries, running servers). Adapter renders. */
  setStatus(data: EngineStatusData): void;
}

// ── Tool types ──

export const LSP_ACTIONS = [
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

export type LspAction = (typeof LSP_ACTIONS)[number];

/** Parameters of the `lsp` tool, shared by the actions implementation and the
 * adapter's tool schema (which adds per-field descriptions). */
export interface LspActionParams {
  action: LspAction;
  file?: string;
  line?: number;
  symbol?: string;
  occurrence?: number;
  new_name?: string;
  query?: string;
  index?: number;
  name?: string;
}

// ── Diagnostics types ──

export interface DiagnosticsResult {
  messages: string[];
  summary: string;
  errored: boolean;
  server?: string;
  unchanged?: Diagnostic[];
  drift?: string;
  quickfixes?: string[];
}

export interface DiagnosticsOptions {
  /** If true, include cold servers (for explicit `lsp diagnostics` calls). */
  explicit?: boolean;
  /** Override diagnostic wait timeout (ms). */
  timeoutMs?: number;
  /** If true, send workspace/didChangeWatchedFiles Created notification. */
  isNewFile?: boolean;
  /**
   * If true (post-edit auto path), run the dedup ledger: only diagnostics
   * not previously shown are returned in `messages`, the rest in `unchanged`.
   * Explicit `lsp diagnostics` calls skip this.
   */
  dedupe?: boolean;
  /** If true (post-edit auto path), check repo-gated servers (biome) for
   * format drift and report where the project formatter would change the file. */
  checkDrift?: boolean;
  /** If true (post-edit auto path), ask servers which of the file's
   * diagnostics have an available quickfix and hint the titles. */
  checkQuickfixes?: boolean;
}

/** Result of a post-tool diagnostics drain (post-edit or post-bash). The
 * adapter appends `appended` to the tool result and raises `notify` (level:
 * errored ? "error" : "warning") when non-null. */
export interface PostToolResult {
  /** Text to append to the tool result (leading `\n\n` included). */
  appended: string;
  /** UI notification text, or null when nothing worth raising. */
  notify: string | null;
  errored: boolean;
}

// ── State ──

export interface EngineState {
  host: LspHost;
  /** Active LSP clients, keyed by `serverName::rootPath`. */
  clients: Map<string, LspClient>;
  /**
   * Diagnostics the agent has already been shown in post-edit blocks, so
   * repeated reports collapse unchanged errors to a single line. Cleared on
   * session start (a new conversation hasn't seen anything).
   */
  diagLedger: DiagnosticsLedger;
  /**
   * Whether the post-edit block collapses unchanged diagnostics (see
   * diagLedger). Toggled by `/lsp-dedup`; in-memory, resets on reload.
   * Default on.
   */
  dedupEnabled: boolean;
  /**
   * Resolved devcontainer targets per `serverName::rootPath`. Discovery (docker
   * inspect + binary probe + optional install) is non-trivial, so cache per
   * session: successes indefinitely, nulls for a short TTL so a container
   * started mid-session gets picked up. Cleared on shutdown and `/lsp-restart`.
   */
  targetCache: Map<string, { target: ContainerTarget | null; expires: number }>;
  /** Detected servers for current cwd. */
  detectedServers: DetectedServer[];
  /** Detected linters for current cwd. */
  detectedLinters: DetectedLinter[];
  /** Current working directory. */
  currentCwd: string;
  /** Whether a session is active (UI callbacks fire only then). */
  active: boolean;
  /** Active file watcher for cwd. */
  fileWatcher: FileWatcher | null;
  /** Pending delayed watcher start (session_start schedules it 500ms out). */
  watcherStartTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Pre-edit file contents captured at `tool_call` (files touched by an edit
   * tool). Consumed by the post-edit caller warning in `tool_result`.
   */
  pendingPreEdit: Map<string, string>;
  /**
   * Files the watcher saw change, timestamped, drained on the next bash tool
   * result for post-bash diagnostics. TTL bounds staleness.
   */
  recentChanges: Map<string, { type: WatchChangeType; ts: number }>;
  /**
   * Host-relative paths applied by the server via inbound `workspace/applyEdit`
   * during the most recent executeCommand. Reset before each executeCommand so
   * codeActionApply can report what actually landed.
   */
  lastServerAppliedPaths: string[] | null;
  /**
   * Tracks servers that timed out during auto-diagnostics. Value = timestamp
   * of the timeout. Won't retry until WARMUP_RETRY_MS has passed. Cleared once
   * a server successfully returns diagnostics.
   */
  coldServers: Map<string, number>;
  /** Throttle state for high-frequency status updates. */
  statusThrottleTimer: ReturnType<typeof setTimeout> | undefined;
  statusThrottlePending: boolean;
}

export function createState(host: LspHost): EngineState {
  return {
    host,
    clients: new Map(),
    diagLedger: new DiagnosticsLedger(),
    dedupEnabled: true,
    targetCache: new Map(),
    detectedServers: [],
    detectedLinters: [],
    currentCwd: "",
    active: false,
    fileWatcher: null,
    watcherStartTimer: undefined,
    pendingPreEdit: new Map(),
    recentChanges: new Map(),
    lastServerAppliedPaths: null,
    coldServers: new Map(),
    statusThrottleTimer: undefined,
    statusThrottlePending: false,
  };
}

// ── Constants ──

/** Build a client map key from server name and project root. */
export function clientKey(serverName: string, root: string): string {
  return `${serverName}::${root}`;
}

/** Parse a client key back into server name and root. */
export function parseClientKey(key: string): { serverName: string; root: string } {
  const idx = key.indexOf("::");
  return { serverName: key.slice(0, idx), root: key.slice(idx + 2) };
}

/** Timeout for LSP diagnostic polling (existing files). */
export const DIAG_WAIT_MS = 3000;

/** Longer timeout for new files (server needs to re-index). */
export const DIAG_WAIT_NEW_FILE_MS = 6000;

/** Minimum time before retrying a server that timed out (ms). */
export const WARMUP_RETRY_MS = 5_000;

/** Resolved devcontainer target null-cache TTL (ms): a container started
 * mid-session gets picked up after this. */
export const TARGET_NULL_TTL_MS = 60_000;

/** Bounded pre-edit content map: an edit whose tool_result never fires can't
 * leak the map. */
export const MAX_PENDING_EDIT = 200;

/** TTL for watcher changes buffered for post-bash diagnostics (ms). */
export const RECENT_CHANGE_TTL_MS = 5_000;

/** Timeout for progress entries that haven't been updated (ms). */
export const PROGRESS_STALE_MS = 30_000;

/** Throttle for high-frequency status updates (ms). */
export const STATUS_THROTTLE_MS = 500;

/** Max quickfix hint lines shown per file — bounds block noise, not query cost. */
export const MAX_QUICKFIX_HINTS = 3;
