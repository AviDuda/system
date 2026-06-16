import { describe, expect, test } from "bun:test";
import { formatHits } from "./format";
import type { SearchHit } from "./types";

describe("formatHits", () => {
  test("formats a hit with all fields", () => {
    const hits: SearchHit[] = [
      {
        title: "Example Page",
        url: "https://example.com",
        snippet: "This is a test page.",
        publishedDate: "2026-01-15",
      },
    ];
    const out = formatHits(hits);
    expect(out).toContain("[1] Example Page");
    expect(out).toContain("https://example.com");
    expect(out).toContain("This is a test page.");
    expect(out).toContain("Published: 2026-01-15");
  });

  test("formats a hit with only title and url", () => {
    const hits: SearchHit[] = [{ title: "Bare Page", url: "https://bare.com" }];
    const out = formatHits(hits);
    expect(out).toContain("[1] Bare Page");
    expect(out).toContain("https://bare.com");
    expect(out).not.toContain("Published:");
  });

  test("numbers multiple hits sequentially", () => {
    const hits: SearchHit[] = [
      { title: "First", url: "https://first.com" },
      { title: "Second", url: "https://second.com" },
      { title: "Third", url: "https://third.com" },
    ];
    const out = formatHits(hits);
    expect(out).toContain("[1] First");
    expect(out).toContain("[2] Second");
    expect(out).toContain("[3] Third");
  });

  test("appends related questions", () => {
    const hits: SearchHit[] = [{ title: "Page", url: "https://example.com" }];
    const out = formatHits(hits, ["What is X?", "How does Y work?"]);
    expect(out).toContain("Related questions:");
    expect(out).toContain("- What is X?");
    expect(out).toContain("- How does Y work?");
  });

  test("omits related questions section when list is empty", () => {
    const hits: SearchHit[] = [{ title: "Page", url: "https://example.com" }];
    expect(formatHits(hits, [])).not.toContain("Related questions:");
  });

  test("omits related questions section when undefined", () => {
    const hits: SearchHit[] = [{ title: "Page", url: "https://example.com" }];
    expect(formatHits(hits)).not.toContain("Related questions:");
  });

  test("returns no-results message for empty hits", () => {
    expect(formatHits([])).toBe("No results found.");
  });

  test("returns no-results message for empty hits even with related questions", () => {
    // No hits means nothing useful to show; related questions alone are noise.
    expect(formatHits([], ["What is X?"])).toBe("No results found.");
  });
});
