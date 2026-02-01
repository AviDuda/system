import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const NOTES_DIR = "__NOTES_DIR__";
const NO_NOTES_REMINDER = `__NO_NOTES_REMINDER__`;
const JOURNAL_REMINDER = `__JOURNAL_REMINDER__`;
const COMPACTION_REMINDER = `__COMPACTION_REMINDER__`;
const JOURNAL_SKIP_MESSAGE = `__JOURNAL_SKIP_MESSAGE__`;

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

export const JournalPlugin: Plugin = async ({ directory }) => {
	const projectName = basename(directory);

	return {
		tool: {
			read_journal: tool({
				description:
					"Read recent journal notes for the current project. Call this at session start to get context from previous sessions.",
				args: {},
				async execute(_args, _ctx) {
					const result = await getRecentNotes(projectName);

					if (result.notes.length === 0) {
						return `No previous session notes for ${projectName}.
Notes directory: ${result.path}/
${result.exists ? "" : "(Directory was just created)"}

${NO_NOTES_REMINDER}`;
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
			// Allow skipping journal reading with NO_JOURNAL=1
			if (process.env.NO_JOURNAL === "1") {
				output.system.push(`## Session Notes\n\n${JOURNAL_SKIP_MESSAGE}`);
				return;
			}

			const result = await getRecentNotes(projectName);

			if (result.notes.length === 0) {
				output.system.push(`
## Session Notes

No previous session notes for ${projectName}.
Notes directory: ${result.path}/
${result.exists ? "" : "(Directory was just created)"}

${NO_NOTES_REMINDER}
${JOURNAL_REMINDER}
`);
			} else {
				let notesContext = `## Previous Session Notes for ${projectName}\n\n`;
				for (const note of result.notes) {
					notesContext += `### ${note.filename}\n${note.content}\n\n`;
				}
				notesContext += JOURNAL_REMINDER;
				output.system.push(notesContext);
			}
		},

		"experimental.session.compacting": async (_input, output) => {
			const result = await getRecentNotes(projectName);

			output.context.push(`
## Journal System

IMPORTANT: Before this context is compacted, ensure any important learnings, decisions, or progress have been captured in journal notes.

Write session notes to: ${result.path}/
${NO_NOTES_REMINDER}

${COMPACTION_REMINDER}
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
