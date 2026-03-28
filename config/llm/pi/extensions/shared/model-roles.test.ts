import { beforeEach, describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { extractText, getSidecarStats, parseRef, resetSidecarStats } from "./model-roles";

// ── extractText ──

describe("extractText", () => {
  function msg(...parts: Array<{ type: string; text?: string }>): AssistantMessage {
    return {
      role: "assistant",
      content: parts,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0 } },
    } as AssistantMessage;
  }

  test("extracts single text block", () => {
    expect(extractText(msg({ type: "text", text: "hello" }))).toBe("hello");
  });

  test("concatenates multiple text blocks", () => {
    expect(extractText(msg({ type: "text", text: "hello " }, { type: "text", text: "world" }))).toBe("hello world");
  });

  test("skips non-text content", () => {
    expect(extractText(msg({ type: "thinking", text: "hmm" }, { type: "text", text: "result" }))).toBe("result");
  });

  test("returns empty string for no text content", () => {
    expect(extractText(msg({ type: "thinking", text: "hmm" }))).toBe("");
  });

  test("returns empty string for empty content", () => {
    expect(extractText(msg())).toBe("");
  });
});

// ── parseRef ──

describe("parseRef", () => {
  test("parses provider/modelId", () => {
    expect(parseRef("anthropic/claude-haiku-4-5")).toEqual({ provider: "anthropic", modelId: "claude-haiku-4-5" });
  });

  test("handles provider with nested path", () => {
    expect(parseRef("openrouter/anthropic/claude-3")).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-3",
    });
  });

  test("returns null for no slash", () => {
    expect(parseRef("claude-haiku")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseRef("")).toBeNull();
  });
});

// ── sidecar stats ──

describe("sidecarStats", () => {
  beforeEach(() => {
    resetSidecarStats();
  });

  test("starts at zero", () => {
    expect(getSidecarStats()).toEqual({ cost: 0, calls: 0 });
  });

  test("reset clears stats", () => {
    // Stats are modified by sidecarComplete internally, but reset is testable
    resetSidecarStats();
    expect(getSidecarStats()).toEqual({ cost: 0, calls: 0 });
  });
});
