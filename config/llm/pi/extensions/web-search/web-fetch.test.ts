import { describe, expect, test } from "bun:test";
import { sessionName, stripAnsi, truncateContent } from "./web-fetch";

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
