/**
 * Shared helpers for file-mutating tools.
 *
 * Several extensions react to edit/write tool calls (LSP diagnostics, permission
 * gating, agents-file discovery). They previously each kept their own copy of
 * "which tools mutate files" and "how to extract paths from a patch multi-file
 * call" — which is how `patch` initially slipped through unwired. Centralizing
 * both here means adding a new edit-like tool is one edit to `EDIT_LIKE_TOOLS`,
 * not a grep-and-fix across every consumer.
 *
 * This module does pure path EXTRACTION only — no normalization policy. A
 * leading `@`, `~` expansion, Unicode-space folding, etc. are resolution
 * concerns that belong in each consumer's resolver (pi's `resolveToCwd` strips
 * a leading `@`; permission-gate's `resolveFilePath` does the same). Baking
 * that here would silently propagate a debatable choice to every consumer at
 * once: `@` is a valid path character, and a path argument that starts with
 * `@` is sometimes legitimate (e.g. a scoped package dir like
 * `@types/node/index.d.ts` when cwd is its parent, or a leading-`@` file).
 *
 * Note: pi's own `isEditToolResult`/`isWriteToolResult` are name-based guards
 * we can't extend from here, so call sites replace them with
 * `EDIT_LIKE_TOOLS.includes(toolName)`.
 */

/** Tools that mutate files on disk. Consumers gate post-edit behavior
 * (diagnostics, permission confirmation, context refresh) on this set. */
export const EDIT_LIKE_TOOLS = ["write", "edit", "patch"];

/**
 * Collect raw target paths from a path-bearing tool call. `patch` may carry a
 * per-edit `path` that overrides the top-level path (multi-file); other tools
 * expose a single top-level `path`. Returns paths verbatim — callers resolve
 * to absolute via their own cwd/normalization semantics.
 *
 * Returns [] for tools without a path, so it's safe to call on any toolName.
 */
export function collectToolPaths(toolName: string, input: Record<string, unknown>): string[] {
  let raw: string[];
  if (toolName === "patch" && Array.isArray(input.edits)) {
    const top = typeof input.path === "string" ? input.path : null;
    raw = [];
    for (const edit of input.edits) {
      const p = (edit as { path?: string } | null)?.path ?? top;
      if (p) raw.push(p);
    }
  } else {
    raw = typeof input.path === "string" ? [input.path] : [];
  }
  // Dedupe (preserve first-seen order). A patch call with several edits all
  // targeting the top-level path otherwise yields one entry per edit, causing
  // consumers (LSP diagnostics, permission checks) to repeat work per duplicate.
  return [...new Set(raw)];
}
