/**
 * Edit-tool diff preview for the permission gate's confirm dialog.
 * Matching: ./edit-match (vendored from pi's unexported edit-diff internals).
 * Rendering: pi's public generateDiffString.
 */

import { access, constants, readFile } from "node:fs/promises";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { applyEditsToNormalizedContent, type EditOp, normalizeToLF, resolveEditPath } from "./edit-match";

export interface EditPreview {
  /** Display diff (+/- lines with line numbers, upstream format). */
  diff: string;
  /** First changed line (1-based, new file) — same source as patch previews use. */
  firstChangedLine?: number;
}

export type EditPreviewResult = EditPreview | { error: string };

/**
 * Compute what a built-in edit call would change, without writing. Returns
 * {error} exactly when pi's own preview would refuse: file unreadable or an
 * edit-rejection condition in ./edit-match. The gate treats that as
 * "no styled diff" and confirms with details instead.
 */
export async function computeEditPreview(
  path: string,
  edits: Array<{ oldText?: string; newText?: string }>,
  cwd: string,
): Promise<EditPreviewResult> {
  if (!path) return { error: "edit: no path given" };
  const normalizedEdits: EditOp[] = edits.map((e) => ({ oldText: e.oldText ?? "", newText: e.newText ?? "" }));
  const absolutePath = resolveEditPath(path, cwd);
  try {
    try {
      await access(absolutePath, constants.R_OK);
    } catch (err) {
      const code = err instanceof Error && "code" in err ? err.code : String(err);
      return { error: `Could not edit file: ${path}. Error code: ${code}.` };
    }
    const rawContent = await readFile(absolutePath, "utf-8");
    // Strip BOM before matching (LLM won't include invisible BOM in oldText)
    const content = rawContent.startsWith("\uFEFF") ? rawContent.slice(1) : rawContent;
    const { baseContent, newContent } = applyEditsToNormalizedContent(normalizeToLF(content), normalizedEdits, path);
    return generateDiffString(baseContent, newContent);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
