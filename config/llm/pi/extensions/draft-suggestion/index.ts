/**
 * Draft suggestion extension
 *
 * After the agent finishes, fires a cheap sidecar LLM call to suggest
 * what the user might want to say next. Shows the suggestion as greyed-out
 * ghost text in the input editor. Press Tab to accept.
 *
 * Requires a "draft" role in ~/.pi/agent/roles.json:
 * {
 *   "draft": {
 *     "models": [{ "ref": "anthropic/claude-haiku-4-5", "thinking": "off" }]
 *   }
 * }
 */

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import { type EditorTheme, Key, matchesKey, type TUI } from "@mariozechner/pi-tui";
import {
  assistantMsg,
  extractText,
  getSidecarStats,
  hasRole,
  resolveRole,
  sidecarComplete,
  userMsg,
} from "../shared/model-roles";
import { filterSuggestion, injectGhostText, parseSuggestionTag } from "./ghost-text";

// ── Ghost text editor ──

class GhostEditor extends CustomEditor {
  private ghostText: string | null = null;
  private tui_: TUI;

  /** Called when ghost text is cleared (by typing, Tab accept, etc.) */
  onGhostClear?: () => void;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    this.tui_ = tui;

    // Clear ghost text when user types
    this.onChange = () => {
      if (this.ghostText !== null) {
        this.ghostText = null;
        this.onGhostClear?.();
      }
    };
  }

  setGhostText(text: string | null) {
    this.ghostText = text;
    this.invalidate();
    this.tui_.requestRender();
  }

  getGhostText(): string | null {
    return this.ghostText;
  }

  handleInput(data: string): void {
    // Tab accepts ghost text when editor is empty and ghost text is present
    if (matchesKey(data, Key.tab) && this.ghostText && this.getText().length === 0) {
      const text = this.ghostText;
      this.ghostText = null;
      this.onGhostClear?.();
      this.setText(text);
      return;
    }

    // Any typing clears ghost text
    if (this.ghostText !== null) {
      const isPrintable = data.length === 1 && data.charCodeAt(0) >= 32;
      if (isPrintable || matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        this.ghostText = null;
        this.onGhostClear?.();
      }
    }

    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!this.ghostText || this.getText().length > 0) return lines;
    return injectGhostText(lines, this.ghostText);
  }
}

// ── Extension ──

export default function (pi: ExtensionAPI) {
  let ghostEditor: GhostEditor | null = null;
  let abortController: AbortController | null = null;
  let enabled = true;
  let latestCtx: ExtensionContext | null = null;

  function updateWidget(ctx: ExtensionContext) {
    if (ghostEditor?.getGhostText()) {
      ctx.ui.setWidget("draft-hint", [ctx.ui.theme.fg("dim", "  Tab to accept suggestion")], {
        placement: "belowEditor",
      });
    } else {
      ctx.ui.setWidget("draft-hint", undefined);
    }
  }

  async function tryGenerateSuggestion(ctx: ExtensionContext) {
    if (!enabled || !hasRole("draft") || !ghostEditor) return;

    abortController?.abort();
    abortController = new AbortController();

    const suggestion = await generateSuggestion(ctx, abortController.signal);
    if (suggestion && ghostEditor) {
      ghostEditor.setGhostText(suggestion);
      updateWidget(ctx);
    }
  }

  // Install custom editor on session start
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    if (!hasRole("draft")) return;

    ctx.ui.setEditorComponent((tui, theme, kb) => {
      ghostEditor = new GhostEditor(tui, theme, kb);
      ghostEditor.onGhostClear = () => {
        ctx.ui.setWidget("draft-hint", undefined);
      };
      return ghostEditor;
    });

    ctx.ui.setStatus("draft", ctx.ui.theme.fg("dim", "draft"));

    // Generate suggestion if resuming a session with history
    const entries = ctx.sessionManager.getBranch();
    const hasMessages = entries.some((e) => e.type === "message" && e.message.role === "user");
    if (hasMessages) {
      tryGenerateSuggestion(ctx);
    }
  });

  // On journal load, generate a "what to work on" suggestion for fresh sessions
  pi.events.on("journal:loaded", (raw: unknown) => {
    const { notes } = raw as { notes: Array<{ filename: string; content: string }> };
    if (!enabled || !hasRole("draft") || !ghostEditor || !latestCtx) return;
    if (notes.length === 0) return;

    // Only for fresh sessions -- resumed sessions already have a suggestion from above
    const entries = latestCtx.sessionManager.getBranch();
    const hasMessages = entries.some((e) => e.type === "message" && e.message.role === "user");
    if (hasMessages) return;

    const ctx = latestCtx;
    abortController?.abort();
    abortController = new AbortController();

    const journalContext = notes
      .slice(0, 2)
      .map((n: { filename: string; content: string }) => `--- ${n.filename} ---\n${n.content.slice(0, 400)}`)
      .join("\n\n");

    const { signal } = abortController;
    gatherProjectContext(pi, signal)
      .then((projectContext) => {
        const fullContext = [projectContext, journalContext].filter(Boolean).join("\n\n");
        return generateFromContext(fullContext, ctx, signal);
      })
      .then((suggestion) => {
        if (suggestion && ghostEditor) {
          ghostEditor.setGhostText(suggestion);
          updateWidget(ctx);
        }
      });
  });

  // After agent finishes, generate a suggestion
  pi.on("agent_end", async (_event, ctx) => {
    if (!enabled || !hasRole("draft") || !ghostEditor) return;

    // Abort any previous draft call
    abortController?.abort();
    abortController = new AbortController();

    // Build context from recent conversation
    const suggestion = await generateSuggestion(ctx, abortController.signal);
    if (suggestion && ghostEditor) {
      ghostEditor.setGhostText(suggestion);
      updateWidget(ctx);
    }
  });

  // Clear suggestion when user starts typing (input event)
  pi.on("input", async (_event, ctx) => {
    abortController?.abort();
    if (ghostEditor) {
      ghostEditor.setGhostText(null);
      updateWidget(ctx);
    }
    return { action: "continue" as const };
  });

  // Command to toggle
  pi.registerCommand("draft", {
    description: "Toggle draft suggestions",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (!enabled) {
        abortController?.abort();
        if (ghostEditor) ghostEditor.setGhostText(null);
        updateWidget(ctx);
        ctx.ui.setStatus("draft", ctx.ui.theme.fg("dim", "draft off"));
      } else {
        const stats = getSidecarStats();
        const costStr = stats.cost > 0 ? ` ($${stats.cost.toFixed(4)})` : "";
        ctx.ui.setStatus("draft", ctx.ui.theme.fg("dim", `draft${costStr}`));
      }
      ctx.ui.notify(`Draft suggestions ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });
}

// ── Suggestion generation ──

async function generateSuggestion(ctx: ExtensionContext, signal: AbortSignal): Promise<string | null> {
  // Build a summary of recent conversation for the draft model
  const entries = ctx.sessionManager.getBranch();
  const recentMessages: Array<{ role: string; text: string }> = [];

  // Collect last ~5 message pairs for context
  let count = 0;
  for (let i = entries.length - 1; i >= 0 && count < 10; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;

    const msg = entry.message;
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("");
      if (text.trim()) {
        recentMessages.unshift({ role: "user", text: text.slice(0, 200) });
        count++;
      }
    } else if (msg.role === "assistant") {
      const text = msg.content
        .filter((c: { type: string }): c is { type: "text"; text: string } => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("");
      if (text.trim()) {
        recentMessages.unshift({ role: "assistant", text: text.slice(0, 200) });
        count++;
      }
    }
  }

  if (recentMessages.length === 0) return null;

  // Format as conversation context
  const conversationSummary = recentMessages
    .map((m) => `${m.role === "user" ? "human" : "assistant"}: ${m.text}`)
    .join("\n");

  // Determine max attempts from the resolved model's config (default: 1)
  const resolved = await resolveRole("draft", ctx.modelRegistry);
  const maxAttempts = resolved?.entry.maxAttempts ?? 1;

  const sidecarContext = {
    systemPrompt: `You predict what the HUMAN types next. The human is a developer talking to a coding AI. Humans type commands and questions like:
- "Show me the test files"
- "How does the auth module work?"
- "Add error handling to the API"
- "What's in the config directory?"

NEVER generate assistant-style responses like "Would you like to...", "I can help with...", "Let me...", "Here's what I found...". Those are what the ASSISTANT says, not the human.`,
    messages: [
      userMsg(`human: Fix the failing test in auth.ts
assistant: I've fixed the test by updating the mock.`),
      assistantMsg("<suggestion>Run the full test suite now</suggestion>"),
      userMsg(`human: Show me the project structure
assistant: Here's the directory layout: src/, tests/, config/...`),
      assistantMsg("<suggestion>How many lines of code in each module?</suggestion>"),
      userMsg(`human: Hello!
assistant: Hey! Last session we built the auth module. What are you working on today?`),
      assistantMsg("<suggestion>Let's add rate limiting to the auth endpoints</suggestion>"),
      userMsg(conversationSummary),
      assistantMsg("<suggestion>"),
    ],
  };

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await sidecarComplete("draft", sidecarContext, ctx.modelRegistry, {
        signal,
        notify: ctx.ui.notify,
      });
      if (!result) return null;

      const raw = extractText(result.message);
      const suggestion = filterSuggestion(parseSuggestionTag(raw));
      if (suggestion) return suggestion;

      // Filtered out -- retry if attempts remain
    }
    return null;
  } catch {
    // Aborted or failed - no suggestion
    return null;
  }
}

async function gatherProjectContext(pi: ExtensionAPI, signal: AbortSignal): Promise<string> {
  const parts: string[] = [];

  // Git status -- shows uncommitted work, which is often what to address next
  try {
    const status = await pi.exec("git", ["status", "--short"], { signal, timeout: 3000 });
    if (status.code === 0 && status.stdout.trim()) {
      parts.push(`Git status:\n${status.stdout.trim().slice(0, 300)}`);
    }
  } catch {
    // Not a git repo or git not available
  }

  // Recent git log -- what was worked on lately
  try {
    const log = await pi.exec("git", ["log", "--oneline", "-5"], { signal, timeout: 3000 });
    if (log.code === 0 && log.stdout.trim()) {
      parts.push(`Recent commits:\n${log.stdout.trim()}`);
    }
  } catch {
    // Ignore
  }

  // Top-level directory listing for project awareness
  try {
    const ls = await pi.exec("ls", ["-1"], { signal, timeout: 3000 });
    if (ls.code === 0 && ls.stdout.trim()) {
      parts.push(`Project files:\n${ls.stdout.trim().slice(0, 200)}`);
    }
  } catch {
    // Ignore
  }

  return parts.join("\n\n");
}

async function generateFromContext(
  startupContext: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | null> {
  const resolved = await resolveRole("draft", ctx.modelRegistry);
  const maxAttempts = resolved?.entry.maxAttempts ?? 1;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await sidecarComplete(
        "draft",
        {
          systemPrompt: `You predict what a developer will type as their FIRST message when starting a session. Based on the project context and recent work, suggest what they'd work on next. One short sentence, a direct instruction or question. NEVER use assistant-style language like "Would you like", "I can help", "Let me".`,
          messages: [
            userMsg(`Context: Auth module project. Recent notes: Fixed auth bug, tests passing. Deploy pending.`),
            assistantMsg("<suggestion>Deploy the auth fix to staging</suggestion>"),
            userMsg(
              `Context: Nix system config. Recent notes: Built draft-suggestion extension, needs live testing. Also need to run nix-switch.`,
            ),
            assistantMsg("<suggestion>Run mise nix-switch to deploy the pending changes</suggestion>"),
            userMsg(`Context:\n${startupContext}`),
            assistantMsg("<suggestion>"),
          ],
        },
        ctx.modelRegistry,
        { signal, notify: ctx.ui.notify },
      );

      if (!result) return null;

      const raw = extractText(result.message);
      const suggestion = filterSuggestion(parseSuggestionTag(raw));
      if (suggestion) return suggestion;
    }
    return null;
  } catch {
    return null;
  }
}
