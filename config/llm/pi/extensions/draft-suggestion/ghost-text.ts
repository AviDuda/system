/**
 * Ghost text rendering logic - pure functions, no pi imports.
 *
 * Injects greyed-out suggestion text into the Editor's rendered ANSI output.
 * The Editor renders a cursor as \x1b[7m<char>\x1b[0m (reverse video + reset).
 * Ghost text is inserted after the cursor reset, replacing padding spaces.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/**
 * Inject ghost text into rendered editor lines.
 * Only works when the editor is empty (ghost text appears after cursor).
 *
 * @param lines - Rendered lines from Editor.render()
 * @param ghostText - The suggestion text to show
 * @returns Modified lines array (mutated in place)
 */
export function injectGhostText(lines: string[], ghostText: string): string[] {
  // Find the cursor line (has \x1b[7m which is reverse video for the cursor)
  const cursorLineIdx = lines.findIndex((l) => l.includes("\x1b[7m"));
  if (cursorLineIdx === -1) return lines;

  const line = lines[cursorLineIdx];
  if (!line) return lines;

  // Find cursor: \x1b[7m<char>\x1b[0m (reverse video char + reset)
  const reverseStart = line.indexOf("\x1b[7m");
  if (reverseStart === -1) return lines;

  const resetAfterCursor = line.indexOf("\x1b[0m", reverseStart);
  if (resetAfterCursor === -1) return lines;

  const afterReset = resetAfterCursor + "\x1b[0m".length;
  const beforeGhost = line.slice(0, afterReset);
  const afterGhost = line.slice(afterReset);

  // Calculate available space (afterGhost is padding spaces)
  const paddingWidth = visibleWidth(afterGhost);
  if (paddingWidth <= 0) return lines;

  // Render ghost text: dim color, truncated to fit
  const firstLine = ghostText.split("\n")[0] || "";
  const truncated = truncateToWidth(firstLine, paddingWidth, "...");
  const ghostWidth = visibleWidth(truncated);
  const ghost = `\x1b[2m${truncated}\x1b[22m`; // dim on/off

  // Remaining padding after ghost text
  const remainingPadding = " ".repeat(Math.max(0, paddingWidth - ghostWidth));

  lines[cursorLineIdx] = beforeGhost + ghost + remainingPadding;

  return lines;
}

/**
 * Extract text from a <suggestion>...</suggestion> tag.
 * Returns the raw text if no tag is found (fallback).
 */
export function parseSuggestionTag(text: string): string {
  // Full tag: <suggestion>...</suggestion>
  const fullMatch = text.match(/<suggestion>([\s\S]*?)<\/suggestion>/);
  if (fullMatch) return fullMatch[1]?.trim() ?? "";
  // Prefilled opening: response starts with content then </suggestion>
  // (when assistant prefill already contains <suggestion>)
  const prefillMatch = text.match(/^([\s\S]*?)<\/suggestion>/);
  if (prefillMatch) return prefillMatch[1]?.trim() ?? "";
  // No tag found - return raw text as fallback
  return text;
}

/**
 * Filter out unhelpful suggestions.
 * Returns null if the suggestion should be discarded.
 */
export function filterSuggestion(text: string): string | null {
  const trimmed = text.trim();

  // Skip empty or very short predictions
  if (!trimmed || trimmed.length < 3) return null;

  // Skip pleasantries
  if (/^(thanks|thank you|ok|okay|great|nice|cool|good|perfect|awesome|looks good|lgtm)\.?$/i.test(trimmed)) {
    return null;
  }

  // Skip assistant-speak (these are what assistants say, not humans)
  if (
    /^(would you like|i can help|let me|here'?s what|i found|i see that|i notice|shall i|do you want me to)/i.test(
      trimmed,
    )
  ) {
    return null;
  }

  return trimmed;
}
