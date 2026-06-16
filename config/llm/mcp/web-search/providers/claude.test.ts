import { describe, expect, test } from "bun:test";
import { formatClaudeResults, parseMarkdownLinks } from "./claude";

describe("parseMarkdownLinks", () => {
  test("parses standard markdown links", () => {
    const text = `[Nix Flakes](https://nixos.wiki/wiki/Flakes)
[Discourse Post](https://discourse.nixos.org/t/flake-follows/123)`;
    const sources = parseMarkdownLinks(text);
    expect(sources).toHaveLength(2);
    expect(sources[0].title).toBe("Nix Flakes");
    expect(sources[0].url).toBe("https://nixos.wiki/wiki/Flakes");
    expect(sources[1].title).toBe("Discourse Post");
  });

  test("deduplicates by URL", () => {
    const text = `[Page A](https://example.com)
[Page A Again](https://example.com)
[Page B](https://other.com)`;
    const sources = parseMarkdownLinks(text);
    expect(sources).toHaveLength(2);
  });

  test("handles links with numbering and extra text", () => {
    const text = `1. [First Result](https://first.com) - some description
2. [Second Result](https://second.com)`;
    const sources = parseMarkdownLinks(text);
    expect(sources).toHaveLength(2);
    expect(sources[0].url).toBe("https://first.com");
  });

  test("returns empty for no links", () => {
    expect(parseMarkdownLinks("no links here")).toHaveLength(0);
  });

  test("ignores non-http links", () => {
    const text = `[Local](file:///tmp/foo)
[Web](https://example.com)`;
    const sources = parseMarkdownLinks(text);
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://example.com");
  });
});

describe("formatClaudeResults", () => {
  test("formats sources with numbering", () => {
    const result = {
      sources: [
        { title: "First", url: "https://first.com" },
        { title: "Second", url: "https://second.com" },
      ],
      rawText: "",
    };
    const out = formatClaudeResults(result);
    expect(out).toContain("[1] First");
    expect(out).toContain("https://first.com");
    expect(out).toContain("[2] Second");
  });

  test("falls back to rawText when no sources parsed", () => {
    const result = {
      sources: [],
      rawText: "Some unstructured response from Claude",
    };
    expect(formatClaudeResults(result)).toBe("Some unstructured response from Claude");
  });

  test("returns no results message when both empty", () => {
    const result = { sources: [], rawText: "" };
    expect(formatClaudeResults(result)).toBe("No results found.");
  });
});
