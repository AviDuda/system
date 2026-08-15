/**
 * File-change routing and session lifecycle.
 *
 * Routes watcher events to LSP servers (`workspace/didChangeWatchedFiles`),
 * buffers raw events for post-bash diagnostics, and starts/stops the watcher
 * at session boundaries. Pure engine logic — see state.ts for the shared
 * state and index.ts for the harness adapter.
 */

import * as path from "node:path";
import { closeFile, FileChangeType, fileToUri, notifyFileChanges } from "./client";
import { shutdownAll } from "./client-mgmt";
import { detectLinters } from "./linters";
import { detectServers } from "./servers";
import { type EngineState, parseClientKey, RECENT_CHANGE_TTL_MS } from "./state";
import { updateStatusData } from "./status";
import { createFileWatcher, type FileChange, WatchChangeType } from "./watcher";

/** WatchKind bitmask values from LSP spec. */
const WatchKind = { Create: 1, Change: 2, Delete: 4 } as const;

/**
 * Route file change events from the watcher to LSP servers.
 * Matches each change against server-registered watcher patterns,
 * falling back to file type extensions from detected servers.
 */
export function handleFileChanges(state: EngineState, changes: FileChange[]): void {
  recordRecentChanges(state, changes);

  // Group changes by client
  type ChangeType = (typeof FileChangeType)[keyof typeof FileChangeType];
  const clientChanges = new Map<string, Array<{ uri: string; type: ChangeType; absolutePath: string }>>();

  for (const change of changes) {
    const uri = fileToUri(change.absolutePath);

    for (const [clientName, client] of state.clients) {
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
        const server = state.detectedServers.find((s) => s.name === serverName);
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
    const client = state.clients.get(clientName);
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

export function startFileWatcher(state: EngineState): void {
  stopFileWatcher(state);
  if (!state.currentCwd) return;
  state.fileWatcher = createFileWatcher(
    state.currentCwd,
    (changes) => handleFileChanges(state, changes),
    (raw) => recordRecentChanges(state, raw),
  );
}

export function stopFileWatcher(state: EngineState): void {
  if (state.fileWatcher) {
    state.fileWatcher.close();
    state.fileWatcher = null;
  }
}

/**
 * Record watcher changes for post-bash diagnostics. Raw events (no debounce)
 * land here first via the watcher's onRaw callback — the debounced batch that
 * handleFileChanges receives arrives ~300ms later, too late for a bash
 * tool_result hook that drains right after the command finishes.
 */
export function recordRecentChanges(state: EngineState, changes: FileChange[]): void {
  const now = Date.now();
  for (const change of changes) {
    if (change.type === WatchChangeType.Deleted) continue;
    state.recentChanges.set(change.absolutePath, { type: change.type, ts: now });
  }
  for (const [p, v] of state.recentChanges) {
    if (now - v.ts > RECENT_CHANGE_TTL_MS) state.recentChanges.delete(p);
  }
}

// ── Session lifecycle ──

/** Start a session at cwd: detect servers/linters, reset the dedup ledger,
 * update status, and (when anything was found) start the file watcher. */
export function startSession(state: EngineState, cwd: string): void {
  state.currentCwd = cwd;
  state.active = true;
  state.detectedServers = detectServers(cwd);
  state.detectedLinters = detectLinters(cwd);
  state.diagLedger.clear();

  if (state.detectedServers.length === 0 && state.detectedLinters.length === 0) {
    // Don't spam -- just stay quiet if nothing found
    return;
  }

  updateStatusData(state);

  // File watcher routes external changes (bash, git, other editors) to the
  // servers that care. Servers start on demand instead — read-time warming
  // and the lsp tool cover responsiveness, and eager-starting every
  // detected server (incl. JVM/.NET ones) at session start is waste. The
  // delay also lets a quick session end (tests, /lsp-restart) cancel the
  // start before it fires.
  state.watcherStartTimer = setTimeout(() => startFileWatcher(state), 500);
}

/** End the session: stop the watcher (and its pending start) and shut down all clients. */
export async function stopSession(state: EngineState): Promise<void> {
  state.active = false;
  if (state.watcherStartTimer) {
    clearTimeout(state.watcherStartTimer);
    state.watcherStartTimer = undefined;
  }
  stopFileWatcher(state);
  await shutdownAll(state);
}
