import { describe, expect, test } from "bun:test";
import { cleanMarkdown, sessionName, stripAnsi, truncateContent } from "./web-fetch";

describe("sessionName", () => {
  test("derives from basename", () => {
    expect(sessionName("/Users/avi/system")).toBe("pi-fetch-system");
  });

  test("handles nested paths", () => {
    expect(sessionName("/Users/avi/dev/my-project")).toBe("pi-fetch-my-project");
  });
});

describe("stripAnsi", () => {
  test("strips color codes", () => {
    expect(stripAnsi("\x1b[32m✓\x1b[0m Page Title")).toBe("✓ Page Title");
  });

  test("passes plain text through", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  test("strips multiple codes", () => {
    expect(stripAnsi("\x1b[1m\x1b[31merror\x1b[0m")).toBe("error");
  });
});

describe("truncateContent", () => {
  test("returns unchanged if under limit", () => {
    const result = truncateContent("short", 1000);
    expect(result.text).toBe("short");
    expect(result.truncated).toBe(false);
  });

  test("truncates with note", () => {
    const result = truncateContent("a".repeat(200), 100);
    expect(result.text).toContain("a".repeat(100));
    expect(result.text).toContain("[Truncated at 100 characters]");
    expect(result.truncated).toBe(true);
  });

  test("exact limit is not truncated", () => {
    const result = truncateContent("a".repeat(100), 100);
    expect(result.truncated).toBe(false);
  });
});

describe("cleanMarkdown", () => {
  test("strips data: URI images", () => {
    const input = "# Title\n\n![icon](data:image/svg+xml;base64,abc123)\n\nContent";
    expect(cleanMarkdown(input)).toBe("# Title\n\nContent");
  });

  test("strips data: URI image links (non-image reference)", () => {
    const input = "# Heading\n\n[](data:image/svg+xml;base64,abc123)\n\nText";
    expect(cleanMarkdown(input)).toBe("# Heading\n\nText");
  });

  test("strips nested image links (GitHub pattern)", () => {
    const input = "[![alt](https://example.com/img.png)](https://example.com/link)";
    expect(cleanMarkdown(input)).toBe("");
  });

  test("collapses excessive blank lines", () => {
    const input = "Line 1\n\n\n\n\nLine 2";
    expect(cleanMarkdown(input)).toBe("Line 1\n\nLine 2");
  });

  test("preserves normal markdown", () => {
    const input = "# Title\n\n- item 1\n- item 2\n\n[link](https://example.com)";
    expect(cleanMarkdown(input)).toBe(input);
  });

  test("preserves code blocks", () => {
    const input = "```c\nint main() {}\n```";
    expect(cleanMarkdown(input)).toBe(input);
  });
});
