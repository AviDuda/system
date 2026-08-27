/**
 * Tool hooks: the behavior wired to a harness's `tool_call` / `tool_result`
 * events. `handleToolCall` warms read files and captures pre-edit content;
 * `postBashResult` / `postEditResult` drain diagnostics (and, for edits,
 * caller warnings) into a PostToolResult the adapter appends to the tool
 * result. Pure engine logic — see state.ts for the shared state.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { collectToolPaths, EDIT_LIKE_TOOLS } from "../shared/edit-tools";
import {
  type CallerWarningSymbol,
  changedLines,
  formatCallerLocation,
  formatCallerWarnings,
  isEditedLineCaller,
  MAX_CALLER_SYMBOLS,
  MAX_CALLERS_PER_SYMBOL,
  touchedSymbols,
} from "./callers";
import {
  type DocumentSymbol,
  incomingCalls,
  openFile,
  prepareCallHierarchy,
  type SymbolInformation,
  serverUriFor,
  syncFile,
  translateLocationUri,
  uriToFile,
} from "./client";
import { getClientForFile, getServersForFile, isFileOpenInAnyClient, warmRead } from "./client-mgmt";
import { diagBlock, getDiagnosticsForFile } from "./diagnostics";
import { serverDisplayName } from "./servers";
import { type EngineState, MAX_PENDING_EDIT, type PostToolResult, RECENT_CHANGE_TTL_MS } from "./state";
import { WatchChangeType } from "./watcher";

/**
 * tool_call hook: read-time warming + pre-edit content capture for the
 * post-edit caller warning. Fire-and-forget for reads, never blocks.
 */
export function handleToolCall(state: EngineState, toolName: string, input: unknown, cwd: string): void {
  // Read-time warming: background-open a read file in its LSP server so the
  // first interactive LSP call is already warm. Best-effort, never blocks.
  if (toolName === "read") {
    const p = (input as { path?: string } | undefined)?.path;
    if (p) {
      const expanded = p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p;
      // Swallow everything: a bad path (ENOENT etc.) must never surface as an
      // unhandled rejection — warming is opportunistic by definition.
      void warmRead(state, path.resolve(cwd, expanded)).catch(() => {});
    }
    return;
  }

  // Only file-mutating tools can invalidate callers.
  if (!EDIT_LIKE_TOOLS.includes(toolName)) return;
  const paths = collectToolPaths(toolName, input as Record<string, unknown>);
  if (paths.length === 0) return;
  for (const filePath of paths) {
    const abs = path.resolve(cwd, filePath);
    // Only matters for files an LSP server handles (skip big non-code files).
    if (getServersForFile(state, abs).length === 0) continue;
    try {
      state.pendingPreEdit.set(abs, fs.readFileSync(abs, "utf-8"));
    } catch {
      // Not on disk yet (a new `write` target): no callers to find.
    }
    if (state.pendingPreEdit.size > MAX_PENDING_EDIT) {
      state.pendingPreEdit.delete(state.pendingPreEdit.keys().next().value as string);
    }
  }
}

/**
 * tool_result hook for bash: drain watcher-buffered changes into
 * diagnostics appended to the result. Returns null when nothing to report
 * (the adapter leaves the tool result untouched).
 */
export async function postBashResult(state: EngineState, cwd: string): Promise<PostToolResult | null> {
  // Shell tools can change files too (formatter, checkout, codegen) and the
  // agent rarely calls `lsp diagnostics` after bash. Surface diagnostics for
  // files the watcher saw change recently, capped — a bash command that
  // touches hundreds of files (git checkout) reports on the first few. The
  // buffer is TTL-bounded rather than command-bounded: FSEvents delivery
  // latency is unreliable (ms to seconds), so attributing an event to the
  // exact bash that wrote the file would miss late deliveries.
  // Fast commands can beat fs.watch delivery (the raw event lands a few ms
  // after the write) — poll briefly before giving up so `printf > f` is
  // caught. Non-writing commands pay this small wait.
  if (state.recentChanges.size === 0) {
    const deadline = Date.now() + 150;
    while (state.recentChanges.size === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  const now = Date.now();
  const changed = [...state.recentChanges.entries()]
    .filter(([, v]) => now - v.ts <= RECENT_CHANGE_TTL_MS)
    .map(([abs, v]) => ({ abs, type: v.type }));
  if (changed.length === 0) return null;
  for (const abs of changed.map((c) => c.abs)) state.recentChanges.delete(abs);

  const MAX_BASH_DIAG_FILES = 5;
  const diagParts: string[] = [];
  let anyErrored = false;
  // Parallel + bounded: the drain runs inside the tool_result hook, so it
  // delays the bash result — several sequential 6s waits (new-file path)
  // would stall every file-writing command. Run per-file diagnostics
  // concurrently and cap each server wait at 1.5s; deep semantic checks on
  // brand-new files may not finish here (they surface on the next edit).
  // Quickfix queries are skipped — their 2s timeouts add latency for a
  // hint the agent can get on demand via `lsp codeAction`.
  await Promise.all(
    changed.slice(0, MAX_BASH_DIAG_FILES).map(async ({ abs, type }) => {
      try {
        const result = await getDiagnosticsForFile(state, abs, cwd, {
          isNewFile: type === WatchChangeType.Created,
          dedupe: true,
          checkDrift: true,
          timeoutMs: 1500,
        });
        if (result) {
          const block = diagBlock(result, path.relative(cwd, abs), "");
          if (block) {
            if (result.errored) anyErrored = true;
            diagParts.push(block);
          }
        }
      } catch {
        // Non-fatal per file
      }
    }),
  );
  if (diagParts.length === 0) return null;
  const more = changed.length - Math.min(changed.length, MAX_BASH_DIAG_FILES);
  const tail =
    more > 0 ? `\n\n…and ${more} more file(s) changed by bash (diagnostics capped at ${MAX_BASH_DIAG_FILES})` : "";
  const hasIssues = diagParts.some((p) => !p.includes("no errors, no warnings"));
  return {
    appended: `\n\n${diagParts.join("\n\n")}${tail}`,
    notify: hasIssues ? `LSP: ${diagParts.join("\n\n")}` : null,
    errored: anyErrored,
  };
}

/**
 * tool_result hook for edit-like tools (edit/write/patch): diagnostics +
 * caller warnings appended to the result. Returns null when nothing to
 * report (the adapter leaves the tool result untouched).
 */
export async function postEditResult(
  state: EngineState,
  toolName: string,
  input: unknown,
  cwd: string,
  isError: boolean,
): Promise<PostToolResult | null> {
  // LSP diagnostics only make sense after a file-mutating tool. The shared
  // set covers write/edit + the custom `patch` tool so diagnostics run after
  // patch too (else the reactive `}}`/`;;` catching silently skips it).
  if (!EDIT_LIKE_TOOLS.includes(toolName)) return null;
  // Only `write` can create a file; edit/patch require oldText to match.
  const isWrite = toolName === "write";

  // Don't run diagnostics if the edit itself failed
  if (isError) return null;

  // Collect target paths via the shared helper (patch may be multi-file).
  const paths = collectToolPaths(toolName, input as Record<string, unknown>);
  if (paths.length === 0) return null;

  // Run diagnostics per path and accumulate. Only write can create new files.
  const multi = paths.length > 1;
  const diagParts: string[] = [];
  const callerParts: string[] = [];
  let anyErrored = false;
  for (const filePath of paths) {
    const isNewFile = isWrite && !isFileOpenInAnyClient(state, filePath, cwd);
    try {
      const result = await getDiagnosticsForFile(state, filePath, cwd, {
        isNewFile,
        dedupe: true,
        checkDrift: true,
        checkQuickfixes: true,
      });
      if (result) {
        const abs = path.resolve(cwd, filePath);
        const relPath = path.relative(cwd, abs);
        const label = multi ? ` ${relPath}` : "";
        if (result.errored) anyErrored = true;
        const block = diagBlock(result, relPath, label);
        if (block) diagParts.push(block);
      }
    } catch {
      // Non-fatal per file: continue with the rest
    }

    // Post-edit caller warning: symbols the edit touched + who calls them,
    // so the agent checks call sites that a clean type-check misses.
    try {
      const callers = await editCallerWarnings(state, filePath, cwd);
      if (callers) callerParts.push(callers);
    } catch {
      // Non-fatal / best-effort (cold server, no callHierarchy support).
    }
  }

  if (diagParts.length === 0 && callerParts.length === 0) return null;
  const diagText = `\n\n${diagParts.join("\n\n")}`;
  const callerText = callerParts.length > 0 ? `\n\n${callerParts.join("\n\n")}` : "";
  const hasIssues = diagParts.some((p) => !p.includes("no errors, no warnings"));
  return {
    appended: diagText + callerText,
    notify: hasIssues ? `LSP: ${diagParts.join("\n\n")}` : null,
    errored: anyErrored,
  };
}

/**
 * Best-effort caller warning for a just-edited file: which top-level symbols
 * the edit touched (diff of pre-edit vs on-disk content), and who calls them
 * via call-hierarchy. Bounded by MAX_CALLER_SYMBOLS / MAX_CALLERS_PER_SYMBOL.
 * Returns the `[LSP callers ...]` block or null when there's nothing worth
 * reporting (no server, no call-hierarchy support, nothing touched, no callers).
 * Never throws — it's a nudge, not a gate.
 */
async function editCallerWarnings(state: EngineState, filePath: string, cwd: string): Promise<string | null> {
  const abs = path.resolve(cwd, filePath);
  const pre = state.pendingPreEdit.get(abs);
  state.pendingPreEdit.delete(abs);
  if (pre === undefined) return null; // not captured at tool_call, or a new file

  let post: string;
  try {
    post = fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
  if (pre === post) return null; // no-op edit

  const pair = await getClientForFile(state, abs);
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
