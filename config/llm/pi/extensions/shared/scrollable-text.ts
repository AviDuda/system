/**
 * Scrollable text component for pi TUI.
 *
 * Renders a block of pre-styled text lines with vertical scrolling.
 * Arrow keys scroll up/down, page-up/page-down jump by viewport height.
 * Shows scroll indicators when content overflows.
 *
 * Usage:
 *   const scroll = new ScrollableText(styledLines, maxHeight, theme);
 *   // In handleInput: if (scroll.handleInput(data)) { tui.requestRender(); }
 *   // In render: scroll.render(width) returns string[]
 */

import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

export interface ScrollableTextTheme {
  scrollHint: (text: string) => string;
  border: (text: string) => string;
}

export class ScrollableText {
  private lines: string[];
  private maxHeight: number;
  private theme: ScrollableTextTheme;
  private scrollOffset = 0;
  private cachedWidth?: number;
  private cachedOutput?: string[];
  /** Total visual lines from last render (after wrapping). */
  private lastWrappedTotal = 0;

  constructor(lines: string[], maxHeight: number, theme: ScrollableTextTheme) {
    this.lines = lines;
    this.maxHeight = maxHeight;
    this.theme = theme;
  }

  setLines(lines: string[]) {
    this.lines = lines;
    this.scrollOffset = 0;
    this.invalidate();
  }

  setMaxHeight(maxHeight: number) {
    this.maxHeight = maxHeight;
    this.invalidate();
  }

  setScrollOffset(offset: number) {
    this.scrollOffset = Math.max(0, offset);
    this.invalidate();
  }

  /** Handle keyboard input. Returns true if the event was consumed (scroll happened). */
  handleInput(data: string): boolean {
    const total = this.lastWrappedTotal || this.lines.length;
    const needsScroll = total > this.maxHeight;
    const viewportHeight = Math.max(1, needsScroll ? this.maxHeight - 1 : this.maxHeight);
    const maxOffset = Math.max(0, total - viewportHeight);

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (this.scrollOffset > 0) {
        this.scrollOffset--;
        this.invalidate();
        return true;
      }
      return false;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      if (this.scrollOffset < maxOffset) {
        this.scrollOffset++;
        this.invalidate();
        return true;
      }
      return false;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
      if (this.scrollOffset > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
        this.invalidate();
        return true;
      }
      return false;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
      if (this.scrollOffset < maxOffset) {
        this.scrollOffset = Math.min(maxOffset, this.scrollOffset + viewportHeight);
        this.invalidate();
        return true;
      }
      return false;
    }
    if (matchesKey(data, "home") || matchesKey(data, "shift+left")) {
      if (this.scrollOffset > 0) {
        this.scrollOffset = 0;
        this.invalidate();
        return true;
      }
      return false;
    }
    if (matchesKey(data, "end") || matchesKey(data, "shift+right")) {
      if (this.scrollOffset < maxOffset) {
        this.scrollOffset = maxOffset;
        this.invalidate();
        return true;
      }
      return false;
    }
    return false;
  }

  render(width: number): string[] {
    if (this.cachedOutput && this.cachedWidth === width) {
      return this.cachedOutput;
    }

    // Wrap each source line to produce visual lines, tracking which visual
    // lines belong to which source line so scroll offsets stay meaningful.
    const wrappedLines: string[] = [];
    for (const line of this.lines) {
      const wrapped = wrapTextWithAnsi(line, width);
      if (wrapped.length === 0) {
        wrappedLines.push("");
      } else {
        for (const wl of wrapped) wrappedLines.push(wl);
      }
    }

    const totalLines = wrappedLines.length;
    const needsScroll = totalLines > this.maxHeight;
    const viewportHeight = needsScroll ? Math.max(1, this.maxHeight - 1) : this.maxHeight;

    // Clamp scroll offset
    const maxOffset = Math.max(0, totalLines - viewportHeight);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const visibleLines = wrappedLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
    const output = visibleLines.map((line) => truncateToWidth(line, width));

    if (needsScroll) {
      const above = this.scrollOffset;
      const below = totalLines - this.scrollOffset - viewportHeight;
      const parts: string[] = [];
      if (above > 0) parts.push(`${above} above`);
      if (below > 0) parts.push(`${below} below`);
      output.push(truncateToWidth(this.theme.scrollHint(`[${parts.join(", ")}]`), width));
    }

    this.lastWrappedTotal = totalLines;
    this.cachedWidth = width;
    this.cachedOutput = output;
    return output;
  }

  invalidate() {
    this.cachedWidth = undefined;
    this.cachedOutput = undefined;
  }

  /** Whether content overflows the viewport (based on last render's wrapping). */
  get scrollable(): boolean {
    const total = this.lastWrappedTotal || this.lines.length;
    return total > this.maxHeight;
  }

  get totalLines(): number {
    return this.lines.length;
  }
}
