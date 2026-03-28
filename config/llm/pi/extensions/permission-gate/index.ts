/**
 * Pi permission gate extension.
 *
 * Thin UI wrapper around the decision logic in ./logic.ts.
 * See the README for details.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component, KeybindingsManager, Theme, TUI } from "@mariozechner/pi-tui";
import { extractText, getSidecarStats, hasRole, sidecarComplete } from "../shared/model-roles";
import { type ConfirmResult, createConfirmUI, type ExplanationProvider, type ExplanationResult } from "./confirm-ui";
import { blockReason, describeToolCall, parseExplanation } from "./explain";
import {
  createInitialState,
  decide,
  findGitRoot,
  type GateState,
  MODE_CYCLE,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  MODE_SHORT,
} from "./logic";

export default function permissionGate(pi: ExtensionAPI) {
  const state: GateState = createInitialState();
  const pendingNotes: Map<string, string> = new Map();
  let explainEnabled = false;

  /** Build an ExplanationProvider that calls the "explain" sidecar role. */
  function makeExplanation(
    toolName: string,
    input: Record<string, unknown>,
    modelRegistry: Parameters<typeof sidecarComplete>[2],
  ): ExplanationProvider | undefined {
    if (!explainEnabled) return undefined;

    const description = describeToolCall(toolName, input);
    const abortController = new AbortController();

    const promise = (async (): Promise<ExplanationResult | null> => {
      const result = await sidecarComplete(
        "explain",
        {
          systemPrompt: `You assess tool calls for a developer reviewing permissions.

First line must start with SAFE, RISKY, or DANGEROUS followed by a pipe and a short tl;dr.
Then optionally a blank line and 2-3 sentences of detail.

Examples:
SAFE|Reads package.json in the project directory
RISKY|Modifies nginx config, could break web server
DANGEROUS|Deletes entire home directory recursively

Use SAFE for routine operations. Use RISKY for things that could cause issues. Use DANGEROUS for destructive or sensitive operations.
Be direct, no filler.`,
          messages: [{ role: "user", content: description, timestamp: Date.now() }],
        },
        modelRegistry,
        { signal: abortController.signal },
      );
      if (!result) return null;
      return parseExplanation(extractText(result.message));
    })();

    return { promise, abort: () => abortController.abort() };
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
    return ctx.ui.custom<ConfirmResult>((tui, theme, kb, done) =>
      createConfirmUI(tui, theme, kb, done, title, options, explanation),
    );
  }

  function updateStatus(ctx: { ui: { setStatus: (id: string, msg: string | undefined) => void } }) {
    const stats = getSidecarStats();
    const costStr = stats.calls > 0 ? ` ($${stats.cost.toFixed(4)})` : "";
    const explainStr = explainEnabled ? " +explain" : "";
    ctx.ui.setStatus("permission-gate", `${MODE_LABELS[state.mode]}${explainStr}${costStr}`);
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
    updateStatus(ctx);
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

        msg += `\nExplain: ${explainEnabled ? "on" : "off"}${hasRole("explain") ? "" : " (no 'explain' role in roles.json)"}\n`;
        const stats = getSidecarStats();
        if (stats.calls > 0) {
          msg += `Sidecar: ${stats.calls} calls, $${stats.cost.toFixed(4)}\n`;
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
          "Toggle edit tool (allow/confirm)",
          "Toggle write tool (allow/confirm)",
          "Toggle bash tool (allow/confirm)",
          `Toggle explain (${explainEnabled ? "on" : "off"})`,
          "Add path glob rule",
          "Add bash prefix rule",
          ...(hasAllows ? ["Clear all session allows"] : []),
          "Reset to Careful",
        ];

        const choice = await ctx.ui.select(msg, options);

        if (choice === "Done" || choice === undefined) break;

        if (choice === "Toggle edit tool (allow/confirm)") {
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
          state.allowedBashPrefixes = [];
          state.allowedPaths = [];
          state.allowedPathGlobs = [];
          state.toolOverrides = {};
          updateStatus(ctx);
          ctx.ui.notify("Reset to Careful mode", "info");
        }
      }
    },
  });

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

    // Build explanation provider for sidecar LLM call (fires concurrently with dialog)
    const explanation = makeExplanation(event.toolName, event.input as Record<string, unknown>, ctx.modelRegistry);

    // Build confirmation UI based on confirmType
    if (decision.confirmType === "bash") {
      const prefix = decision.suggestedPrefix ?? "";
      const {
        choice,
        note,
        explanation: explResult,
      } = await confirm(
        ctx,
        `bash: ${decision.displayPath}`,
        ["Allow once", `Allow "${prefix}" for this session`, "Allow all bash for this session", "Block"],
        explanation,
      );

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
      const {
        choice,
        note,
        explanation: explResult,
      } = await confirm(
        ctx,
        `Sensitive file: ${path} (${event.toolName})`,
        ["Allow once", `Allow "${path}" for this session`, "Block"],
        explanation,
      );

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

    const {
      choice,
      note,
      explanation: explResult,
    } = await confirm(ctx, title, ["Allow once", `Allow "${path}" for this session`, "Block"], explanation);

    if (choice === "Block" || choice === null) {
      return { block: true, reason: blockReason(note, explResult, "Blocked by permission gate") };
    }
    if (choice?.startsWith('Allow "')) {
      state.allowedPaths.push(path);
    }
    if (note) pendingNotes.set(event.toolCallId, note);
    return undefined;
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
