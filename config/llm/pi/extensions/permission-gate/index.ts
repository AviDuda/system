/**
 * Pi permission gate extension.
 *
 * Thin UI wrapper around the decision logic in ./logic.ts.
 * See the README for details.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  renderDiff,
} from "@earendil-works/pi-coding-agent";

// Deep import: pi doesn't export edit-diff from its package exports map.
// Use import.meta.resolve to find the package entry, then derive the internal path.
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piRoot = dirname(dirname(piEntry)); // dist/index.js -> dist -> package root
const editDiffPath = join(piRoot, "dist", "core", "tools", "edit-diff.js");

type ComputeEditsDiffFn = (
  path: string,
  edits: Array<{ oldText?: string; newText?: string }>,
  cwd: string,
) => Promise<{ diff: string; firstChangedLine?: number } | { error: string }>;

let _computeEditsDiff: ComputeEditsDiffFn | undefined;

// patch's preview is a sibling extension; its tolerant matching differs from
// pi's, so we use patch's own diff computation (not computeEditsDiff) to avoid
// a misleading empty preview for normalized matches (arrows, tab↔space).
type ComputePatchPreviewFn = (
  topPath: string,
  edits: Array<{ oldText?: string; newText?: string; path?: string; anchor?: string; replaceAll?: boolean }>,
  cwd: string,
) => Promise<{ diff: string; firstChangedLine?: number } | undefined>;
let _computePatchPreview: ComputePatchPreviewFn | undefined;

import { extractText, getSidecarStats, hasRole, sidecarComplete } from "../shared/model-roles";
import {
  type ConfirmResult,
  type ConfirmUIOptions,
  createConfirmUI,
  type DetailsBody,
  type DiffBody,
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
import { EXPLAIN_SYSTEM_PROMPT } from "./prompts";

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

  /** Classify a tool call via sidecar. Returns parsed result or null on failure/timeout. */
  async function classify(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
    rawDiff?: string,
    timeoutMs = 5000,
  ): Promise<import("./confirm-ui").ExplanationResult | null> {
    const description = describeToolCall(toolName, input, rawDiff);
    const result = await Promise.race([
      sidecarComplete(
        "explain",
        {
          systemPrompt: EXPLAIN_SYSTEM_PROMPT,
          messages: [{ role: "user", content: description, timestamp: Date.now() }],
        },
        ctx.modelRegistry,
        { notify: ctx.ui.notify },
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!result) return null;
    // strict: parse failure = null (don't auto-allow garbage)
    return parseExplanation(extractText(result.message), true);
  }

  /** Build an ExplanationProvider that calls the "explain" sidecar role. */
  function makeExplanation(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
    rawDiff?: string,
  ): ExplanationProvider | undefined {
    if (!explainEnabled) return undefined;

    // Check cache first -- skip sidecar call if we already classified this
    const key = cacheKey(toolName, input);
    const cachedResult = state.classifyCache.get(key);
    if (cachedResult) {
      return { promise: Promise.resolve(cachedResult), abort: () => {} };
    }

    const description = describeToolCall(toolName, input, rawDiff);
    const abortController = new AbortController();

    const promise = (async (): Promise<ExplanationResult | null> => {
      const result = await sidecarComplete(
        "explain",
        {
          systemPrompt: EXPLAIN_SYSTEM_PROMPT,
          messages: [{ role: "user", content: description, timestamp: Date.now() }],
        },
        ctx.modelRegistry,
        { signal: abortController.signal, notify: ctx.ui.notify },
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
    ctx: ExtensionContext,
    title: string,
    options: string[],
    explanation?: ExplanationProvider,
    diffBody?: DiffBody,
    detailsBody?: DetailsBody,
  ): Promise<ConfirmResult> {
    // In non-TUI modes (rpc/print/json), ctx.ui.custom() returns undefined — no
    // TUI to render the multi-option dialog. Fall back to ctx.ui.confirm(), which
    // works over RPC (relayed to the parent TUI by the subagent extension) and
    // returns a boolean. Can't show diff/explanation or multi-option choices here.
    //
    // Guard on ctx.mode, NOT ctx.hasUI: hasUI is true in RPC mode by design
    // (confirm/select/input work there), but custom() does not. Guarding on
    // !ctx.hasUI skipped this branch in subagents, so confirm() fell through to
    // custom() → undefined → crash in handleDialogAutoToggle (toggledAutoClassify).
    if (ctx.mode !== "tui") {
      const confirmed = await ctx.ui.confirm(title, options.join(", "));
      return { choice: confirmed ? options[0] : null, note: "", explanation: null };
    }

    const uiOptions: ConfirmUIOptions = {
      autoClassify: state.autoClassify === "on",
      hasExplainRole: hasRole("explain"),
    };
    return ctx.ui.custom<ConfirmResult>((tui, theme, kb, done) =>
      createConfirmUI(tui, theme, kb, done, title, options, explanation, uiOptions, diffBody, detailsBody),
    );
  }

  /** Process auto-classify toggle from dialog result. */
  function handleDialogAutoToggle(
    result: ConfirmResult,
    ctx: {
      ui: {
        setStatus: (id: string, msg: string | undefined) => void;
        notify: (msg: string, level?: "info" | "warning" | "error") => void;
      };
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

  pi.on("session_start", async (_event, ctx) => {
    state.gitRoot = findGitRoot(ctx.cwd);
    state.allowedBashPrefixes = [];
    state.allowedPaths = [];
    state.allowedPathGlobs = [];
    state.toolOverrides = {};
    state.classifyCache.clear();
    state.autoAllowLog = [];
    explainEnabled = hasRole("explain");
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
        const overrideTools = ["edit", "patch", "write", "bash"];
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
          "Toggle patch tool (allow/confirm)",
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
        } else if (choice === "Toggle patch tool (allow/confirm)") {
          state.toolOverrides.patch = state.toolOverrides.patch === "allow" ? undefined : "allow";
          ctx.ui.notify(`patch: ${state.toolOverrides.patch ?? "confirm"}`, "info");
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

  /** Build a DetailsBody from tool input for display when there's no diff. */
  function computeDetailsBody(toolName: string, input: Record<string, unknown>): DetailsBody | undefined {
    const desc = describeToolCall(toolName, input);
    const lines = desc.split("\n");
    if (lines.length <= 1 && lines[0]?.length === 0) return undefined;
    return { lines };
  }

  /** Compute a styled diff for the confirm dialog. */
  async function computeDiffBody(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string,
  ): Promise<DiffBody | undefined> {
    try {
      if (toolName === "edit" && input.edits && Array.isArray(input.edits)) {
        const path = typeof input.path === "string" ? input.path : "";
        const edits = input.edits as Array<{ oldText?: string; newText?: string }>;
        if (!_computeEditsDiff) {
          const mod = await import(editDiffPath);
          _computeEditsDiff = mod.computeEditsDiff as ComputeEditsDiffFn;
        }
        const result = await _computeEditsDiff(path, edits, cwd);
        if ("error" in result) return undefined;
        const styled = renderDiff(result.diff);
        const lines = styled.split("\n");
        // Find first actual change line in the raw diff (skip --- +++ headers)
        const rawLines = result.diff.split("\n");
        let firstChangedLine: number | undefined;
        for (let i = 0; i < rawLines.length; i++) {
          const rl = rawLines[i];
          if ((rl.startsWith("-") || rl.startsWith("+")) && !rl.startsWith("---") && !rl.startsWith("+++")) {
            firstChangedLine = i;
            break;
          }
        }
        return { lines, rawDiff: result.diff, firstChangedLine };
      }
      if (toolName === "patch" && input.edits && Array.isArray(input.edits)) {
        const path = typeof input.path === "string" ? input.path : "";
        const edits = input.edits as Array<{
          oldText?: string;
          newText?: string;
          path?: string;
          anchor?: string;
          replaceAll?: boolean;
        }>;
        if (!_computePatchPreview) {
          const mod = await import("../patch/preview");
          _computePatchPreview = mod.computePatchPreview as ComputePatchPreviewFn;
        }
        const result = await _computePatchPreview(path, edits, cwd);
        if (!result) return undefined;
        const styled = renderDiff(result.diff);
        return { lines: styled.split("\n"), rawDiff: result.diff, firstChangedLine: result.firstChangedLine };
      }
      if (toolName === "write") {
        const content = typeof input.content === "string" ? input.content : "";
        if (!content) return undefined;
        const contentLines = content.split("\n");
        const lineNumWidth = String(contentLines.length).length;
        const fakeDiff = contentLines
          .map((line, i) => `+${String(i + 1).padStart(lineNumWidth, " ")} ${line}`)
          .join("\n");
        const styled = renderDiff(fakeDiff);
        return { lines: styled.split("\n"), rawDiff: fakeDiff };
      }
    } catch {
      // Fall through -- diff is nice-to-have, not critical
    }
    return undefined;
  }

  /** Show the confirmation dialog and process the user's choice. Returns tool_call event result. */
  async function showConfirmDialog(
    ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
    event: { toolName: string; toolCallId: string; input: unknown },
    decision: import("./logic").GateDecision,
    explanation?: ExplanationProvider,
    diffBody?: DiffBody,
    detailsBody?: DetailsBody,
  ): Promise<{ block: true; reason: string } | undefined> {
    if (decision.confirmType === "bash") {
      const prefix = decision.suggestedPrefix ?? "";
      const command = decision.displayPath ?? "";
      // Always show the command in the scrollable body -- even short commands
      // can get truncated by terminal width when combined with the "bash: " prefix
      const bashDiffBody: DiffBody = diffBody ?? { lines: command.split("\n"), rawDiff: "", firstChangedLine: 0 };
      const options = ["Allow once"];
      if (!decision.escalation) {
        options.push(`Allow "${prefix}" for this session`);
      }
      options.push("Allow all bash for this session", "Block");
      const title = decision.escalation ? "bash (compound command)" : "bash";
      const result = await confirm(ctx, title, options, explanation, bashDiffBody);
      handleDialogAutoToggle(result, ctx);
      const { choice, note, explanation: explResult } = result;

      if (choice === "Block" || choice === null) {
        return { block: true, reason: blockReason(note, explResult, event.toolName) };
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
        diffBody,
      );
      handleDialogAutoToggle(result, ctx);
      const { choice, note, explanation: explResult } = result;

      if (choice === "Block" || choice === null) {
        return { block: true, reason: blockReason(note, explResult, event.toolName) };
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

    const result = await confirm(
      ctx,
      title,
      ["Allow once", `Allow "${path}" for this session`, "Block"],
      explanation,
      diffBody,
      detailsBody,
    );
    handleDialogAutoToggle(result, ctx);
    const { choice, note, explanation: explResult } = result;

    if (choice === "Block" || choice === null) {
      return { block: true, reason: blockReason(note, explResult, event.toolName) };
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
    // RPC mode subagents use ctx.ui.confirm()/select()/input() which emit
    // extension_ui_request events. The subagent extension relays these to the
    // parent's TUI and sends back extension_ui_response on stdin.
    const input = event.input as Record<string, unknown>;

    // Compute diff/preview early -- used by the patch bypass, auto-classify,
    // and the confirm dialog. Cheap (file read + matching); needed anyway.
    const diffBody = await computeDiffBody(event.toolName, input, ctx.cwd);
    const rawDiff = diffBody?.rawDiff;
    const detailsBody = diffBody ? undefined : computeDetailsBody(event.toolName, input);

    // For patch: skip confirmation when dryRun or when no useful preview was
    // produced (edits don't match, file unreadable, partial failure — the tool
    // will throw its own diagnostics, no write happens). This MUST run before
    // the hasUI check so it works in non-interactive mode (-p) too.
    if (event.toolName === "patch") {
      const isDryRun = (input as Record<string, unknown>).dryRun === true;
      if (isDryRun || !diffBody) {
        return undefined;
      }
    }

    if (!ctx.hasUI) {
      return { block: true, reason: `${event.toolName} blocked in non-interactive mode (permission gate)` };
    }

    // Auto-classify: call sidecar before showing dialog
    if (state.autoClassify === "on" && hasRole("explain")) {
      const key = cacheKey(event.toolName, input);
      const cached = state.classifyCache.get(key);

      if (cached && shouldAutoAllow(cached.verdict, state.mode)) {
        state.autoAllowLog.push({
          toolName: event.toolName,
          description: describeToolCall(event.toolName, input, rawDiff),
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
        const explResult = await classify(event.toolName, input, ctx, rawDiff);
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
              description: describeToolCall(event.toolName, input, rawDiff),
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
          return await showConfirmDialog(
            ctx,
            event,
            decision,
            makePreloadedExplanation(explResult),
            diffBody,
            detailsBody,
          );
        }
        // Sidecar failed or parse failure -- fall through to normal dialog
      }
      // Cached but not auto-allowable (e.g. DANGEROUS cached) -- fall through with pre-loaded if available
      if (cached) {
        // Cached but not auto-allowable -- show dialog with cached explanation
        return await showConfirmDialog(ctx, event, decision, makePreloadedExplanation(cached), diffBody, detailsBody);
      }
    }

    // Normal path: build explanation provider (fires concurrently with dialog)
    const explanation = makeExplanation(event.toolName, input, ctx, rawDiff);
    return await showConfirmDialog(ctx, event, decision, explanation, diffBody, detailsBody);
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
      content: [...event.content, { type: "text" as const, text: `\n\n[Instruction from the user: ${note}]` }],
    };
  });
}
