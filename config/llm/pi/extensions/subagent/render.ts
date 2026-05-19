/**
 * TUI rendering for subagent tool calls and results.
 *
 * All theme-aware display formatting: tool call previews, result summaries,
 * chain/parallel/single rendering, usage stats formatting.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createDebugLogger } from "../shared/debug";
import {
  type DisplayItem,
  formatToolCall,
  formatUsageStats,
  getDisplayItems,
  getFinalOutput,
  type SingleResult,
  type SubagentDetails,
  type UsageStats,
} from "./rpc";

const COLLAPSED_ITEM_COUNT = 10;
const DEBUG_INTERVAL = 500;
const debugLog = createDebugLogger("subagent", "renderResult.log");

export function renderCall(args: Record<string, unknown>, theme: Theme, _context: unknown) {
  const scope: string = (args.agentScope as string) ?? "user";
  if (args.chain && (args.chain as Array<unknown>).length > 0) {
    const chain = args.chain as Array<{ agent: string; task: string }>;
    let text =
      theme.fg("toolTitle", theme.bold("subagent ")) +
      theme.fg("accent", `chain (${chain.length} steps)`) +
      theme.fg("muted", ` [${scope}]`);
    for (let i = 0; i < Math.min(chain.length, 3); i++) {
      const step = chain[i];
      const cleanTask = (step.task as string).replace(/\{previous\}/g, "").trim();
      const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
      text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
    }
    if (chain.length > 3) text += `\n  ${theme.fg("muted", `... +${chain.length - 3} more`)}`;
    return new Text(text, 0, 0);
  }
  if (args.tasks && (args.tasks as Array<unknown>).length > 0) {
    const tasks = args.tasks as Array<{ agent: string; task: string }>;
    let text =
      theme.fg("toolTitle", theme.bold("subagent ")) +
      theme.fg("accent", `parallel (${tasks.length} tasks)`) +
      theme.fg("muted", ` [${scope}]`);
    for (const t of tasks.slice(0, 3)) {
      const preview = (t.task as string).length > 40 ? `${(t.task as string).slice(0, 40)}...` : t.task;
      text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
    }
    if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
    return new Text(text, 0, 0);
  }
  const agentName = typeof args.agent === "string" ? args.agent : "...";
  const taskStr = typeof args.task === "string" ? args.task : "";
  const preview = taskStr.length > 60 ? `${taskStr.slice(0, 60)}...` : taskStr;
  let text =
    theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName) + theme.fg("muted", ` [${scope}]`);
  text += `\n  ${theme.fg("dim", preview)}`;
  return new Text(text, 0, 0);
}

export function renderResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  _context: unknown,
) {
  const details = result.details as SubagentDetails | undefined;
  if (!details || details.results.length === 0) {
    // Partial result during streaming — render all content items (text + toolCalls)
    const content = result.content as Array<{
      type: string;
      text?: string;
      name?: string;
      args?: Record<string, unknown>;
    }>;
    const parts: string[] = [];
    for (const item of content) {
      if (item.type === "text") {
        parts.push(item.text || "");
      } else if (item.type === "toolCall") {
        const tc = item as { type: "toolCall"; name: string; args: Record<string, unknown> };
        const toolText = `${theme.fg("muted", "→ ")}${formatToolCall(tc.name, tc.args, theme.fg.bind(theme))}`;
        parts.push(`\n${toolText}`);
      }
    }
    const text = parts.join("") || "(running...)";
    const allContentTypes = content.map((c) => c.type);
    debugLog("partial", DEBUG_INTERVAL, {
      isPartial,
      expanded,
      content0Type: content[0]?.type,
      contentTypes: allContentTypes,
      contentCount: allContentTypes.length,
      textLen: text.length,
      textPreview: `${text.slice(0, 200)}...[${text.length > 400 ? text.slice(-200) : "(end)"}]`,
    });
    return new Text(text, 0, 0);
  }

  const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
    const toShow = limit ? items.slice(-limit) : items;
    const skipped = limit && items.length > limit ? items.length - limit : 0;
    let text = "";
    if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
    for (const item of toShow) {
      if (item.type === "text") {
        const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
        text += `${theme.fg("toolOutput", preview)}\n`;
      } else {
        text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
      }
    }
    return text.trimEnd();
  };

  if (details.mode === "single" && details.results.length === 1) {
    const r = details.results[0];
    const isError =
      r.exitCode !== 0 ||
      r.stopReason === "error" ||
      r.stopReason === "aborted" ||
      r.stopReason === "max_turns_exceeded";
    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const displayItems = getDisplayItems(r.messages);
    const finalOutput = getFinalOutput(r.messages);

    if (expanded) {
      const parts: string[] = [];
      let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
      if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
      parts.push(header);
      if (isError && r.errorMessage) parts.push(theme.fg("error", `Error: ${r.errorMessage}`));
      parts.push(theme.fg("muted", "─── Task ───"), theme.fg("dim", r.task));
      if (displayItems.length === 0 && !finalOutput) {
        parts.push(theme.fg("muted", "(no output)"));
      } else {
        for (const item of displayItems) {
          if (item.type === "toolCall") {
            parts.push(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)));
          }
        }
        if (finalOutput) parts.push(theme.fg("muted", "─── Output ───"), finalOutput);
      }
      const usageStr = formatUsageStats(r.usage, r.model);
      if (usageStr) parts.push(theme.fg("dim", usageStr));
      return new Text(parts.join("\n"), 0, 0);
    }

    let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
    if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
    if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
    else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
    else {
      text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
      if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
    }
    const usageStr = formatUsageStats(r.usage, r.model);
    if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
    return new Text(text, 0, 0);
  }

  const aggregateUsage = (results: SingleResult[]) => {
    const total: UsageStats = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    };
    for (const r of results) {
      total.input += r.usage.input;
      total.output += r.usage.output;
      total.cacheRead += r.usage.cacheRead;
      total.cacheWrite += r.usage.cacheWrite;
      total.cost += r.usage.cost;
      total.contextTokens += r.usage.contextTokens;
      total.turns += r.usage.turns;
    }
    return total;
  };

  if (details.mode === "chain") {
    const successCount = details.results.filter((r) => r.exitCode === 0).length;
    const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

    if (expanded) {
      const parts: string[] = [
        icon +
          " " +
          theme.fg("toolTitle", theme.bold("chain ")) +
          theme.fg("accent", `${successCount}/${details.results.length} steps`),
      ];
      for (const r of details.results) {
        const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
        parts.push(`\n\n─── Step ${r.step}: ${theme.fg("accent", r.agent)} ${rIcon}\nTask: ${r.task}`);
        for (const item of getDisplayItems(r.messages)) {
          if (item.type === "toolCall") {
            parts.push(`\n${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`);
          }
        }
        const finalOutput = getFinalOutput(r.messages);
        if (finalOutput) parts.push(`\n\n${finalOutput.trim()}`);
        const stepUsage = formatUsageStats(r.usage, r.model);
        if (stepUsage) parts.push(`\n${theme.fg("dim", stepUsage)}`);
      }
      const usageStr = formatUsageStats(aggregateUsage(details.results));
      if (usageStr) parts.push(`\n\n${theme.fg("dim", `Total: ${usageStr}`)}`);
      return new Text(parts.join(""), 0, 0);
    }

    let text =
      icon +
      " " +
      theme.fg("toolTitle", theme.bold("chain ")) +
      theme.fg("accent", `${successCount}/${details.results.length} steps`);
    for (const r of details.results) {
      const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
      text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
      const displayItems = getDisplayItems(r.messages);
      if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
      else text += `\n${renderDisplayItems(displayItems, 5)}`;
    }
    const usageStr = formatUsageStats(aggregateUsage(details.results));
    if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
    text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
    return new Text(text, 0, 0);
  }

  if (details.mode === "parallel") {
    const running = details.results.filter((r) => r.exitCode === -1).length;
    const successCount = details.results.filter((r) => r.exitCode === 0).length;
    const failCount = details.results.filter((r) => r.exitCode > 0).length;
    const isRunning = running > 0;
    const icon = isRunning
      ? theme.fg("warning", "⏳")
      : failCount > 0
        ? theme.fg("warning", "◐")
        : theme.fg("success", "✓");
    const status = isRunning
      ? `${successCount + failCount}/${details.results.length} done, ${running} running`
      : `${successCount}/${details.results.length} tasks`;

    if (expanded && !isRunning) {
      const parts: string[] = [
        `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
      ];
      for (const r of details.results) {
        const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
        parts.push(`\n\n─── ${theme.fg("accent", r.agent)} ${rIcon}\nTask: ${r.task}`);
        for (const item of getDisplayItems(r.messages)) {
          if (item.type === "toolCall") {
            parts.push(`\n${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`);
          }
        }
        const finalOutput = getFinalOutput(r.messages);
        if (finalOutput) parts.push(`\n\n${finalOutput.trim()}`);
        const taskUsage = formatUsageStats(r.usage, r.model);
        if (taskUsage) parts.push(`\n${theme.fg("dim", taskUsage)}`);
      }
      const usageStr = formatUsageStats(aggregateUsage(details.results));
      if (usageStr) parts.push(`\n\n${theme.fg("dim", `Total: ${usageStr}`)}`);
      return new Text(parts.join(""), 0, 0);
    }

    let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
    for (const r of details.results) {
      const rIcon =
        r.exitCode === -1
          ? theme.fg("warning", "⏳")
          : r.exitCode === 0
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");
      const displayItems = getDisplayItems(r.messages);
      text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
      if (displayItems.length === 0)
        text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
      else text += `\n${renderDisplayItems(displayItems, 5)}`;
    }
    if (!isRunning) {
      const usageStr = formatUsageStats(aggregateUsage(details.results));
      if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
    }
    if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
    return new Text(text, 0, 0);
  }

  const text = result.content[0];
  return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}
