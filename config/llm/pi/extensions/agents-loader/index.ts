/**
 * AGENTS.md / AGENTS.local.md loader extension
 *
 * Loads agent instruction files that pi doesn't handle natively:
 *
 * 1. **Startup**: AGENTS.local.md (and CLAUDE.local.md) from cwd and
 *    parent directories. Injected via before_agent_start on first prompt.
 *
 * 2. **Tool access**: When read/write/edit/ls/find/grep tools touch files
 *    in subdirectories, discovers AGENTS.md and AGENTS.local.md in the
 *    directory chain up to cwd. Appended to tool_result.
 *
 * 3. **@ mentions**: When user types @path references in their prompt,
 *    discovers agents files in the directory chain for those paths.
 *    Injected as a hidden message via before_agent_start.
 *
 * Deduplicates by realpath so symlinks (CLAUDE.local.md -> AGENTS.local.md)
 * don't cause double-loading. Each file loaded at most once per session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractAtMentions } from "../shared/at-mentions";
import { discoverAgentsFiles, discoverStartupLocalFiles, extractPath } from "./loader.js";

export default function agentsLoaderExtension(pi: ExtensionAPI) {
  let loadedRealpaths = new Set<string>();
  let cwd = "";
  let startupContext = "";
  let startupInjected = false;
  let pendingAtContext = "";

  function init(newCwd: string) {
    cwd = newCwd;
    loadedRealpaths = new Set();
    startupInjected = false;
    pendingAtContext = "";

    const localFiles = discoverStartupLocalFiles(cwd, loadedRealpaths);
    if (localFiles.length > 0) {
      startupContext = localFiles.map((f) => `<file name="${f.relativePath}">\n${f.content}\n</file>`).join("\n\n");
    } else {
      startupContext = "";
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    init(ctx.cwd);
    if (startupContext) {
      ctx.ui.notify("Loaded AGENTS.local.md", "info");
    }
  });

  // Discover agents files from @path mentions
  pi.on("input", async (event, ctx) => {
    if (!cwd) return { action: "continue" as const };

    const mentions = extractAtMentions(event.text);
    if (mentions.length === 0) return { action: "continue" as const };

    const parts: string[] = [];
    for (const mention of mentions) {
      const discovered = discoverAgentsFiles(mention, cwd, loadedRealpaths, true);
      const discoveredFile = discoverAgentsFiles(mention, cwd, loadedRealpaths, false);
      for (const f of [...discovered, ...discoveredFile]) {
        parts.push(`<file name="${f.relativePath}">\n${f.content}\n</file>`);
      }
    }

    if (parts.length > 0) {
      pendingAtContext = parts.join("\n\n");
      const names = parts.map((p) => p.match(/name="([^"]+)"/)?.[1]).filter(Boolean);
      ctx.ui.notify(`Loaded ${names.join(", ")}`, "info");
    }

    return { action: "continue" as const };
  });

  // Inject .local.md content and @-mention agents context
  pi.on("before_agent_start", async () => {
    const parts: string[] = [];

    if (!startupInjected && startupContext) {
      parts.push(startupContext);
    }
    startupInjected = true;

    if (pendingAtContext) {
      parts.push(pendingAtContext);
      pendingAtContext = "";
    }

    if (parts.length === 0) return;

    return {
      message: {
        customType: "agents-local",
        content: parts.join("\n\n"),
        display: false,
      },
    };
  });

  // Discover agents files in subdirectories on file access
  pi.on("tool_result", async (event, ctx) => {
    const extracted = extractPath(event.toolName, event.input as Record<string, unknown>);
    if (!extracted || !cwd) return;

    const discovered = discoverAgentsFiles(extracted.path, cwd, loadedRealpaths, extracted.isDirectory);
    if (discovered.length === 0) return;

    const names = discovered.map((f) => f.relativePath).join(", ");
    ctx.ui.notify(`Loaded ${names}`, "info");

    const injection = discovered.map((f) => `\n\n<file name="${f.relativePath}">\n${f.content}\n</file>`).join("");

    const existingText = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return {
      content: [{ type: "text" as const, text: existingText + injection }],
    };
  });
}
