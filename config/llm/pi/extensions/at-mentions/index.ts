/**
 * @ mention enhancement extension
 *
 * Inlines file and directory contents when @-mentioned in a prompt:
 * - @file.ts → inlines file contents as context
 * - @dir/ → inlines directory listing as context
 *
 * Content is injected as a hidden message via before_agent_start,
 * keeping the user's prompt text clean. Each mention is resolved
 * at most once per session to avoid duplicate context.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractAtMentions } from "../shared/at-mentions";
import { resolveAtMention } from "./resolve.js";

export default function atMentionsExtension(pi: ExtensionAPI) {
  let resolvedMentions = new Set<string>();
  let cwd = "";
  let pendingContext = "";

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    resolvedMentions = new Set();
  });

  // Resolve @file and @dir mentions from user input
  pi.on("input", async (event, ctx) => {
    if (!cwd) return { action: "continue" as const };

    const mentions = extractAtMentions(event.text);
    if (mentions.length === 0) return { action: "continue" as const };

    const parts: string[] = [];
    const names: string[] = [];

    for (const mention of mentions) {
      if (resolvedMentions.has(mention)) continue;
      const resolved = resolveAtMention(mention, cwd);
      if (resolved) {
        resolvedMentions.add(mention);
        parts.push(resolved.content);
        names.push(resolved.type === "directory" ? `${resolved.mention} (dir)` : resolved.mention);
      }
    }

    if (parts.length > 0) {
      pendingContext = parts.join("\n\n");
      ctx.ui.notify(`Loaded ${names.join(", ")}`, "info");
    }

    return { action: "continue" as const };
  });

  // Inject resolved content as hidden message
  pi.on("before_agent_start", async () => {
    if (!pendingContext) return;

    const content = pendingContext;
    pendingContext = "";

    return {
      message: {
        customType: "at-mention-context",
        content,
        display: false,
      },
    };
  });
}
