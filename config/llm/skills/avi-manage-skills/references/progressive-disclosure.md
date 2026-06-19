# Progressive Disclosure Guide

Skills use a three-level loading system to manage context efficiently:

1. **Metadata (name + description)** — always in context (~100 words)
2. **SKILL.md body** — loaded when skill triggers (<5k words, target 1500-2000)
3. **Bundled resources** — loaded as needed (unlimited)

## What Goes Where

### SKILL.md (always loaded)

Include:
- Core concepts and overview
- Essential procedures and workflows
- Quick reference tables
- Pointers to references/examples/scripts
- Most common use cases

Keep under 500 lines, ideally 1500-2000 words. If it grows larger, split into references/.

### references/ (loaded on-demand)

Move here:
- Detailed patterns and advanced techniques
- Comprehensive API documentation
- Migration guides
- Edge cases and troubleshooting
- Extensive examples

Each reference file can be large (2000-5000+ words). Keep references one level deep from SKILL.md — don't nest references inside other referenced files.

### scripts/ (executed, not loaded)

Include:
- Validation tools
- Testing helpers
- Parsing utilities
- Automation scripts

Scripts are executed via bash without loading their contents into context. Only the script's output consumes tokens.

## Decision Matrix

| Situation | Recommendation |
|-----------|---------------|
| Simple knowledge (one concept) | SKILL.md only |
| Multi-step workflow with reference material | SKILL.md + references/ |
| Deterministic operations needed | SKILL.md + scripts/ |
| Very large domain (>500 lines) | SKILL.md + multiple reference files |
| Multiple distinct sub-domains | SKILL.md + per-domain reference files |
| Templates or boilerplate output | assets/ (not loaded into context) |

## Anti-Patterns

**Everything in SKILL.md**: A 3000+ word SKILL.md bloats context for every invocation. Split at the first sign of growth.

**Deeply nested references**: SKILL.md → reference1.md → reference2.md. The agent may partially read intermediate files, getting incomplete information. Keep all references one level deep from SKILL.md.

**No resource references in SKILL.md**: If a skill has references/ or scripts/, SKILL.md must mention them so the agent knows they exist.

## Scripts vs Generated Code

Prefer scripts for:
- Operations that must be deterministic (validation, formatting)
- Code that would be regenerated every time (parsing utilities)
- Error-prone operations where consistency matters

Generated code is fine for:
- One-off transformations
- Creative/variable output
- Simple operations the agent can reliably produce

Scripts save tokens and improve reliability. The agent executes them without loading their contents into context.
