/**
 * The `lsp` tool's action implementations.
 *
 * `runAction` is the execute switch of the tool: status, workspace symbol
 * search, restart, and the file-based actions (diagnostics, definition,
 * type_definition, implementation, references, incoming, outgoing, hover,
 * symbols, rename, codeAction, codeActionApply). It returns plain strings —
 * the harness adapter wraps them in its own result format (pi: `text()`).
 * This is the portability seam: any harness can reuse these actions.
 * Pure engine logic — see state.ts for the shared state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { formatCallerLocation } from "./callers";
import {
  type CallHierarchyIncomingCall,
  type CallHierarchyOutgoingCall,
  type CodeAction,
  type DocumentSymbol,
  fileToUri,
  type Hover,
  incomingCalls,
  LSP_REQUEST_TIMEOUT_MS,
  type LspClient,
  openFile,
  outgoingCalls,
  prepareCallHierarchy,
  type SymbolInformation,
  serverUriFor,
  syncFile,
  translateLocationUri,
  translateWorkspaceEdit,
  uriToFile,
  type WorkspaceEdit,
} from "./client";
import { getClientAt, getClientForFile, restartAllClients } from "./client-mgmt";
import { getDiagnosticsForFile } from "./diagnostics";
import {
  applyWorkspaceEdit,
  extractHoverText,
  formatDocumentSymbol,
  formatLocation,
  formatLocationWithContext,
  formatSymbolInformation,
  normalizeLocations,
  readLocationContext,
  resolveSymbolPosition,
} from "./format";
import { serverDisplayName } from "./servers";
import { type EngineState, type LspActionParams, parseClientKey } from "./state";
import { statusReport, updateStatusData } from "./status";

/** Run one `lsp` tool action and return its text response. */
export async function runAction(state: EngineState, params: LspActionParams, cwd: string): Promise<string> {
  const { action, file, line, symbol, occurrence, new_name } = params;

  // ── Status ──
  if (action === "status") {
    return statusReport(state) ?? "No language servers or linters detected for this project.";
  }

  // ── Workspace symbol search (no file required — broadcasts to all clients) ──
  if (action === "workspace_symbol") {
    const workspaceQuery = params.query;
    if (!workspaceQuery) return "Error: query parameter required for workspace_symbol";

    const allResults: SymbolInformation[] = [];
    for (const [, c] of state.clients) {
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

    if (allResults.length === 0) return `No workspace symbols found for "${workspaceQuery}"`;

    allResults.sort((a, b) => a.name.localeCompare(b.name));
    const lines = allResults.map((s) => formatSymbolInformation(s, cwd));
    return `Workspace symbols matching "${workspaceQuery}" (${allResults.length}):\n${lines.join("\n")}`;
  }

  // ── Restart servers ──
  if (action === "restart") {
    if (file) {
      // Restart only the server for this file's project
      const abs = path.resolve(cwd, file);
      const pair = await getClientForFile(state, abs);
      if (!pair) return `No language server available for ${file}`;

      const { client } = pair;
      const serverName = client.name;

      // Find and remove the client key for this specific server+root
      let removedKey: string | undefined;
      for (const [key, c] of state.clients) {
        if (c === client) {
          removedKey = key;
          break;
        }
      }

      await client.shutdown();
      if (removedKey) state.clients.delete(removedKey);

      // Re-create the server
      const { root } = removedKey ? parseClientKey(removedKey) : { root: cwd };
      const newClient = await getClientAt(state, serverName, root);
      if (newClient) {
        updateStatusData(state);
        return `Restarted ${serverName} (root: ${root})`;
      }
      return `Failed to restart ${serverName}`;
    }

    return restartAllClients(state);
  }

  // ── File-based actions ──
  if (!file) {
    return "Error: file parameter required for this action";
  }

  const abs = path.resolve(cwd, file);
  if (!fs.existsSync(abs)) {
    return `Error: file not found: ${file}`;
  }

  const pair = await getClientForFile(state, abs);
  if (!pair) {
    return `No language server available for ${file}`;
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
        const result = await getDiagnosticsForFile(state, file, cwd, { explicit: true });
        if (!result) return "No language server found for this file";
        if (result.messages.length === 0) return "No diagnostics";
        return `${result.summary}:\n${result.messages.join("\n")}`;
      }

      case "definition": {
        const raw = await client.request("textDocument/definition", {
          textDocument: { uri },
          position,
        });
        const locs = normalizeLocations(raw, client.pathMap);
        if (locs.length === 0) {
          const ctx = readLocationContext(abs, displayLine, 2).join("\n");
          return `No definition found${posInfo}. Context around line ${displayLine}:\n${ctx}`;
        }
        const lines = locs.map((l) => formatLocationWithContext(l, cwd));
        return `Found ${locs.length} definition(s)${posInfo}:\n${lines.join("\n")}`;
      }

      case "type_definition": {
        const raw = await client.request("textDocument/typeDefinition", {
          textDocument: { uri },
          position,
        });
        const locs = normalizeLocations(raw, client.pathMap);
        if (locs.length === 0) {
          const ctx = readLocationContext(abs, displayLine, 2).join("\n");
          return `No type definition found${posInfo}. Context around line ${displayLine}:\n${ctx}`;
        }
        const lines = locs.map((l) => formatLocationWithContext(l, cwd));
        return `Found ${locs.length} type definition(s)${posInfo}:\n${lines.join("\n")}`;
      }

      case "implementation": {
        const raw = await client.request("textDocument/implementation", {
          textDocument: { uri },
          position,
        });
        const locs = normalizeLocations(raw, client.pathMap);
        if (locs.length === 0) {
          const ctx = readLocationContext(abs, displayLine, 2).join("\n");
          return `No implementation found${posInfo}. Context around line ${displayLine}:\n${ctx}`;
        }
        const lines = locs.map((l) => formatLocationWithContext(l, cwd));
        return `Found ${locs.length} implementation(s)${posInfo}:\n${lines.join("\n")}`;
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
          return `No references found${posInfo}. Context around line ${displayLine}:\n${ctx}`;
        }
        const contextLimit = 30;
        const withContext = locs.slice(0, contextLimit);
        const rest = locs.slice(contextLimit);
        const lines = withContext.map((l) => formatLocationWithContext(l, cwd));
        if (rest.length > 0) {
          lines.push(`  ... ${rest.length} additional reference(s)`);
          lines.push(...rest.map((l) => `  ${formatLocation(l, cwd)}`));
        }
        // Include posInfo when fallback resolved to a different line
        return `Found ${locs.length} reference(s)${posInfo}:\n${lines.join("\n")}`;
      }

      case "incoming":
      case "outgoing": {
        // Who calls this / what does this call (call hierarchy).
        const items = await prepareCallHierarchy(client, uri, position);
        if (items.length === 0) {
          return `No callable definition found${posInfo}. Context around line ${displayLine}:\n${readLocationContext(abs, displayLine, 2).join("\n")}`;
        }
        const item = items.find((i) => i.name === (symbol ?? items[0].name)) ?? items[0];
        const calls = action === "incoming" ? await incomingCalls(client, item) : await outgoingCalls(client, item);
        if (calls.length === 0) {
          return action === "incoming" ? `No callers found${posInfo}` : `No outgoing calls found${posInfo}`;
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
          return `  ${formatCallerLocation(hostFile, line0, cwd)} — ${item.name}`;
        });
        if (nodes.length > MAX_HIERARCHY_RESULTS) lines.push(`  ... ${nodes.length - MAX_HIERARCHY_RESULTS} more`);
        const verb = action === "incoming" ? "callers" : "calls";
        return `Found ${calls.length} ${verb}${posInfo}:\n${lines.join("\n")}`;
      }

      case "hover": {
        const raw = (await client.request("textDocument/hover", {
          textDocument: { uri },
          position,
        })) as Hover | null;
        if (!raw?.contents) {
          const ctx = readLocationContext(abs, displayLine, 2).join("\n");
          return `No hover information${posInfo}. Context around line ${displayLine}:\n${ctx}`;
        }
        const hoverText = extractHoverText(raw.contents);
        if (line !== undefined && displayLine !== line) {
          return `${posInfo}\n${hoverText}`;
        }
        return hoverText;
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
            state.coldServers.set(server.name, Date.now());
            return `${serverDisplayName(server.name)} is still indexing ${path.relative(cwd, abs)} (timed out after ${
              LSP_REQUEST_TIMEOUT_MS / 1000
            }s). The file analysis continues in the background — try again immediately, or use read with offset/limit in the meantime.`;
          }
          throw err;
        }

        if (!raw || raw.length === 0) return "No symbols found";
        // A successful symbols call means the server is warm for this file.
        state.coldServers.delete(server.name);

        const relPath = path.relative(cwd, abs);
        if ("selectionRange" in raw[0]) {
          const lines = (raw as DocumentSymbol[]).flatMap((s) => formatDocumentSymbol(s));
          return `Symbols in ${relPath}:\n${lines.join("\n")}`;
        } else {
          const lines = (raw as SymbolInformation[]).map((s) => formatSymbolInformation(s, cwd));
          return `Symbols in ${relPath}:\n${lines.join("\n")}`;
        }
      }

      case "rename": {
        if (!new_name) return "Error: new_name parameter required for rename";

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
          return `Rename failed — no renameable symbol found at line ${displayLine}${
            symbol ? `, symbol "${symbol}"` : ""
          }.${warmHint}\n\nContext around line ${displayLine}:\n${context}\n\nCheck: is the line number correct? Use the \`symbol\` parameter to target a specific identifier.`;
        }

        // Apply the edits. rust-analyzer returns `documentChanges`;
        // tsserver/others may return `changes`. applyWorkspaceEdit handles
        // both (documentChanges is authoritative when present) and syncs
        // each file back to the server so subsequent renames use fresh
        // positions instead of corrupting the file.
        const { applied, unsupported } = await applyWorkspaceEdit(
          translateWorkspaceEdit(raw, client.pathMap),
          cwd,
          (editPath) => {
            syncFile(client, editPath);
          },
        );

        const lines = applied.map((r) => `  ${r.path}: ${r.count} edit(s)`);
        if (unsupported.length > 0) {
          lines.push(`  (skipped unsupported resource ops: ${unsupported.join(", ")})`);
        }
        return `Renamed to "${new_name}":\n${lines.join("\n")}`;
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

        if (!raw || raw.length === 0) return "No code actions available at this position";

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
        return lines.join("\n");
      }

      case "codeActionApply": {
        const idx = params.index;
        const name = params.name;
        if ((idx === undefined || idx < 0) && !name) {
          return "Error: index or name parameter required. Use 'codeAction' first to see available actions.";
        }

        // Query available code actions (same resolved-name position as
        // the listing above, so declaration refactors surface).
        const raw = await requestCodeActions(client, uri, abs, {
          start: { line: resolved.line, character: resolved.character },
          end: { line: resolved.line, character: resolved.character },
        });

        if (!raw || raw.length === 0) return "No code actions available at this position";

        // Select by name (substring, case-insensitive) when given — index
        // ordering can shift between queries — else by index.
        let selected: CodeAction;
        if (name) {
          const q = name.toLowerCase();
          const found = raw.find((a) => a.title.toLowerCase().includes(q));
          if (!found) {
            return `No code action matching "${name}". Available: ${raw.map((a) => `"${a.title}"`).join(", ")}`;
          }
          selected = found;
        } else {
          if (idx === undefined || idx >= raw.length) {
            return `Invalid index ${idx}. Available actions: 0-${raw.length - 1}`;
          }
          selected = raw[idx];
        }

        if (selected.disabled) {
          return `Code action "${selected.title}" is disabled: ${selected.disabled.reason}`;
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
            cwd,
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
          return `Applied "${selected.title}":\n${await apply(resolvedAction.edit)}`;
        }

        // Command-only action (e.g. Move to a new file): execute the command
        // and apply the WorkspaceEdit it returns. The action's own arguments
        // carry the position/range. Two outcomes: the server returns the edit
        // as the result, OR (typescript-language-server) the server pushes it
        // back via inbound workspace/applyEdit and the result is void — those
        // applied paths are recorded on lastServerApplied.
        if (resolvedAction.command) {
          state.lastServerAppliedPaths = null;
          const result = (await client.request("workspace/executeCommand", {
            command: resolvedAction.command.command,
            arguments: resolvedAction.command.arguments ?? [],
          })) as WorkspaceEdit | null;
          const serverApplied = state.lastServerAppliedPaths as string[] | null;
          if (serverApplied && serverApplied.length > 0) {
            return `Executed "${selected.title}" (${resolvedAction.command.command}):\n${serverApplied
              .map((p) => `  ${p}`)
              .join("\n")}`;
          }
          if (
            result &&
            ((result.changes && Object.keys(result.changes).length > 0) || result.documentChanges?.length)
          ) {
            return `Executed "${selected.title}" (${resolvedAction.command.command}):\n${await apply(result)}`;
          }
          return `Command "${resolvedAction.command.command}" executed but returned no edits. It may require editor-side confirmation or act outside the workspace.`;
        }

        return `Code action "${selected.title}" has no edit and no executable command.`;
      }

      default:
        return `Unknown action: ${action}`;
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
    return `LSP error (${serverDisplayName(server.name)}): ${msg}${transientHint}`;
  }
}

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
