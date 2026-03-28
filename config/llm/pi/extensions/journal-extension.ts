/**
 * Pi journal extension - mirrors Claude Code hooks behavior.
 *
 * Injects global instructions and journal notes at session start,
 * reminds to journal before compaction, and supports env var overrides:
 *   LLM_VANILLA=1 - skip all custom context
 *   NO_JOURNAL=1  - skip journal reading (fresh session)
 *
 * Placeholders (__X__) are substituted by Nix at build time.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const NOTES_DIR = "__NOTES_DIR__";
const NO_NOTES_REMINDER = `__NO_NOTES_REMINDER__`;
const JOURNAL_REMINDER = `__JOURNAL_REMINDER__`;
const _COMPACTION_REMINDER = `__COMPACTION_REMINDER__`;
const JOURNAL_SKIP_MESSAGE = `__JOURNAL_SKIP_MESSAGE__`;
const VANILLA_MESSAGE = `__VANILLA_MESSAGE__`;
const GLOBAL_INSTRUCTIONS = `__GLOBAL_INSTRUCTIONS__`;

interface NotesResult {
  exists: boolean;
  path: string;
  notes: Array<{ filename: string; content: string }>;
}

async function getRecentNotes(projectName: string): Promise<NotesResult> {
  const projectNotes = join(NOTES_DIR, projectName);

  if (!existsSync(projectNotes)) {
    await mkdir(projectNotes, { recursive: true });
    return { exists: false, path: projectNotes, notes: [] };
  }

  const files = await readdir(projectNotes);
  const mdFiles = files
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, 3);

  if (mdFiles.length === 0) {
    return { exists: true, path: projectNotes, notes: [] };
  }

  const notes = await Promise.all(
    mdFiles.map(async (filename) => {
      const content = await readFile(join(projectNotes, filename), "utf-8");
      return { filename, content };
    }),
  );

  return { exists: true, path: projectNotes, notes };
}

export default function journalExtension(pi: ExtensionAPI) {
  let cachedContext = "";
  let firstPrompt = true;

  // Build context on session start
  pi.on("session_start", async (_event, ctx) => {
    // Vanilla mode: skip everything custom
    if (process.env.LLM_VANILLA === "1") {
      cachedContext = VANILLA_MESSAGE;
      return;
    }

    // Start with global instructions
    let context = `${GLOBAL_INSTRUCTIONS}\n\n`;

    // Journal notes (skip if NO_JOURNAL=1)
    if (process.env.NO_JOURNAL === "1") {
      context += JOURNAL_SKIP_MESSAGE;
      cachedContext = context;
      return;
    }

    const projectName = basename(ctx.cwd);
    const result = await getRecentNotes(projectName);

    if (result.notes.length === 0) {
      context += `No previous session notes for ${projectName}.\n`;
      context += `Notes directory: ${result.path}/\n`;
      if (!result.exists) {
        context += "(Directory was just created)\n";
      }
      context += `\n${NO_NOTES_REMINDER}\n${JOURNAL_REMINDER}`;
    } else {
      context += `Previous session notes for ${projectName}:\n\n`;
      for (const note of result.notes) {
        context += `--- ${note.filename} ---\n${note.content}\n\n`;
      }
      context += JOURNAL_REMINDER;
    }

    cachedContext = context;
  });

  // Inject context on first prompt via system prompt modification
  pi.on("before_agent_start", async (_event) => {
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

  // Re-inject on session switch
  pi.on("session_switch", async (_event, ctx) => {
    firstPrompt = true;

    if (process.env.LLM_VANILLA === "1") {
      cachedContext = VANILLA_MESSAGE;
      return;
    }

    let context = `${GLOBAL_INSTRUCTIONS}\n\n`;

    if (process.env.NO_JOURNAL === "1") {
      context += JOURNAL_SKIP_MESSAGE;
      cachedContext = context;
      return;
    }

    const projectName = basename(ctx.cwd);
    const result = await getRecentNotes(projectName);

    if (result.notes.length === 0) {
      context += `No previous session notes for ${projectName}.\n`;
      context += `Notes directory: ${result.path}/\n`;
      context += `\n${NO_NOTES_REMINDER}\n${JOURNAL_REMINDER}`;
    } else {
      context += `Previous session notes for ${projectName}:\n\n`;
      for (const note of result.notes) {
        context += `--- ${note.filename} ---\n${note.content}\n\n`;
      }
      context += JOURNAL_REMINDER;
    }

    cachedContext = context;
  });

  // Pre-compact: remind to journal before context is lost
  pi.on("session_before_compact", async (_event, ctx) => {
    if (process.env.LLM_VANILLA === "1") return;

    const projectName = basename(ctx.cwd);
    const _projectNotes = join(NOTES_DIR, projectName);

    // Inject journal reminder into the compaction context
    // We can't modify the compaction directly here, but we can notify
    ctx.ui.notify("Context compacting - journal your progress!", "warning");

    return undefined;
  });
}
