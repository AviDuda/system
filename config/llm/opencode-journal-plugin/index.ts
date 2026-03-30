import { basename } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
// This file is copied to ~/.config/opencode/plugins/ at deploy time.
// __HOME__ is substituted by Nix with the actual home directory path.
import {
	buildJournalContext,
	getRecentNotes,
	loadJournalConfig,
} from "__HOME__/system/config/llm/pi/extensions/shared/journal-context";

export const JournalPlugin: Plugin = async ({ directory }) => {
	const config = loadJournalConfig();
	const projectName = basename(directory);

	return {
		tool: {
			read_journal: tool({
				description:
					"Read recent journal notes for the current project. Call this at session start to get context from previous sessions.",
				args: {},
				async execute(_args, _ctx) {
					return buildJournalContext(config, directory);
				},
			}),
		},

		"experimental.chat.system.transform": async (_input, output) => {
			const context = await buildJournalContext(config, directory);
			output.system.push(`## Instructions & Session Notes\n\n${context}`);
		},

		"experimental.session.compacting": async (_input, output) => {
			if (process.env.LLM_VANILLA === "1") {
				return;
			}

			const result = await getRecentNotes(config.notesDir, projectName);

			output.context.push(`## Instructions\n\n${config.globalInstructions}`);
			output.context.push(`
## Journal System

IMPORTANT: Before this context is compacted, ensure any important learnings, decisions, or progress have been captured in journal notes.

Write session notes to: ${result.path}/
${config.noNotesReminder}

${config.compactionReminder}
`);

			if (result.notes.length > 0) {
				let notesContext = "\n## Recent Journal Notes\n\n";
				for (const note of result.notes) {
					notesContext += `### ${note.filename}\n${note.content}\n\n`;
				}
				output.context.push(notesContext);
			}
		},
	};
};
