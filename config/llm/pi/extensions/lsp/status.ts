/**
 * Engine status computation and the unified status report.
 *
 * `updateStatusData` recomputes the status FACTS (active progress entries,
 * running servers) and pushes them through `state.host.setStatus` — how those
 * facts get presented (footer pill, colors, labels) is the adapter's job.
 * `statusReport` is the full text report shared by the `lsp status` action and
 * the `/lsp` command. Pure engine logic — see state.ts for the shared state.
 */

import * as path from "node:path";
import type { LspClient } from "./client";
import { KNOWN_SERVERS, serverDisplayName } from "./servers";
import {
  clientKey,
  type EngineState,
  type EngineStatusData,
  PROGRESS_STALE_MS,
  parseClientKey,
  STATUS_THROTTLE_MS,
} from "./state";

/** Recompute and push status facts (progress + running servers). Called after
 * any state change that affects them (client starts, progress updates,
 * restarts, lazy server detection). The host renders them its own way. */
export function updateStatusData(state: EngineState): void {
  if (!state.active) return;

  // Expire stale progress entries (servers that sent 'begin' but never 'end')
  const now = Date.now();
  for (const client of state.clients.values()) {
    for (const [token, wp] of client.progress) {
      if (now - wp.lastUpdated > PROGRESS_STALE_MS) {
        client.progress.delete(token);
      }
    }
  }

  // Collect facts: active progress + deduped running server names. Both are
  // pushed every time; the adapter decides what (and how) to show.
  const progress: EngineStatusData["progress"] = [];
  for (const client of state.clients.values()) {
    if (client.dead) continue;
    for (const wp of client.progress.values()) {
      progress.push({ server: serverDisplayName(client.name), title: wp.title, percentage: wp.percentage });
    }
  }
  const running = [
    ...new Set([...state.clients.values()].filter((c) => !c.dead).map((c) => serverDisplayName(c.name))),
  ];
  state.host.setStatus({ progress, running });
}

/** Throttled version of updateStatusData for high-frequency progress updates. */
export function updateStatusDataThrottled(state: EngineState): void {
  if (state.statusThrottleTimer) {
    state.statusThrottlePending = true;
    return;
  }
  updateStatusData(state);
  state.statusThrottleTimer = setTimeout(() => {
    state.statusThrottleTimer = undefined;
    if (state.statusThrottlePending) {
      state.statusThrottlePending = false;
      updateStatusData(state);
    }
  }, STATUS_THROTTLE_MS);
}

/** Toggle post-edit unchanged-diagnostic collapsing; returns the notice text. */
export function toggleDedup(state: EngineState): string {
  state.dedupEnabled = !state.dedupEnabled;
  return `LSP: unchanged diagnostics ${state.dedupEnabled ? "collapse" : "reported in full"} after edits`;
}

/**
 * Unified status report: detected servers at cwd + active clients at OTHER
 * roots (e.g. a subproject's container-routed server) + linters. Shared by
 * the `lsp status` tool action and the `/lsp` command so they can't drift
 * apart. Returns null when there's nothing to show.
 */
export function statusReport(state: EngineState): string | null {
  if (state.detectedServers.length === 0 && state.detectedLinters.length === 0 && state.clients.size === 0) return null;
  const lines: string[] = [];
  if (state.detectedServers.length > 0) {
    lines.push(`Detected ${state.detectedServers.length} language server(s) for ${state.currentCwd}:`);
    for (const s of state.detectedServers) {
      const client = state.clients.get(clientKey(s.name, state.currentCwd));
      const status =
        client && !client.dead ? `running (${formatUptime(client.createdAt)}) ${modeLabel(client)}` : "available";
      const cmd = client && !client.dead ? commandLabel(s.name, client) : "";
      lines.push(`  ${serverDisplayName(s.name)}${cmd} (${s.config.fileTypes.join(", ")}) — ${status}`);
    }
  }
  const otherRoots = [...state.clients.entries()].filter(([key]) => parseClientKey(key).root !== state.currentCwd);
  if (otherRoots.length > 0) {
    lines.push(``);
    lines.push(`Active servers for other projects (${otherRoots.length}):`);
    for (const [key, client] of otherRoots) {
      const { serverName, root } = parseClientKey(key);
      const relRoot = path.relative(state.currentCwd, root);
      const status = !client.dead ? `running (${formatUptime(client.createdAt)}) ${modeLabel(client)}` : "dead";
      const cmd = !client.dead ? commandLabel(serverName, client) : "";
      lines.push(`  ${serverDisplayName(serverName)}${cmd} @ ${relRoot} — ${status}`);
    }
  }
  if (state.detectedLinters.length > 0) {
    lines.push(``);
    lines.push(`Detected ${state.detectedLinters.length} linter(s):`);
    for (const l of state.detectedLinters) {
      lines.push(`  ${l.name} (${l.config.fileTypes.join(", ")}) — cli`);
    }
  }
  if (!state.dedupEnabled) {
    lines.push(``);
    lines.push(`Diagnostic collapse: off (unchanged errors reported in full after every edit)`);
  }
  return lines.join("\n");
}

// ── Formatting helpers ──

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
