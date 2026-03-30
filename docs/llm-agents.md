# LLM Agent Design

Design philosophy for LLM coding agent setup. Reference for agents working on extensions, instructions, or journal infrastructure.

## Stack

**Pi** (vanilla) with custom extensions. Not a fork or batteries-included variant -- custom behavior is built as extensions on top of upstream pi. The goal is owning the customization layer while staying on a maintained base. Extensions are TypeScript, live-reloadable, and symlinked from `config/llm/pi/extensions/`.

Multiple agents share the same global instructions and journal system: pi, Claude Code, and OpenCode all read the same `instructions.md` and journal directory. Agent-specific behavior (pi extensions, CC hooks, OpenCode plugins) wraps the shared core.

## Knowledge Tiers

Knowledge is routed to the right durability level, not dumped in one place.

| Tier | What goes here | Where |
|------|---------------|-------|
| Human+LLM docs | Patterns, conventions, architecture decisions useful to both humans and agents | Project documentation, @-mentioned from AGENTS.md |
| LLM shared instructions | Agent workflow rules, project-specific behavioral constraints | AGENTS.md (committed) |
| LLM personal instructions | Private workflow context, local paths, personal preferences | AGENTS.local.md (gitignored) |
| Temporal context | Session history, work in progress, things still being figured out | Journal entries |

Agents suggest AGENTS.md changes but don't edit directly. Repeated patterns in journals are signals to promote knowledge to a durable tier.

**No auto-memory.** Automatic memory extraction (reading past sessions to build a durable memory file) was tried and rejected. It creates a silo outside the repo, duplicates what journals + AGENTS.md do better, and the quality of automatic extraction is poor. The journal system is the memory system -- agents write during work, future agents read at session start.

## Journal System

Journals live in `~/notes/llm/{project-name}/`, one file per topic per day. Agents see the 3 most recent entries at session start (injected by the journal extension). The rest are accessible via `read` if the agent knows the filename.

### Design principles

- **Agents write unprompted.** Instructions mandate journaling after each completed step. No human intervention needed.
- **Temporal, not archival.** Entries capture what happened and what was learned, not polished documentation. Voice and opinions are encouraged.
- **Cross-tool.** All agents (pi, CC, OpenCode) read and write the same journal directory. A pi session can continue work started in CC.
- **Handoff via journal.** Long tasks span multiple sessions. The agent journals progress, the next agent reads recent notes and continues. No special handoff mechanism needed -- the journal *is* the handoff.
- **Start fresh often.** Rather than compacting a long session, start a new one. The journal carries context forward. This avoids compaction lossiness and keeps sessions focused.

### What agents see at startup

1. Global instructions from `instructions.md`
2. `TODO.md` from the project's journal directory (if it exists) -- persistent, not subject to the recency window
3. Full content of the 3 most recent journal entries (recency window)
4. Filename listing of older entries (up to 30) and recent filenames from other projects (up to 5 each)
5. Project-specific AGENTS.md files (loaded by pi natively + agents-loader extension)

## Extensions

Custom pi extensions follow a pattern: augment the agent with context and guardrails, using cheap sidecar models where real-time analysis is needed.

**Context injection** -- agents-loader discovers AGENTS.md files from touched directories; journal extension injects notes and instructions; at-mentions inlines file contents on `@path` references.

**Guardrails** -- permission-gate intercepts tool calls with a confirmation dialog showing colored diffs, sidecar-generated verdicts (SAFE/RISKY/DANGEROUS), and session-allow rules with shell escalation detection.

**Augmentation** -- LSP extension runs diagnostics after every edit/write so the agent sees type errors immediately; draft-suggestion predicts the next user message as ghost text; web-search provides Kagi and Claude-based search.

**Sidecar pattern** -- cheap models (Haiku-class) run alongside the main conversation for tasks like classification, explanation generation, and draft prediction. They don't share conversation context -- they get focused, purpose-built prompts.

### What's intentionally absent

- **Sub-agents / plan mode.** Subagents lack session context and can't be steered. Plan mode prevents journaling and burns context on planning that should be captured in the journal. The journal is the plan.
- **Prompt history storage.** Less tracking preferred.
- **MCP integration.** CLI tools with READMEs (skills) cover the same ground without the protocol overhead. May be added later if needed for specific project work.
- **Autonomous features.** No auto-commit, auto-compact customization, or background processing. The human steers; the agent executes and journals.

## Nix Integration

Agent configuration is declarative. `modules/home-manager/pi.nix` symlinks extensions, `modules/home-manager/llm.nix` generates shared config (`journal.json`), and `modules/home-manager/llm-shared.nix` defines constants shared across all agents. Adding a new pi extension is just creating a directory with `index.ts` -- the Nix module auto-discovers it.

Runtime config (journal paths, model roles) is generated by Nix into `~/.config/llm/` so it's consistent across agents without manual setup.
