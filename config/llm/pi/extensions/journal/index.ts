/**
 * Pi journal extension.
 *
 * Injects global instructions and journal notes at session start,
 * nudges the agent to journal when context gets high, and supports
 * env var overrides:
 *   LLM_VANILLA=1 - skip all custom context
 *   NO_JOURNAL=1  - skip journal reading (fresh session)
 *
 * Context building is shared with Claude Code and OpenCode via
 * shared/journal-context.ts. This extension adds pi-specific behavior:
 * event hooks, context nudge, compaction reminder.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildJournalContext, getRecentNotes, loadJournalConfig } from "../shared/journal-context";

/** Context usage fraction (0-1) above which the agent gets a journal nudge. */
const CONTEXT_NUDGE_THRESHOLD = 0.7;

export default function journalExtension(pi: ExtensionAPI) {
  const config = loadJournalConfig();
  let cachedContext = "";
  let firstPrompt = true;
  let nudged = false;

  async function loadContext(cwd: string, ctx: ExtensionContext) {
    cachedContext = await buildJournalContext(config, cwd);

    if (process.env.LLM_VANILLA !== "1" && process.env.NO_JOURNAL !== "1") {
      const projectName = basename(cwd);
      const result = await getRecentNotes(config.notesDir, projectName);
      pi.events.emit("journal:loaded", { projectName, notes: result.notes });

      if (result.exists) {
        const t = ctx.ui.theme;
        const notesPath = result.path;
        const parts: string[] = [
          `${t.fg("mdHeading", "[Journal]")} ${t.fg("dim", `${result.notes.length} notes`)} ${t.fg("dim", `file://${notesPath}`)}`,
        ];
        if (result.notes.length > 0) {
          parts.push(result.notes.map((n) => t.fg("dim", `  ${n.filename}`)).join("\n"));
        }

        if (result.todo) {
          const lines = result.todo.split("\n");
          const preview = lines.slice(0, 30).join("\n");
          const todoPath = `${notesPath}/TODO.md`;
          const suffix = lines.length > 30 ? `\n${t.fg("dim", `[and ${lines.length - 30} more lines]`)}` : "";
          parts.push(
            `${t.fg("mdHeading", "[TODO]")} ${t.fg("dim", `file://${todoPath}`)}\n${t.fg("dim", preview)}${suffix}`,
          );
        }

        ctx.ui.notify(parts.join("\n\n"), "info");
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    firstPrompt = true;
    nudged = false;
    await loadContext(ctx.cwd, ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    firstPrompt = true;
    nudged = false;
    await loadContext(ctx.cwd, ctx);
  });

  pi.on("before_agent_start", async () => {
    if (!firstPrompt || !cachedContext) return;
    firstPrompt = false;

    return {
      message: {
        customType: "journal-context",
        content: cachedContext,
        display: false,
      },
    };
  });

  // Nudge the agent to journal when context is getting high
  pi.on("agent_end", async (_event, ctx) => {
    if (process.env.LLM_VANILLA === "1" || nudged) return;

    const usage = ctx.getContextUsage();
    if (!usage?.tokens) return;

    const model = ctx.model;
    if (!model?.contextWindow) return;

    const fraction = usage.tokens / model.contextWindow;
    if (fraction >= CONTEXT_NUDGE_THRESHOLD) {
      nudged = true;
      const pct = Math.round(fraction * 100);
      ctx.ui.notify(`Context at ${pct}% -- journal your progress before compaction erases it.`, "warning");
    }
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    if (process.env.LLM_VANILLA === "1") return;
    ctx.ui.notify("Context compacting - journal your progress!", "warning");
    return undefined;
  });
}
