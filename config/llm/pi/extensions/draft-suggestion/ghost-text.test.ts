import { describe, expect, test } from "bun:test";
import { filterSuggestion, injectGhostText, parseSuggestionTag } from "./ghost-text";

describe("injectGhostText", () => {
  // Simulate what Editor.render() produces for an empty editor (simplified)
  function makeEditorLines(width: number): string[] {
    const border = "─".repeat(width);
    // Cursor at position 0: padding + reverse-video space + reset + padding
    const padding = " ".repeat(1); // paddingX = 1
    const contentWidth = width - 2; // subtract left+right padding
    const cursor = "\x1b[7m \x1b[0m"; // reverse video space + reset
    const restPadding = " ".repeat(contentWidth - 1); // -1 for cursor
    const cursorLine = `${padding}${cursor}${restPadding}${padding}`;
    return [border, cursorLine, border];
  }

  test("injects dim text after cursor", () => {
    const lines = makeEditorLines(40);
    const result = injectGhostText(lines, "Run the tests");

    // The cursor line should contain dim escape codes
    expect(result[1]).toContain("\x1b[2m"); // dim on
    expect(result[1]).toContain("\x1b[22m"); // dim off
    expect(result[1]).toContain("Run the tests");
  });

  test("truncates long ghost text to fit", () => {
    const lines = makeEditorLines(20);
    const result = injectGhostText(lines, "This is a very long suggestion that should be truncated");

    expect(result[1]).toContain("...");
    expect(result[1]).toContain("\x1b[2m");
  });

  test("uses only first line of multi-line text", () => {
    const lines = makeEditorLines(40);
    const result = injectGhostText(lines, "First line\nSecond line\nThird line");

    expect(result[1]).toContain("First line");
    expect(result[1]).not.toContain("Second line");
  });

  test("returns unmodified lines when no cursor found", () => {
    const lines = ["───", "  no cursor here  ", "───"];
    const result = injectGhostText(lines, "suggestion");

    expect(result).toEqual(lines);
  });

  test("returns unmodified lines when no padding space", () => {
    // Cursor fills entire width - no room for ghost text
    const line = "\x1b[7m \x1b[0m";
    const lines = ["─", line, "─"];
    const result = injectGhostText(lines, "suggestion");

    // Should not crash, just return as-is
    expect(result[1]).toBe(line);
  });

  test("handles CURSOR_MARKER before cursor", () => {
    // CURSOR_MARKER is \x1b_pi:c\x07 (zero-width APC sequence)
    const marker = "\x1b_pi:c\x07";
    const padding = " ";
    const cursor = `${marker}\x1b[7m \x1b[0m`;
    const restPadding = " ".repeat(30);
    const line = `${padding}${cursor}${restPadding}${padding}`;
    const lines = ["─".repeat(33), line, "─".repeat(33)];

    const result = injectGhostText(lines, "Hello");
    expect(result[1]).toContain("\x1b[2mHello\x1b[22m");
  });
});

describe("parseSuggestionTag", () => {
  test("extracts text from suggestion tag", () => {
    expect(parseSuggestionTag("<suggestion>Run the tests</suggestion>")).toBe("Run the tests");
  });

  test("extracts text when model babbles around the tag", () => {
    const input =
      "Based on the context, here's my prediction:\n\n<suggestion>Add tests for the new feature</suggestion>\n\nThis seems likely because...";
    expect(parseSuggestionTag(input)).toBe("Add tests for the new feature");
  });

  test("returns empty string for empty tag", () => {
    expect(parseSuggestionTag("<suggestion></suggestion>")).toBe("");
  });

  test("trims whitespace inside tag", () => {
    expect(parseSuggestionTag("<suggestion>  Run tests  </suggestion>")).toBe("Run tests");
  });

  test("falls back to raw text when no tag found", () => {
    expect(parseSuggestionTag("Run the tests")).toBe("Run the tests");
  });

  test("uses first tag if multiple present", () => {
    const input = "<suggestion>First</suggestion>\n<suggestion>Second</suggestion>";
    expect(parseSuggestionTag(input)).toBe("First");
  });

  test("handles prefilled opening tag (response has no opening tag)", () => {
    const input = "Continue building the extension</suggestion>\n\nI can see you're building...";
    expect(parseSuggestionTag(input)).toBe("Continue building the extension");
  });

  test("handles prefilled opening tag with whitespace", () => {
    const input = "  Run the tests  </suggestion>";
    expect(parseSuggestionTag(input)).toBe("Run the tests");
  });
});

describe("filterSuggestion", () => {
  test("passes through normal suggestions", () => {
    expect(filterSuggestion("Run the tests")).toBe("Run the tests");
  });

  test("trims whitespace", () => {
    expect(filterSuggestion("  Run the tests  ")).toBe("Run the tests");
  });

  test("filters empty strings", () => {
    expect(filterSuggestion("")).toBeNull();
    expect(filterSuggestion("  ")).toBeNull();
  });

  test("filters very short strings", () => {
    expect(filterSuggestion("ok")).toBeNull();
    expect(filterSuggestion("hi")).toBeNull();
  });

  test("filters pleasantries", () => {
    expect(filterSuggestion("thanks")).toBeNull();
    expect(filterSuggestion("Thank you")).toBeNull();
    expect(filterSuggestion("great")).toBeNull();
    expect(filterSuggestion("nice")).toBeNull();
    expect(filterSuggestion("looks good")).toBeNull();
    expect(filterSuggestion("lgtm")).toBeNull();
    expect(filterSuggestion("Perfect.")).toBeNull();
    expect(filterSuggestion("AWESOME")).toBeNull();
  });

  test("filters assistant-speak", () => {
    expect(filterSuggestion("Would you like to explore more?")).toBeNull();
    expect(filterSuggestion("I can help with that")).toBeNull();
    expect(filterSuggestion("Let me check the logs")).toBeNull();
    expect(filterSuggestion("Here's what I found")).toBeNull();
    expect(filterSuggestion("Shall I continue?")).toBeNull();
    expect(filterSuggestion("Do you want me to fix it?")).toBeNull();
  });

  test("does not filter sentences containing pleasantries", () => {
    expect(filterSuggestion("Thanks, now run the tests")).toBe("Thanks, now run the tests");
    expect(filterSuggestion("Looks good, let's deploy")).toBe("Looks good, let's deploy");
  });
});
