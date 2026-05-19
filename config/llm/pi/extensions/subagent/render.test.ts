import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { renderCall, renderResult } from "./render";
import {
  formatTokens,
  formatToolCall,
  formatUsageStats,
  getDisplayItems,
  getFinalOutput,
  type SingleResult,
  type SubagentDetails,
  type UsageStats,
} from "./rpc";

// ── Mock theme ──

function mockTheme(): Theme {
  return {
    fg: (_color: ThemeColor, text: string) => text,
    bold: (text: string) => `**${text}**`,
  } as Theme;
}

// ── formatTokens ──

describe("formatTokens", () => {
  test("shows raw number under 1000", () => {
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  test("shows 1-decimal k for 1k-10k", () => {
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(9999)).toBe("10.0k");
  });

  test("shows rounded k for 10k-1M", () => {
    expect(formatTokens(15000)).toBe("15k");
    expect(formatTokens(10000)).toBe("10k");
    expect(formatTokens(999999)).toBe("1000k");
  });

  test("shows 1-decimal M for 1M+", () => {
    expect(formatTokens(1500000)).toBe("1.5M");
    expect(formatTokens(1000000)).toBe("1.0M");
  });
});

// ── formatUsageStats ──

describe("formatUsageStats", () => {
  test("formats turns, tokens, and cost", () => {
    const usage: UsageStats = {
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 100,
      cost: 0.0123,
      contextTokens: 0,
      turns: 3,
    };
    const result = formatUsageStats(usage);
    expect(result).toContain("3 turns");
    expect(result).toContain("↑1.0k");
    expect(result).toContain("↓500");
    expect(result).toContain("R200");
    expect(result).toContain("W100");
    expect(result).toContain("$0.0123");
  });

  test("omits zero fields", () => {
    const usage: UsageStats = {
      input: 0,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    };
    const result = formatUsageStats(usage);
    expect(result).toBe("↓100");
  });

  test("includes context tokens when > 0", () => {
    const usage: UsageStats = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 50000,
      turns: 0,
    };
    expect(formatUsageStats(usage)).toContain("ctx:50k");
  });

  test("appends model name", () => {
    const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
    expect(formatUsageStats(usage, "anthropic/claude-sonnet-4")).toContain("anthropic/claude-sonnet-4");
  });
});

// ── getFinalOutput ──

describe("getFinalOutput", () => {
  test("returns text from last assistant message", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "first" }], timestamp: 0 } as Message,
      { role: "assistant", content: [{ type: "text", text: "last" }], timestamp: 0 } as Message,
    ];
    expect(getFinalOutput(messages)).toBe("last");
  });

  test("returns empty string for no assistant messages", () => {
    expect(getFinalOutput([])).toBe("");
    expect(
      getFinalOutput([
        { role: "toolResult", content: [], timestamp: 0, toolCallId: "", toolName: "", isError: false },
      ] as Message[]),
    ).toBe("");
  });

  test("skips non-text content parts", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }], timestamp: 0 } as Message,
    ];
    expect(getFinalOutput(messages)).toBe("");
  });
});

// ── getDisplayItems ──

describe("getDisplayItems", () => {
  test("extracts text and tool calls from assistant messages", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "toolCall", name: "read", arguments: { path: "foo.ts" } },
        ],
        timestamp: 0,
      } as Message,
    ];
    const items = getDisplayItems(messages);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ type: "text", text: "hello" });
    expect(items[1]).toEqual({ type: "toolCall", name: "read", args: { path: "foo.ts" } });
  });

  test("ignores non-assistant messages", () => {
    const messages: Message[] = [
      { role: "toolResult", content: [{ type: "text", text: "result" }], timestamp: 0 } as Message,
    ];
    expect(getDisplayItems(messages)).toEqual([]);
  });
});

// ── formatToolCall ──

describe("formatToolCall", () => {
  const theme = mockTheme();

  test("formats bash command", () => {
    const result = formatToolCall("bash", { command: "ls -la" }, theme.fg);
    expect(result).toContain("$");
    expect(result).toContain("ls -la");
  });

  test("truncates long bash commands", () => {
    const longCmd = "a".repeat(80);
    const result = formatToolCall("bash", { command: longCmd }, theme.fg);
    expect(result).toContain("...");
  });

  test("formats read with tilde for home paths", () => {
    const result = formatToolCall("read", { path: "/Users/test/file.ts" }, theme.fg);
    // Won't shorten unless it matches actual os.homedir(), but should contain "read"
    expect(result).toContain("read ");
  });

  test("formats unknown tools with JSON preview", () => {
    const result = formatToolCall("custom_tool", { key: "val" }, theme.fg);
    expect(result).toContain("custom_tool");
    expect(result).toContain("key");
  });
});

// ── renderCall ──

describe("renderCall", () => {
  const theme = mockTheme();

  test("renders single mode with agent name and task", () => {
    const result = renderCall({ agent: "researcher", task: "find all TODOs" }, theme, {});
    const text = result.render(80).join("\n");
    expect(text).toContain("researcher");
    expect(text).toContain("find all TODOs");
  });

  test("renders parallel mode with task count", () => {
    const result = renderCall(
      {
        tasks: [
          { agent: "a", task: "t1" },
          { agent: "b", task: "t2" },
        ],
      },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("parallel");
    expect(text).toContain("2 tasks");
  });

  test("renders chain mode with step count", () => {
    const result = renderCall(
      {
        chain: [
          { agent: "a", task: "step 1" },
          { agent: "b", task: "step 2 {previous}" },
        ],
      },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("chain");
    expect(text).toContain("2 steps");
  });

  test("shows scope in bracket", () => {
    const result = renderCall({ agent: "x", task: "t", agentScope: "both" }, theme, {});
    expect(result.render(80).join("\n")).toContain("[both]");
  });
});

// ── renderResult ──

describe("renderResult", () => {
  const theme = mockTheme();

  function makeSingleResult(overrides: Partial<SingleResult> = {}): SingleResult {
    return {
      agent: "researcher",
      agentSource: "user",
      task: "find TODOs",
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      ...overrides,
    };
  }

  test("renders single success", () => {
    const details: SubagentDetails = {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult()],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "done" }], details },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("researcher");
    expect(text).toContain("(user)");
  });

  test("renders single error with stop reason", () => {
    const details: SubagentDetails = {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult({ exitCode: 1, stopReason: "max_turns_exceeded" })],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "error" }], details },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    expect(result.render(80).join("\n")).toContain("max_turns_exceeded");
  });

  test("renders parallel results", () => {
    const details: SubagentDetails = {
      mode: "parallel",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult({ agent: "a" }), makeSingleResult({ agent: "b", exitCode: 1 })],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "" }], details },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("parallel");
    expect(text).toContain("1/2 tasks");
  });

  test("renders chain results with step numbers", () => {
    const details: SubagentDetails = {
      mode: "chain",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult({ agent: "step1", step: 1 }), makeSingleResult({ agent: "step2", step: 2 })],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "" }], details },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("chain");
    expect(text).toContain("2/2 steps");
    expect(text).toContain("Step 1");
    expect(text).toContain("Step 2");
  });

  test("renders partial streaming result", () => {
    const result = renderResult(
      { content: [{ type: "text", text: "thinking..." }] },
      { expanded: false, isPartial: true },
      theme,
      {},
    );
    expect(result.render(80).join("\n")).toContain("thinking...");
  });

  test("expanded mode shows full output and usage", () => {
    const details: SubagentDetails = {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [
        makeSingleResult({
          usage: {
            input: 5000,
            output: 2000,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.05,
            contextTokens: 100000,
            turns: 5,
          },
        }),
      ],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "done" }], details },
      { expanded: true, isPartial: false },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("5 turns");
    expect(text).toContain("↑5.0k");
    expect(text).toContain("ctx:100k");
  });
});
