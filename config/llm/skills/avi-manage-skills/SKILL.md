---
name: avi-manage-skills
description: Create or edit agent skills in config/llm/skills/. Triggers when user wants to "create a skill", "add a skill", "make a new skill", "edit [name] skill", "update [name]", "change the [name] skill", "write a skill", or needs guidance on skill structure, description writing, progressive disclosure, or skill design. Follows the Agent Skills standard (compatible with Claude Code, Codex, pi).
---

# Avi Manage Skills

Create and edit skills for config/llm/skills/. Each skill is a directory with SKILL.md following the Agent Skills specification.

## Workflow

### Create Mode

1. **Gather requirements** — ask:
   - What task does this skill cover?
   - What specific use cases should it handle?
   - Does it need executable scripts, or just instructions?
   - Any reference materials to include?

2. **Create directory**: `mkdir -p config/llm/skills/{name}/{references,scripts}` (only create subdirs that are needed)

3. **Draft SKILL.md** with:
   - YAML frontmatter (name + description)
   - Imperative body text (verb-first instructions)
   - Keep under 500 lines in SKILL.md itself

4. **Review with user** — present the draft, ask what's missing or unclear

### Edit Mode

1. Read the existing SKILL.md and any referenced files
2. Make changes per user request
3. Preserve existing structure (references/, scripts/) unless restructuring is needed

## Frontmatter

Per Agent Skills specification:

```yaml
---
name: skill-name
description: What it does + when to trigger. Third person, specific triggers.
allowed-tools:
  - Read
  - AskUserQuestion
  - Bash
---
```

- **name**: lowercase, hyphens for spaces, max 64 chars
- **description**: max 1024 chars. First sentence = what it does. Second sentence = "Use when [specific triggers]." Third person only. See @references/description-guide.md
- **allowed-tools** (optional): whitelist pre-approved tools. Only include tools the skill actually needs.

## Body Writing Style

- **Imperative/infinitive form**: "Start by reading...", "Validate input before processing..." — not "You should read..." or "You need to validate..."
- **Assume Claude is smart**: Don't explain basics. Add context Claude doesn't already have.
- **Concise**: Each piece of information must justify its token cost.
- **Consistent terminology**: Pick one term and use it throughout.

## File Organization

```
skill-name/
├── SKILL.md           # Core instructions (always loaded when skill triggers)
├── references/        # Detailed docs (loaded on-demand)
│   └── detailed-guide.md
└── scripts/           # Utility scripts (executed, not loaded into context)
    └── helper.sh
```

**When to split:**
- SKILL.md exceeds ~500 lines → split into references/
- Content has distinct domains → separate reference files per domain
- Advanced features are rarely needed → move to references/

**When to add scripts:**
- Deterministic operations (validation, formatting)
- Same code would be generated repeatedly
- Errors need explicit handling

Scripts save tokens and improve reliability vs. generated code.

## Description Writing

The description is the only thing the agent sees when deciding which skill to load. It must give enough info for correct selection.

**Structure**: First sentence = capability. Second sentence = "Use when [triggers]."

**Good**:
```
Analyzes Excel spreadsheets, creates pivot tables, generates charts. Use when analyzing Excel files, spreadsheets, tabular data, or .xlsx files.
```

**Bad**:
```
Helps with documents.
```

The bad example gives the agent no way to distinguish this from other skills. See @references/description-guide.md for detailed guidance and examples.

## Examples

Check existing skills in this directory for patterns: knowledge-reference skills (dioxus-guidelines), workflow skills (refactor-split), configuration skills (rust-lint-config). Use them as references when drafting new skills.
