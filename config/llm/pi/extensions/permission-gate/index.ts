/**
 * Pi permission gate extension.
 *
 * Thin UI wrapper around the decision logic in ./logic.ts.
 * See the README for details.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { Component, KeybindingsManager, Theme, TUI } from "@mariozechner/pi-tui";
import { extractText, getSidecarStats, hasRole, sidecarComplete } from "../shared/model-roles";
import {
  type ConfirmResult,
  type ConfirmUIOptions,
  createConfirmUI,
  type ExplanationProvider,
  type ExplanationResult,
} from "./confirm-ui";
import { blockReason, describeToolCall, parseExplanation } from "./explain";
import {
  cacheKey,
  createInitialState,
  decide,
  findGitRoot,
  type GateState,
  MODE_CYCLE,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  MODE_SHORT,
  shouldAutoAllow,
} from "./logic";

export default function permissionGate(pi: ExtensionAPI) {
  const state: GateState = createInitialState();
  const pendingNotes: Map<string, string> = new Map();
  let explainEnabled = false;
  /** Latest auto-allow verdict for the widget. Cleared each agent turn. */
  let lastVerdict: string | null = null;

  function updateWidget(ctx: { ui: ExtensionUIContext }) {
    if (state.autoClassify !== "on" || !lastVerdict) {
      ctx.ui.setWidget("permission-gate", undefined);
      return;
    }
    ctx.ui.setWidget("permission-gate", [lastVerdict], { placement: "belowEditor" });
  }

  /** Classify a tool call via sidecar. Returns parsed result or null on failure. */
  async function classify(
    toolName: string,
    input: Record<string, unknown>,
    modelRegistry: Parameters<typeof sidecarComplete>[2],
  ): Promise<import("./confirm-ui").ExplanationResult | null> {
    const description = describeToolCall(toolName, input);
    const result = await sidecarComplete(
      "explain",
      {
        systemPrompt: EXPLAIN_SYSTEM_PROMPT,
        messages: [{ role: "user", content: description, timestamp: Date.now() }],
      },
      modelRegistry,
    );
    if (!result) return null;
    // strict: parse failure = null (don't auto-allow garbage)
    return parseExplanation(extractText(result.message), true);
  }

  const EXPLAIN_SYSTEM_PROMPT = `You assess tool calls for a developer reviewing permissions.

First line must start with SAFE, RISKY, or DANGEROUS followed by a pipe and a short tl;dr.
Then optionally a blank line and 2-3 sentences of detail.

Examples:
SAFE|Lists directory contents
RISKY|Deletes a specific config file
RISKY|Restores a file from git index (modifies working tree)
DANGEROUS|Deletes entire home directory recursively

Criteria:
- SAFE: Strictly read-only operations. No file creation, modification, deletion, or system state changes. Examples: ls, cat, grep, find, echo, pwd, git log, git status, git diff, running tests, type-checking, linting.
- RISKY: Any operation that creates, modifies, or deletes files, changes permissions, or alters system state -- even if recoverable. Examples: rm, mv, cp, sed -i, chmod, git checkout (restoring files), git commit, mkdir, writing/editing files.
- DANGEROUS: Irreversible large-scale data loss (recursive delete of home/root), credential exposure, security compromise, data exfiltration, arbitrary code execution (curl|bash).

If in doubt between SAFE and RISKY, choose RISKY. Reserve SAFE for operations that cannot change anything.
Be direct, no filler.`;

  /** Build an ExplanationProvider that calls the "explain" sidecar role. */
  function makeExplanation(
    toolName: string,
    input: Record<string, unknown>,
    modelRegistry: Parameters<typeof sidecarComplete>[2],
  ): ExplanationProvider | undefined {
    if (!explainEnabled) return undefined;

    // Check cache first -- skip sidecar call if we already classified this
    const key = cacheKey(toolName, input);
    const cachedResult = state.classifyCache.get(key);
    if (cachedResult) {
      return { promise: Promise.resolve(cachedResult), abort: () => {} };
    }

    const description = describeToolCall(toolName, input);
    const abortController = new AbortController();

    const promise = (async (): Promise<ExplanationResult | null> => {
      const result = await sidecarComplete(
        "explain",
        {
          systemPrompt: EXPLAIN_SYSTEM_PROMPT,
          messages: [{ role: "user", content: description, timestamp: Date.now() }],
        },
        modelRegistry,
        { signal: abortController.signal },
      );
      if (!result) return null;
      const parsed = parseExplanation(extractText(result.message));
      // Populate cache so it's warm if auto-classify is toggled on later
      if (parsed) {
        state.classifyCache.set(key, { verdict: parsed.verdict, short: parsed.short, detail: parsed.detail });
      }
      return parsed;
    })();

    return { promise, abort: () => abortController.abort() };
  }

  /** Build an ExplanationProvider from an already-resolved result. */
  function makePreloadedExplanation(result: ExplanationResult): ExplanationProvider {
    return { promise: Promise.resolve(result), abort: () => {} };
  }

  /** Show confirmation dialog with optional inline note. */
  async function confirm(
    ctx: {
      ui: {
        custom: <T>(
          fn: (tui: TUI, theme: Theme, kb: KeybindingsManager, done: (v: T) => void) => Component,
        ) => Promise<T>;
      };
    },
    title: string,
    options: string[],
    explanation?: ExplanationProvider,
  ): Promise<ConfirmResult> {
    const uiOptions: ConfirmUIOptions = {
      autoClassify: state.autoClassify === "on",
      hasExplainRole: hasRole("explain"),
    };
    return ctx.ui.custom<ConfirmResult>((tui, theme, kb, done) =>
      createConfirmUI(tui, theme, kb, done, title, options, explanation, uiOptions),
    );
  }

  /** Process auto-classify toggle from dialog result. */
  function handleDialogAutoToggle(
    result: ConfirmResult,
    ctx: {
      ui: { setStatus: (id: string, msg: string | undefined) => void; notify: (msg: string, level: string) => void };
    },
  ) {
    if (result.toggledAutoClassify) {
      state.autoClassify = state.autoClassify === "on" ? "off" : "on";
      ctx.ui.notify(`Auto-classify: ${state.autoClassify}`, "info");
      updateStatus(ctx);
    }
  }

  function updateStatus(ctx: { ui: { setStatus: (id: string, msg: string | undefined) => void } }) {
    const stats = getSidecarStats();
    const costStr = stats.calls > 0 ? ` ($${stats.cost.toFixed(4)})` : "";
    const explainStr = explainEnabled ? " +explain" : "";
    const autoStr = state.autoClassify === "on" ? " +auto" : "";
    const autoCount = state.autoAllowLog.length > 0 ? ` [${state.autoAllowLog.length} auto]` : "";
    ctx.ui.setStatus("permission-gate", `${MODE_LABELS[state.mode]}${autoStr}${explainStr}${autoCount}${costStr}`);
  }

  // Discover git root on session start
  pi.on("session_start", async (_event, ctx) => {
    state.gitRoot = findGitRoot(ctx.cwd);
    explainEnabled = hasRole("explain");
    updateStatus(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    state.gitRoot = findGitRoot(ctx.cwd);
    state.allowedBashPrefixes = [];
    state.allowedPaths = [];
    state.allowedPathGlobs = [];
    state.toolOverrides = {};
    state.classifyCache.clear();
    state.autoAllowLog = [];
    updateStatus(ctx);
  });

  // Toggle auto-classify
  pi.registerShortcut("ctrl+shift+c", {
    description: "Toggle auto-classify",
    handler: async (ctx) => {
      if (!hasRole("explain")) {
        ctx.ui.notify("No 'explain' role configured in ~/.pi/agent/roles.json", "warning");
        return;
      }
      state.autoClassify = state.autoClassify === "on" ? "off" : "on";
      updateStatus(ctx);
      ctx.ui.notify(`Auto-classify: ${state.autoClassify}`, "info");
    },
  });

  // Cycle modes
  pi.registerShortcut("ctrl+shift+a", {
    description: "Cycle permission mode",
    handler: async (ctx) => {
      const idx = MODE_CYCLE.indexOf(state.mode);
      state.mode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
      updateStatus(ctx);
      ctx.ui.notify(`Permissions: ${MODE_LABELS[state.mode]} - ${MODE_SHORT[state.mode]}`, "info");
    },
  });

  // /permissions command
  pi.registerCommand("permissions", {
    description: "Permission gate settings",
    handler: async (_args, ctx) => {
      while (true) {
        let msg = `Current: ${MODE_LABELS[state.mode]}\n`;
        msg += `${MODE_DESCRIPTIONS[state.mode]}\n\n`;
        msg += `Project root: ${state.gitRoot ?? ctx.cwd}${state.gitRoot ? " (git)" : " (no git repo)"}\n\n`;

        msg += "Modes (Ctrl+Shift+A to cycle):\n";
        for (const m of MODE_CYCLE) {
          const marker = m === state.mode ? ">" : " ";
          msg += `  ${marker} ${MODE_LABELS[m]}  ${MODE_SHORT[m]}\n`;
        }

        // Tool overrides
        const overrideTools = ["edit", "write", "bash"];
        msg += "\nTool rules:\n";
        for (const t of overrideTools) {
          const setting = state.toolOverrides[t] ?? "confirm";
          msg += `  ${t}: ${setting}\n`;
        }

        msg += `\nAuto-classify: ${state.autoClassify}${hasRole("explain") ? "" : " (no 'explain' role in roles.json)"}\n`;
        msg += `Explain: ${explainEnabled ? "on" : "off"}${hasRole("explain") ? "" : " (no 'explain' role in roles.json)"}\n`;
        const stats = getSidecarStats();
        if (stats.calls > 0) {
          msg += `Sidecar: ${stats.calls} calls, $${stats.cost.toFixed(4)}\n`;
        }
        if (state.autoAllowLog.length > 0) {
          msg += `Auto-allowed: ${state.autoAllowLog.length} calls\n`;
        }

        // Session allows
        const hasAllows =
          state.allowedBashPrefixes.length > 0 || state.allowedPaths.length > 0 || state.allowedPathGlobs.length > 0;
        if (hasAllows) {
          msg += "\nSession allows:\n";
          for (const p of state.allowedBashPrefixes) {
            msg += `  bash prefix: "${p}"\n`;
          }
          for (const p of state.allowedPaths) {
            msg += `  path: ${p}\n`;
          }
          for (const g of state.allowedPathGlobs) {
            msg += `  glob: ${g}\n`;
          }
        }

        const options = [
          "Done",
          `Toggle auto-classify (${state.autoClassify})`,
          "Toggle edit tool (allow/confirm)",
          "Toggle write tool (allow/confirm)",
          "Toggle bash tool (allow/confirm)",
          `Toggle explain (${explainEnabled ? "on" : "off"})`,
          "Add path glob rule",
          "Add bash prefix rule",
          ...(state.autoAllowLog.length > 0 ? ["View auto-allow log"] : []),
          ...(hasAllows ? ["Clear all session allows"] : []),
          "Reset to Careful",
        ];

        const choice = await ctx.ui.select(msg, options);

        if (choice === "Done" || choice === undefined) break;

        if (choice?.startsWith("Toggle auto-classify")) {
          if (hasRole("explain")) {
            state.autoClassify = state.autoClassify === "on" ? "off" : "on";
            if (state.autoClassify === "off") {
              lastVerdict = null;
              updateWidget(ctx);
            }
            ctx.ui.notify(`Auto-classify: ${state.autoClassify}`, "info");
            updateStatus(ctx);
          } else {
            ctx.ui.notify("No 'explain' role configured in ~/.pi/agent/roles.json", "warning");
          }
        } else if (choice === "View auto-allow log") {
          let logMsg = `Auto-allowed calls (${state.autoAllowLog.length}):\n\n`;
          for (const entry of state.autoAllowLog.slice(-20)) {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            logMsg += `  ${time} ${entry.verdict.toUpperCase()} ${entry.toolName}: ${entry.short}\n`;
          }
          if (state.autoAllowLog.length > 20) {
            logMsg += `  ... and ${state.autoAllowLog.length - 20} more\n`;
          }
          await ctx.ui.select(logMsg, ["Back"]);
        } else if (choice === "Toggle edit tool (allow/confirm)") {
          state.toolOverrides.edit = state.toolOverrides.edit === "allow" ? undefined : "allow";
          ctx.ui.notify(`edit: ${state.toolOverrides.edit ?? "confirm"}`, "info");
        } else if (choice === "Toggle write tool (allow/confirm)") {
          state.toolOverrides.write = state.toolOverrides.write === "allow" ? undefined : "allow";
          ctx.ui.notify(`write: ${state.toolOverrides.write ?? "confirm"}`, "info");
        } else if (choice === "Toggle bash tool (allow/confirm)") {
          state.toolOverrides.bash = state.toolOverrides.bash === "allow" ? undefined : "allow";
          ctx.ui.notify(`bash: ${state.toolOverrides.bash ?? "confirm"}`, "info");
        } else if (choice?.startsWith("Toggle explain")) {
          if (hasRole("explain")) {
            explainEnabled = !explainEnabled;
            ctx.ui.notify(`Explain: ${explainEnabled ? "on" : "off"}`, "info");
          } else {
            ctx.ui.notify("No 'explain' role configured in ~/.pi/agent/roles.json", "warning");
          }
        } else if (choice === "Add path glob rule") {
          const glob = await ctx.ui.input("Path glob (e.g. **/*.nix, config/llm/pi/**):");
          if (glob) {
            state.allowedPathGlobs.push(glob);
            ctx.ui.notify(`Added glob: ${glob}`, "info");
          }
        } else if (choice === "Add bash prefix rule") {
          const prefix = await ctx.ui.input("Bash prefix (e.g. bun test, git):");
          if (prefix) {
            state.allowedBashPrefixes.push(prefix);
            ctx.ui.notify(`Added bash prefix: "${prefix}"`, "info");
          }
        } else if (choice === "Clear all session allows") {
          state.allowedBashPrefixes = [];
          state.allowedPaths = [];
          state.allowedPathGlobs = [];
          state.toolOverrides = {};
          ctx.ui.notify("Session allows cleared", "info");
        } else if (choice === "Reset to Careful") {
          state.mode = "careful";
          state.autoClassify = "off";
          state.allowedBashPrefixes = [];
          state.allowedPaths = [];
          state.allowedPathGlobs = [];
          state.toolOverrides = {};
          state.classifyCache.clear();
          state.autoAllowLog = [];
          updateStatus(ctx);
          ctx.ui.notify("Reset to Careful mode", "info");
        }
      }
    },
  });

  /** Show the confirmation dialog and process the user's choice. Returns tool_call event result. */
  async function showConfirmDialog(
    ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
    event: { toolName: string; toolCallId: string; input: unknown },
    decision: import("./logic").GateDecision,
    explanation?: ExplanationProvider,
  ): Promise<{ block: true; reason: string } | undefined> {
    if (decision.confirmType === "bash") {
      const prefix = decision.suggestedPrefix ?? "";
      const result = await confirm(
        ctx,
        `bash: ${decision.displayPath}`,
        ["Allow once", `Allow "${prefix}" for this session`, "Allow all bash for this session", "Block"],
        explanation,
      );
      handleDialogAutoToggle(result, ctx);
      const { choice, note, explanation: explResult } = result;

      if (choice === "Block" || choice === null) {
        return { block: true, reason: blockReason(note, explResult, "Blocked by permission gate") };
      }
      if (choice?.startsWith('Allow "') && choice.endsWith('" for this session')) {
        state.allowedBashPrefixes.push(prefix);
        ctx.ui.notify(`Allowing bash prefix: "${prefix}"`, "info");
      }
      if (choice === "Allow all bash for this session") {
        state.toolOverrides.bash = "allow";
        ctx.ui.notify("Bash allowed for this session", "warning");
      }
      if (note) pendingNotes.set(event.toolCallId, note);
      return undefined;
    }

    if (decision.confirmType === "sensitive") {
      const path = decision.displayPath ?? "";
      const result = await confirm(
        ctx,
        `Sensitive file: ${path} (${event.toolName})`,
        ["Allow once", `Allow "${path}" for this session`, "Block"],
        explanation,
      );
      handleDialogAutoToggle(result, ctx);
      const { choice, note, explanation: explResult } = result;

      if (choice === "Block" || choice === null) {
        return { block: true, reason: blockReason(note, explResult, "Blocked (sensitive file)") };
      }
      if (choice?.startsWith('Allow "')) {
        state.allowedPaths.push(path);
      }
      if (note) pendingNotes.set(event.toolCallId, note);
      return undefined;
    }

    // write, outside-project
    const path = decision.displayPath ?? "";
    const title =
      decision.confirmType === "outside-project"
        ? `${event.toolName} outside project: ${path}`
        : `${event.toolName}: ${path}`;

    const result = await confirm(ctx, title, ["Allow once", `Allow "${path}" for this session`, "Block"], explanation);
    handleDialogAutoToggle(result, ctx);
    const { choice, note, explanation: explResult } = result;

    if (choice === "Block" || choice === null) {
      return { block: true, reason: blockReason(note, explResult, "Blocked by permission gate") };
    }
    if (choice?.startsWith('Allow "')) {
      state.allowedPaths.push(path);
    }
    if (note) pendingNotes.set(event.toolCallId, note);
    return undefined;
  }

  // Main permission gate
  pi.on("tool_call", async (event, ctx) => {
    const decision = decide(event.toolName, event.input as Record<string, unknown>, ctx.cwd, state);

    if (decision.action === "allow") return undefined;

    if (decision.action === "block") {
      return { block: true, reason: decision.reason ?? "Blocked by permission gate" };
    }

    // action === "confirm"
    if (!ctx.hasUI) {
      return { block: true, reason: `${event.toolName} blocked in non-interactive mode (permission gate)` };
    }

    const input = event.input as Record<string, unknown>;

    // Auto-classify: call sidecar before showing dialog
    if (state.autoClassify === "on" && hasRole("explain")) {
      const key = cacheKey(event.toolName, input);
      const cached = state.classifyCache.get(key);

      if (cached && shouldAutoAllow(cached.verdict, state.mode)) {
        state.autoAllowLog.push({
          toolName: event.toolName,
          description: describeToolCall(event.toolName, input),
          verdict: cached.verdict,
          short: cached.short,
          timestamp: Date.now(),
        });
        lastVerdict = `${cached.verdict.toUpperCase()} (cached) ${event.toolName}: ${cached.short}`;
        updateWidget(ctx);
        updateStatus(ctx);
        return undefined;
      }

      if (!cached) {
        ctx.ui.setWorkingMessage("Classifying...");
        const explResult = await classify(event.toolName, input, ctx.modelRegistry);
        ctx.ui.setWorkingMessage();

        if (explResult) {
          state.classifyCache.set(key, {
            verdict: explResult.verdict,
            short: explResult.short,
            detail: explResult.detail,
          });

          if (shouldAutoAllow(explResult.verdict, state.mode)) {
            state.autoAllowLog.push({
              toolName: event.toolName,
              description: describeToolCall(event.toolName, input),
              verdict: explResult.verdict,
              short: explResult.short,
              timestamp: Date.now(),
            });
            lastVerdict = `${explResult.verdict.toUpperCase()} ${event.toolName}: ${explResult.short}`;
            updateWidget(ctx);
            updateStatus(ctx);
            return undefined;
          }

          // Not auto-allowed -- fall through to dialog with pre-loaded explanation
          return await showConfirmDialog(ctx, event, decision, makePreloadedExplanation(explResult));
        }
        // Sidecar failed or parse failure -- fall through to normal dialog
      }
      // Cached but not auto-allowable (e.g. DANGEROUS cached) -- fall through with pre-loaded if available
      if (cached) {
        // Cached but not auto-allowable -- show dialog with cached explanation
        return await showConfirmDialog(ctx, event, decision, makePreloadedExplanation(cached));
      }
    }

    // Normal path: build explanation provider (fires concurrently with dialog)
    const explanation = makeExplanation(event.toolName, input, ctx.modelRegistry);
    return await showConfirmDialog(ctx, event, decision, explanation);
  });

  // Clear widget when agent turn ends
  pi.on("agent_end", async (_event, ctx) => {
    lastVerdict = null;
    updateWidget(ctx);
  });

  // Append user notes to tool results so the model sees them.
  // Also refresh status bar (sidecar cost may have changed).
  pi.on("tool_result", async (event, ctx) => {
    if (explainEnabled) updateStatus(ctx);
    const note = pendingNotes.get(event.toolCallId);
    if (!note) return undefined;
    pendingNotes.delete(event.toolCallId);

    return {
      content: [...event.content, { type: "text" as const, text: `\n\n[User note: ${note}]` }],
    };
  });
}
