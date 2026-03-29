/**
 * Pure logic for the explain/verdict system.
 * No pi imports — testable independently.
 */

import type { ExplanationResult, ExplanationVerdict } from "./confirm-ui";

// ── Tool call description ──

/** Build a concise description of a tool call for the sidecar explainer. */
export function describeToolCall(toolName: string, input: Record<string, unknown>, rawDiff?: string): string {
  if (toolName === "bash") {
    return `bash command: ${input.command}`;
  }
  if (toolName === "write") {
    if (rawDiff) return `write to ${input.path}:\n${rawDiff}`;
    const content = typeof input.content === "string" ? input.content : "";
    return `write to ${input.path}:\n${content}`;
  }
  if (toolName === "edit") {
    if (rawDiff) return `edit ${input.path}:\n${rawDiff}`;
    if (input.edits && Array.isArray(input.edits)) {
      const edits = input.edits as Array<{ oldText?: string; newText?: string }>;
      const summary = edits
        .map((e, i) => {
          const old = typeof e.oldText === "string" ? e.oldText : "";
          const nw = typeof e.newText === "string" ? e.newText : "";
          return `edit ${i + 1}: "${old}" -> "${nw}"`;
        })
        .join("\n");
      return `edit ${input.path} (${edits.length} edits):\n${summary}`;
    }
    const old = typeof input.oldText === "string" ? input.oldText : "";
    const nw = typeof input.newText === "string" ? input.newText : "";
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
export function parseExplanation(text: string, strict: true): ExplanationResult | null;
export function parseExplanation(text: string, strict?: false): ExplanationResult;
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
export function blockReason(note: string, explanation: ExplanationResult | null, toolName?: string): string {
  const verb =
    toolName === "bash"
      ? "The command was NOT executed."
      : toolName === "edit"
        ? "The file was NOT modified."
        : toolName === "write"
          ? "The file was NOT written."
          : "The action was NOT performed.";
  const lines = [`BLOCKED by user. ${verb} Do not retry unless the user asks.`];
  if (explanation) {
    lines.push(`[Classification: ${explanation.verdict.toUpperCase()} — ${explanation.short}]`);
  }
  if (note) lines.push(`[User note: ${note}]`);
  return lines.join("\n");
}
