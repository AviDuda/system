import { describe, expect, test } from "bun:test";
import { formatResults, type KagiSearchResult } from "./kagi";

describe("formatResults", () => {
  test("formats sources with all fields", () => {
    const result: KagiSearchResult = {
      requestId: "abc",
      sources: [
        {
          title: "Example Page",
          url: "https://example.com",
          snippet: "This is a test page.",
          publishedDate: "2026-01-15",
        },
      ],
      relatedQuestions: [],
    };
    const out = formatResults(result);
    expect(out).toContain("[1] Example Page");
    expect(out).toContain("https://example.com");
    expect(out).toContain("This is a test page.");
    expect(out).toContain("Published: 2026-01-15");
  });

  test("formats sources without optional fields", () => {
    const result: KagiSearchResult = {
      requestId: "abc",
      sources: [{ title: "Bare Page", url: "https://bare.com" }],
      relatedQuestions: [],
    };
    const out = formatResults(result);
    expect(out).toContain("[1] Bare Page");
    expect(out).toContain("https://bare.com");
    expect(out).not.toContain("Published:");
  });

  test("formats multiple sources with numbering", () => {
    const result: KagiSearchResult = {
      requestId: "abc",
      sources: [
        { title: "First", url: "https://first.com" },
        { title: "Second", url: "https://second.com" },
        { title: "Third", url: "https://third.com" },
      ],
      relatedQuestions: [],
    };
    const out = formatResults(result);
    expect(out).toContain("[1] First");
    expect(out).toContain("[2] Second");
    expect(out).toContain("[3] Third");
  });

  test("includes related questions", () => {
    const result: KagiSearchResult = {
      requestId: "abc",
      sources: [{ title: "Page", url: "https://example.com" }],
      relatedQuestions: ["What is X?", "How does Y work?"],
    };
    const out = formatResults(result);
    expect(out).toContain("Related questions:");
    expect(out).toContain("- What is X?");
    expect(out).toContain("- How does Y work?");
  });

  test("returns message for empty results", () => {
    const result: KagiSearchResult = {
      requestId: "abc",
      sources: [],
      relatedQuestions: [],
    };
    expect(formatResults(result)).toBe("No results found.");
  });
});
