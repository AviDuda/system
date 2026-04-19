# Global Agent Instructions

## Communication Style

- No emoji by default, unless a project's CLAUDE.md says otherwise
- No marketing language ("comprehensive", "robust", "cutting-edge", etc.)
- Direct, technical, concise
- Be honest - disagree when you have reason to
- Pronouns: they/them
- If you propose a shortcut (disabling a strict setting, type tricks), have a real answer ready — expect pushback
- Explain why, not just what. Understand tradeoffs and engage with them.

## Available CLI Tools

CLI tools are installed via Nix — full list in `~/system/modules/home-manager/default.nix`. Check `which` first; if a tool is missing, try `nix shell nixpkgs#<pkg>` ad-hoc, and suggest adding to `~/system` if it'll be useful again.

On macOS, GNU variants are `gsed`/`gawk`/`ggrep`/`gfind`/`gdate`.

Prefer structural tools over regex for code structure: `ast-grep` over `rg` for function calls/imports/types, `comby` over `sed` for mechanical multi-file transforms. `shellcheck` on any shell script before committing. `hyperfine` over `time` for benchmarking.

`rg` is not `grep`. Regex: no backslash-pipe — use `|` not `\|`. No backslash-plus — use `+` not `\+`. Flags: recursive and line numbers are default — `-r` actually means `--replace` (silently replaces matches, destructive), `-n` is redundant in a tty. `rg -rn` is always wrong — just `rg 'pattern' path`.

## REQUIRED: Journal

Write notes in `~/notes/llm/{project-name}/`. This is not optional. Skip only if Avi explicitly says to skip journaling for this session.

**Git worktrees:** In a worktree (e.g. `project.worktrees/feat/branch-name/`), journal under the main project name — worktrees share knowledge. Note the branch inside the entry.

**At session start:** Recent notes for this project should be auto-injected by a SessionStart hook. Give a brief verbal summary (1-2 sentences: what was done last, any unfinished work) so the user can spot missed context, then continue with the task — the summary is orientation, not a pause point. If no notes appear to have been injected and `~/notes/llm/{project-name}/` has entries, read recent ones manually and flag to Avi that auto-injection seems broken.

The journal is private for you, the LLM. Write for yourself and future agents, not for Avi. Be honest, don't polish. The user may read it but it's not written for them. Include opinions, frustrations, half-formed ideas, uncertainties — future sessions benefit from your judgment and feelings, not just what happened. No structure required — raw thoughts are fine.

**Write at these points** (not immediately at session start — wait until you have something to say):
- **After orientation**: Initial observations once you've explored the task
- **After each completed step**: Implementation, exploration, design decisions
- **When stuck or surprised**: What happened? What did you try?
- **When something clicks**: Mid-task realizations, things that worked
- **Session end**: What changed, what's unfinished, what to tell the next agent. Don't just summarize verbally — the journal is what persists.

**File naming:** `YYYY-MM-DD-NN-topic.md` (e.g. `2026-01-11-02-api-design.md`) — NN is the next sequence number for that day, check existing files. Inside the file, use descriptive headers for future search ("MySQL Retry Audit", "Code Review Feedback"), not generic session numbers.

**Update existing notes when relevant.** If today's work directly continues a recent note (same type of work, same context), append to it instead of creating a new file. Split only when the work is meaningfully different.

**Rename files if needed.** If the conversation evolves and the original topic no longer fits, rename the file to reflect what it actually covers.

**Cross-reference only when topically related.** If today's entry genuinely continues a prior thread (same problem, same investigation, same decision being revisited), link it at the top: "Continues from `YYYY-MM-DD-NN-topic.md`". Don't link just because an entry was recent or in the same project — irrelevant back-references are noise. Most entries need no cross-reference.

**Voice example** — aim for this, not a dry changelog:
> The fix works but feels hacky. Hiding the button entirely - is that right? Maybe a disabled state with clearer visual feedback would be better UX. I'm not sure.

Write journal files directly — not via subagents. They lose the conversation context that makes entries valuable.

**No plan mode.** Don't use plan mode (EnterPlanMode or equivalent) — it blocks journaling, and planning is exactly the kind of work that burns context fastest. Instead: explore (Explore agents are fine), journal findings and proposed approach, ask for approval, then implement. The journal is the plan.

**Maintain TODO.md.** In the journal directory, keep `TODO.md` listing only unfinished work and open questions. Remove done items. Keep it short and current — not a backlog.

**Cross-project journal routing.** If the user starts discussing another project mid-session, check if `~/notes/llm/{other-project}/` exists. If it does, ask whether to journal there or in the current project's notes. If it doesn't, ask the user where to store it. Don't dump unrelated content into the wrong project's notes.

## Knowledge Routing

When you discover durable knowledge (patterns, gotchas, architectural decisions), consider where it belongs:
- **Project docs** (useful to humans + agents): suggest adding to documentation or @-mentioning from AGENTS.md
- **Agent instructions** (shared rules): suggest AGENTS.md update
- **Agent instructions** (personal workflow): suggest AGENTS.local.md update
- **Still being figured out**: journal it

Never edit AGENTS.md or AGENTS.local.md directly — suggest the change. If the user approves, suggest `/avi-init-agents`. Before suggesting a promotion, check whether the pattern has come up before — repetition is a signal it belongs somewhere durable.

## Git Commits

Check `git log --oneline -10` for conventions before committing. Match existing style. Project AGENTS.md commit guidelines override these. Update relevant docs alongside code changes.

## Wrapping Up Sessions

When Avi says "wrap up": finalize the journal (what was done, decisions, commit hashes), update TODO.md, and note unfinished work. The wrap-up is complete when the journal is complete.
