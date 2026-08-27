/**
 * Engine orchestration tests (no real servers).
 *
 * Exercises the harness-agnostic engine modules with a mock host: session
 * lifecycle in empty directories, tool hooks that should no-op, the lsp
 * action error paths, status reporting, and the diagnostics block renderer.
 * Real-server pipeline tests (postEditResult against live servers) live in
 * e2e.test.ts, gated by LSP_E2E=1.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAction } from "./actions";
import type { Diagnostic } from "./client";
import { diagBlock } from "./diagnostics";
import { startSession, stopSession } from "./file-events";
import { bashDiagBlocks, handleToolCall, postBashResult, postEditResult } from "./hooks";
import { detectLinters } from "./linters";
import { detectServers } from "./servers";
import { createState, type DiagnosticsResult, type EngineState, type LspHost } from "./state";
import { statusReport, toggleDedup, updateStatusData } from "./status";
import { WatchChangeType } from "./watcher";

/** Fixture diagnostic (position-only fields matter for formatting). */
function diag(line: number, message: string, severity = 1): Diagnostic {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 10 } },
    message,
    severity,
  };
}

function makeHost() {
  const notifies: Array<{ message: string; type: string }> = [];
  const statuses: Array<{ progress: unknown[]; running: unknown[] }> = [];
  const host: LspHost = {
    notify: (message, type) => notifies.push({ message, type }),
    setStatus: (data) => statuses.push(data),
  };
  return { host, notifies, statuses };
}

/** Repo root (config/llm/pi) — detects typescript-language-server here. */
const REPO = path.resolve(import.meta.dir, "..", "..");
const repoDetected = detectServers(REPO).length > 0;
/** The capture test needs a server that handles .ts files specifically. */
const tsServerDetected = detectServers(REPO).some((s) => s.config.fileTypes.includes(".ts"));

describe("diagBlock", () => {
  const clean = { messages: [] as string[], summary: "0 errors, 0 warnings", errored: false, server: "ts" };

  test("clean file renders the no-errors header", () => {
    expect(diagBlock(clean, "src/a.ts", "")).toBe("[LSP diagnostics (ts): no errors, no warnings]");
  });

  test("multi-file label is embedded in the header", () => {
    expect(diagBlock(clean, "src/a.ts", " src/a.ts")).toBe("[LSP diagnostics (ts) src/a.ts: no errors, no warnings]");
  });

  test("messages render under the summary header", () => {
    const result = {
      messages: ["src/a.ts:2:1 [error] (ts) [2322] boom"],
      summary: "1 error(s)",
      errored: true,
      server: "ts",
    };
    expect(diagBlock(result, "src/a.ts", "")).toBe(
      "[LSP diagnostics (ts): 1 error(s)]\nsrc/a.ts:2:1 [error] (ts) [2322] boom",
    );
  });

  test("unchanged diagnostics collapse to a single line with counts", () => {
    const result = {
      messages: ["src/a.ts:2:1 [error] (ts) [2322] new boom"],
      summary: "2 error(s)",
      errored: true,
      server: "ts",
      unchanged: [diag(5, "old boom")],
    };
    const block = diagBlock(result, "src/a.ts", "");
    expect(block).toContain("[LSP diagnostics (ts): 2 error(s) — 1 new, 1 unchanged]");
    expect(block).toContain("  unchanged: src/a.ts:6");
  });

  test("quickfix hints are capped with a more-line", () => {
    const result = {
      messages: ["src/a.ts:1:1 [error] (ts) [2322] x"],
      summary: "1 error(s)",
      errored: true,
      server: "ts",
      quickfixes: ["Fix one", "Fix two", "Fix three", "Fix four"],
    };
    const block = diagBlock(result, "src/a.ts", "");
    expect(block).toContain("  quickfix: Fix one — apply via lsp codeActionApply");
    expect(block.match(/quickfix: /g)?.length).toBe(3);
    expect(block).toContain("  …and 1 more quickfixes available");
  });

  test("format drift line is appended", () => {
    const result = {
      messages: [] as string[],
      summary: "0 errors, 0 warnings",
      errored: false,
      server: "ts",
      drift: "line 2-4 (biome)",
    };
    expect(diagBlock(result, "src/a.ts", "")).toBe(
      "[LSP diagnostics (ts): no errors, no warnings]\n  format drift: line 2-4 (biome)",
    );
  });
});

describe("bashDiagBlocks", () => {
  const mk = (over: Partial<DiagnosticsResult> = {}): DiagnosticsResult => ({
    messages: [],
    summary: "0 errors, 0 warnings",
    errored: false,
    server: "ts",
    ...over,
  });

  test("all-clean batch collapses to one line", () => {
    const { parts, hasIssues } = bashDiagBlocks([
      { relPath: "a.ts", result: mk() },
      { relPath: "b.json", result: mk({ server: "json" }) },
    ]);
    expect(parts).toEqual(["[LSP diagnostics (ts, json): 2 files clean]"]);
    expect(hasIssues).toBe(false);
  });

  test("dirty file keeps a labeled block; clean files collapse", () => {
    const dirty = mk({ messages: ["src/a.ts:1:1 [error] (ts) nope"], summary: "1 error, 0 warnings", errored: true });
    const { parts, hasIssues } = bashDiagBlocks([
      { relPath: "src/a.ts", result: dirty },
      { relPath: "src/b.ts", result: mk() },
    ]);
    expect(parts).toEqual([
      "[LSP diagnostics (ts) src/a.ts: 1 error, 0 warnings]\nsrc/a.ts:1:1 [error] (ts) nope",
      "[LSP diagnostics (ts): 1 file clean]",
    ]);
    expect(hasIssues).toBe(true);
  });

  test("drift-only file renders a block without raising an issue", () => {
    const { parts, hasIssues } = bashDiagBlocks([{ relPath: "src/a.ts", result: mk({ drift: "line 2-4 (biome)" }) }]);
    expect(parts).toEqual([
      "[LSP diagnostics (ts) src/a.ts: no errors, no warnings]\n  format drift: line 2-4 (biome)",
    ]);
    expect(hasIssues).toBe(false);
  });

  test("unchanged-collapse lines count as signal", () => {
    const { hasIssues } = bashDiagBlocks([{ relPath: "a.ts", result: mk({ unchanged: [diag(3, "same")] }) }]);
    expect(hasIssues).toBe(true);
  });
});

describe("engine lifecycle", () => {
  let state: EngineState;
  let tmp: string;
  let statuses: Array<{ progress: unknown[]; running: unknown[] }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-engine-"));
    const host = makeHost();
    state = createState(host.host);
    statuses = host.statuses;
  });

  afterEach(async () => {
    await stopSession(state);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("session in a server-less dir stays quiet (no status, null report)", async () => {
    startSession(state, tmp);
    expect(statusReport(state)).toBeNull();
    expect(statuses.length).toBe(0);
  });

  test("stopSession with no clients does not throw", async () => {
    await stopSession(state);
    expect(state.clients.size).toBe(0);
  });

  test("read warming in a server-less dir is a no-op", () => {
    const f = path.join(tmp, "x.txt");
    fs.writeFileSync(f, "hi");
    handleToolCall(state, "read", { path: f }, tmp);
    expect(statuses.length).toBe(0);
  });

  test("edit capture skips files no server handles", () => {
    const f = path.join(tmp, "x.txt");
    fs.writeFileSync(f, "hi");
    handleToolCall(state, "edit", { path: f }, tmp);
    expect(state.pendingPreEdit.size).toBe(0);
  });

  test("postEditResult no-ops for non-edit tools and failed edits", async () => {
    expect(await postEditResult(state, "bash", {}, tmp, false)).toBeNull();
    expect(await postEditResult(state, "lsp", {}, tmp, false)).toBeNull();
    expect(await postEditResult(state, "write", { path: "x.txt" }, tmp, true)).toBeNull();
  });

  test("postEditResult no-ops for a file no server handles", async () => {
    fs.writeFileSync(path.join(tmp, "x.txt"), "hi");
    expect(await postEditResult(state, "write", { path: "x.txt" }, tmp, false)).toBeNull();
  });

  test("postBashResult drains an empty buffer to null", async () => {
    expect(await postBashResult(state, tmp)).toBeNull();
  });

  test("postBashResult keeps unserved entries queued instead of dropping them", async () => {
    // A drain whose diagnostics come back null (no server for the file) must
    // NOT consume the buffered events — the next drain retries them. (.txt:
    // no server handles it, so no lazy fallback attaches one.)
    const f = path.join(tmp, "x.txt");
    fs.writeFileSync(f, "hi");
    state.recentChanges.set(f, { type: WatchChangeType.Changed, ts: Date.now() });
    expect(await postBashResult(state, tmp)).toBeNull();
    expect(state.recentChanges.has(f)).toBe(true);
  });

  test("postBashResult purges stale entries so they can't block the fresh-event poll", async () => {
    const f = path.join(tmp, "x.ts");
    fs.writeFileSync(f, "export const x = 1;\n");
    state.recentChanges.set(f, { type: WatchChangeType.Changed, ts: Date.now() - 60_000 });
    expect(await postBashResult(state, tmp)).toBeNull();
    expect(state.recentChanges.size).toBe(0);
  });

  test("toggleDedup flips the collapse notice", () => {
    expect(toggleDedup(state)).toContain("reported in full");
    expect(toggleDedup(state)).toContain("collapse");
  });
});

describe("lsp actions (no servers)", () => {
  let state: EngineState;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-actions-"));
    state = createState({ notify: () => {}, setStatus: () => {} });
  });

  afterEach(async () => {
    await stopSession(state);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("status reports nothing detected", async () => {
    expect(await runAction(state, { action: "status" }, tmp)).toBe(
      "No language servers or linters detected for this project.",
    );
  });

  test("workspace_symbol requires a query", async () => {
    expect(await runAction(state, { action: "workspace_symbol" }, tmp)).toBe(
      "Error: query parameter required for workspace_symbol",
    );
  });

  test("workspace_symbol with no clients finds nothing", async () => {
    expect(await runAction(state, { action: "workspace_symbol", query: "foo" }, tmp)).toBe(
      'No workspace symbols found for "foo"',
    );
  });

  test("restart with no servers reports zero", async () => {
    expect(await runAction(state, { action: "restart" }, tmp)).toBe("Restarted 0 server(s): none");
  });

  test("restart for an unserved file reports no server", async () => {
    expect(await runAction(state, { action: "restart", file: "nope.xyz" }, tmp)).toBe(
      "No language server available for nope.xyz",
    );
  });

  test("missing file errors before server lookup", async () => {
    expect(await runAction(state, { action: "diagnostics", file: "nope.xyz" }, tmp)).toBe(
      "Error: file not found: nope.xyz",
    );
  });

  test("unserved existing file reports no server for every file action", async () => {
    fs.writeFileSync(path.join(tmp, "x.txt"), "hi");
    for (const action of ["diagnostics", "definition", "hover", "references", "symbols"] as const) {
      expect(await runAction(state, { action, file: "x.txt" }, tmp)).toBe("No language server available for x.txt");
    }
  });

  test("codeActionApply on an unserved file reports no server", async () => {
    fs.writeFileSync(path.join(tmp, "x.txt"), "hi");
    // (the index/name validation itself needs a live server, so it's covered
    // by the e2e codeActionApply test instead)
    expect(await runAction(state, { action: "codeActionApply", file: "x.txt" }, tmp)).toBe(
      "No language server available for x.txt",
    );
  });
});

describe("repo-detected session (skipped when no server is detectable)", () => {
  let state: EngineState;
  let statuses: Array<{ progress: unknown[]; running: unknown[] }>;

  beforeEach(() => {
    const host = makeHost();
    state = createState(host.host);
    statuses = host.statuses;
    // Seed the session state the way startSession would (no watcher timer).
    state.active = true;
    state.currentCwd = REPO;
    state.detectedServers = detectServers(REPO);
    state.detectedLinters = detectLinters(REPO);
  });

  afterEach(async () => {
    await stopSession(state);
  });

  test.skipIf(!repoDetected)("statusReport lists detected servers", () => {
    const report = statusReport(state);
    expect(report).not.toBeNull();
    expect(report).toMatch(/Detected \d+ language server\(s\) for \S+/);
  });

  test.skipIf(!repoDetected)("toggleDedup is reflected in statusReport", () => {
    toggleDedup(state);
    expect(statusReport(state)).toContain("Diagnostic collapse: off");
  });

  test.skipIf(!tsServerDetected)("handleToolCall captures pre-edit content of a code file", () => {
    const rel = "extensions/lsp/state.ts";
    handleToolCall(state, "edit", { path: rel }, REPO);
    expect(state.pendingPreEdit.get(path.resolve(REPO, rel))).toBeDefined();
  });

  test.skipIf(!repoDetected)("status facts are pushed after seeding", () => {
    updateStatusData(state);
    expect(statuses.length).toBeGreaterThan(0);
  });
});
