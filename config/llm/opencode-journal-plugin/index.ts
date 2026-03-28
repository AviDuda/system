import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

interface JournalConfig {
	notesDir: string;
	noNotesReminder: string;
	journalReminder: string;
	compactionReminder: string;
	journalSkipMessage: string;
	vanillaMessage: string;
	globalInstructions: string;
}

function loadConfig(): JournalConfig {
	const configDir = process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config");
	const path = join(configDir, "llm", "journal.json");
	return JSON.parse(readFileSync(path, "utf-8")) as JournalConfig;
}

interface NotesResult {
	exists: boolean;
	path: string;
	notes: Array<{ filename: string; content: string }>;
}

async function getRecentNotes(notesDir: string, projectName: string): Promise<NotesResult> {
	const projectNotes = join(notesDir, projectName);

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

export const JournalPlugin: Plugin = async ({ directory }) => {
	const config = loadConfig();
	const projectName = basename(directory);

	return {
		tool: {
			read_journal: tool({
				description:
					"Read recent journal notes for the current project. Call this at session start to get context from previous sessions.",
				args: {},
				async execute(_args, _ctx) {
					const result = await getRecentNotes(config.notesDir, projectName);

					if (result.notes.length === 0) {
						return `No previous session notes for ${projectName}.
Notes directory: ${result.path}/
${result.exists ? "" : "(Directory was just created)"}

${config.noNotesReminder}`;
					}

					let output = `Previous session notes for ${projectName}:\n\n`;
					for (const note of result.notes) {
						output += `--- ${note.filename} ---\n${note.content}\n\n`;
					}
					return output;
				},
			}),
		},

		"experimental.chat.system.transform": async (_input, output) => {
			if (process.env.LLM_VANILLA === "1") {
				output.system.push(`## Mode\n\n${config.vanillaMessage}`);
				return;
			}

			output.system.push(`## Instructions\n\n${config.globalInstructions}`);

			if (process.env.NO_JOURNAL === "1") {
				output.system.push(`## Session Notes\n\n${config.journalSkipMessage}`);
				return;
			}

			const result = await getRecentNotes(config.notesDir, projectName);

			if (result.notes.length === 0) {
				output.system.push(`
## Session Notes

No previous session notes for ${projectName}.
Notes directory: ${result.path}/
${result.exists ? "" : "(Directory was just created)"}

${config.noNotesReminder}
${config.journalReminder}
`);
			} else {
				let notesContext = `## Previous Session Notes for ${projectName}\n\n`;
				for (const note of result.notes) {
					notesContext += `### ${note.filename}\n${note.content}\n\n`;
				}
				notesContext += config.journalReminder;
				output.system.push(notesContext);
			}
		},

		"experimental.session.compacting": async (_input, output) => {
			if (process.env.LLM_VANILLA === "1") {
				return;
			}

			output.context.push(`## Instructions\n\n${config.globalInstructions}`);

			const result = await getRecentNotes(config.notesDir, projectName);

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
