/**
 * Pure logic for the explain/verdict system.
 * No pi imports — testable independently.
 */

import type { ExplanationResult, ExplanationVerdict } from "./confirm-ui";

// ── Tool call description ──

/** Build a concise description of a tool call for the sidecar explainer. */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash") {
    return `bash command: ${input.command}`;
  }
  if (toolName === "write") {
    const content = input.content;
    const truncated = typeof content === "string" && content.length > 500 ? `${content.slice(0, 500)}...` : content;
    return `write to ${input.path}:\n${truncated}`;
  }
  if (toolName === "edit") {
    if (input.edits && Array.isArray(input.edits)) {
      const edits = input.edits as Array<{ oldText?: string; newText?: string }>;
      const summary = edits
        .map((e, i) => {
          const old = typeof e.oldText === "string" ? e.oldText.slice(0, 200) : "";
          const nw = typeof e.newText === "string" ? e.newText.slice(0, 200) : "";
          return `edit ${i + 1}: "${old}" -> "${nw}"`;
        })
        .join("\n");
      return `edit ${input.path} (${edits.length} edits):\n${summary}`;
    }
    const old = typeof input.oldText === "string" ? input.oldText.slice(0, 200) : "";
    const nw = typeof input.newText === "string" ? input.newText.slice(0, 200) : "";
    return `edit ${input.path}: "${old}" -> "${nw}"`;
  }
  return `${toolName}: ${JSON.stringify(input).slice(0, 500)}`;
}

// ── Verdict parsing ──

/** Parse a verdict word from the start of text. */
export function parseVerdict(text: string): ExplanationVerdict | null {
  const upper = text.toUpperCase();
  if (upper.startsWith("DANGEROUS")) return "dangerous";
  if (upper.startsWith("RISKY")) return "risky";
  if (upper.startsWith("SAFE")) return "safe";
  return null;
}

/** Strip a leading verdict word and delimiter from text. */
export function stripVerdictPrefix(text: string): string {
  return text.replace(/^(SAFE|RISKY|DANGEROUS)\s*[|:\-–]\s*/i, "").trim();
}

/**
 * Parse a sidecar response into verdict + short + detail.
 * Returns null if no verdict could be parsed and strict mode is on.
 * Strict mode is used for auto-classify where parse failure should
 * fall through to the confirmation dialog, not auto-allow.
 */
export function parseExplanation(text: string, strict?: boolean): ExplanationResult | null {
  const trimmed = text.trim();
  const firstNewline = trimmed.indexOf("\n");
  const firstLine = firstNewline === -1 ? trimmed : trimmed.slice(0, firstNewline);
  const detail = firstNewline === -1 ? "" : trimmed.slice(firstNewline + 1).trim();

  const verdict = parseVerdict(firstLine);
  if (!verdict && strict) return null;

  const short = stripVerdictPrefix(firstLine) || firstLine;

  return { verdict: verdict ?? "safe", short, detail };
}

// ── Block reason ──

/** Build a block reason from user note + sidecar explanation. */
export function blockReason(note: string, explanation: ExplanationResult | null, fallback: string): string {
  const parts: string[] = [];
  if (note) parts.push(`[User note: ${note}]`);
  if (explanation) {
    const verdict = explanation.verdict.toUpperCase();
    parts.push(`[Auto-classification: ${verdict} — ${explanation.short}]`);
  }
  return parts.length > 0 ? parts.join("\n") : fallback;
}
