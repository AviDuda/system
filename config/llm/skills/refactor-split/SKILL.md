---
name: refactor-split
description: Split a large file into smaller modules. Use when a file exceeds ~500 lines or has mixed concerns that should be separated into domain-specific files.
---

# Refactor: Split Large File into Modules

Split a file that has grown too large or mixes concerns into focused, cohesive modules.

## Before Starting

1. Read the full file. Identify logical sections by scanning for:
   - Section comments or doc headers
   - Groups of related types/interfaces
   - Functions that share a domain (e.g., all rendering, all I/O, all protocol handling)
2. Check how other modules in the same project are already split — follow existing patterns
3. Propose the split plan to the user before making changes. Include:
   - File names and approximate line counts
   - Which functions/types go where
   - Dependencies between new files (imports)
   - Whether any new file is pure/testable

## Workflow

### 1. Extract sections into new files

Extract in any order. Use LSP for symbol-level moves when available, otherwise use text tools.

- **`sed -n 'START,ENDp' file >> newfile`** — extract a section into a new file
- **`edit`** — fix imports, add exports, adjust signatures

**Do NOT use `write`** for moving code between files. It loses context and makes review harder.

### 2. Fix exports and imports

Use `edit` to add `export` to public functions/types in the new files, and add corresponding `import` statements in the source file.

### 3. Delete extracted sections from source (end first)

After all extractions and imports are done, delete the old code from the source file.
**Delete from highest line numbers to lowest** so earlier references stay stable across deletions.

### 4. Iterate on diagnostics

After each extraction, run `lsp diagnostics` on the changed files. Fix type errors before proceeding to the next extraction. Common fixes:
- Missing imports (forgot to import a type from the new module)
- Unused imports (the old import is no longer needed after extraction)
- Type mismatches (a function now receives a different parameter type)

### 5. Format and test

- Run the project's formatter and linter
- Run the project's tests
- Fix any remaining warnings

## Rules

- **Never use `write` to create files containing extracted code.** `write` is for genuinely new content. For moving code, use LSP or sed to extract and `edit` to fix up.
- **Never use `any`.** If a type doesn't match, fix the types properly — narrower parameter types, proper casts with intermediate types, or adjusting the function signature.
- **Work from the end when deleting.** Delete extracted sections from highest line numbers to lowest so earlier references stay valid.
- **One section at a time.** Extract one logical section, fix all errors, then proceed to the next. Don't batch extractions and hope they work out.
- **Don't over-split.** If a function is long but forms one cohesive unit (e.g., a state machine, a single algorithm), leave it together. Splitting it would scatter related logic and make it harder to follow.

## Identifying Good Split Boundaries

Good candidates for extraction:
- **Pure utility functions** with no framework imports — these are also easy to test
- **Groups of related types** that define a domain (e.g., all config types together)
- **Rendering/formatting functions** that only depend on a theme or output type
- **Protocol/transport code** (IPC, RPC, HTTP) that's self-contained

Poor candidates for extraction:
- A single large function that's one coherent algorithm
- Code that has circular dependencies with the rest of the file (both sides call each other)
- Tiny helpers (3-5 lines) used once — not worth a separate file

## Adding Tests

After splitting, the newly pure modules should get tests. Test the most isolated module first (the one with the fewest dependencies). Use the project's existing test patterns — check nearby test files for conventions.
