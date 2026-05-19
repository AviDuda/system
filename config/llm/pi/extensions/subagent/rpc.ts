/**
 * RPC-based subagent execution.
 *
 * Spawns `pi --mode rpc` and communicates via bidirectional JSONL.
 * Handles streaming state, tool call tracking, steering, and abort.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionContext, type ThemeColor, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { createDebugLogger } from "../shared/debug";
import { loadConfig, resolveRole } from "../shared/model-roles";
import type { AgentConfig } from "./agents";

const SUBAGENT_SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "subagent-sessions");
const debugLog = createDebugLogger("subagent", "renderResult.log");

// ── Subagent execution ──

/** Resolve a role name to a model ref using the shared roles.json config. */
export async function resolveModel(role: string, ctx: ExtensionContext): Promise<string | null> {
  const resolved = await resolveRole(role, ctx.modelRegistry);
  return resolved ? `${resolved.model.provider}/${resolved.model.id}` : null;
}

/** Get available roles from roles.json (uses shared module for merging). */
export function getAvailableRoles(): string[] {
  const roles = loadConfig();
  return Object.keys(roles).filter((name) => roles[name]?.models?.length > 0);
}

/** Get the primary model for a role (first in the chain). */
export function getRolePrimaryModel(roleName: string): string | null {
  const roles = loadConfig();
  const roleConfig = roles[roleName];
  return roleConfig?.models?.[0]?.ref || null;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  role?: string; // role name used for model resolution
  model?: string; // resolved model ref
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

/** Handle for steering a running RPC subagent. */
export interface SubagentHandle {
  /** Send a steering message to the running subagent. Delivered after current tool batch. */
  steer(message: string): Promise<void>;
  /** Check if the subagent is currently streaming. */
  isStreaming(): boolean;
  /** Abort the subagent. */
  abort(): void;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: "user" | "project" | "both";
  projectAgentsDir: string | null;
  results: SingleResult[];
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      return themeFg("muted", "read ") + themeFg("accent", filePath);
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

/**
 * RPC-based subagent execution with steering support.
 *
 * Spawns `pi --mode rpc --no-session` and communicates via bidirectional
 * JSONL over stdin/stdout. Supports mid-run steering via the `steer()`
 * command. Events are parsed from stdout; commands are written to stdin.
 */
interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

interface RpcCommand {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export function writeRpcCommand(proc: ReturnType<typeof spawn>, cmd: RpcCommand): void {
  const stdin = proc.stdin;
  if (!stdin) return;
  stdin.write(`${JSON.stringify(cmd)}\n`);
}

export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: { content: unknown[]; details?: SubagentDetails }) => void) | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  ctx: ExtensionContext,
  maxTurns: number,
  onHandle?: ((handle: SubagentHandle) => void) | undefined,
): Promise<SingleResult> {
  // Clear debug log for this run
  debugLog.clear();

  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    };
  }

  // Resolve model from role (if specified)
  let role: string | undefined;
  let model: string | undefined;
  if (agent.role) {
    const resolved = await resolveModel(agent.role, ctx);
    if (!resolved) {
      // Role has no available models — error
      return {
        agent: agentName,
        agentSource: agent.source,
        task,
        exitCode: 1,
        messages: [],
        stderr: `Role "${agent.role}" has no available models. Check roles.json.`,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        role: agent.role,
        step,
      };
    }
    role = agent.role;
    model = resolved;
  }

  // Session dir for subagent runs — keeps session files separate from main sessions.
  // Useful for debugging what subagents actually did (tool calls, messages, etc.).
  try {
    fs.mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true });
  } catch {}

  // RPC mode: bidirectional JSONL over stdin/stdout
  const args: string[] = ["--mode", "rpc", "--session-dir", SUBAGENT_SESSION_DIR];
  if (model) args.push("--model", model);

  // Tool allowlist (built-in tools)
  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  // Extension loading: --no-extensions disables auto-discovery, then load
  // only the extensions we explicitly select.
  //
  // Default extensions for all subagents:
  //   agents-loader — provides AGENTS.local.md context, lightweight
  //   permission-gate — gates tool calls; in no-UI mode it auto-allows SAFE
  //                     (auto-classify mode) or silently blocks (careful mode).
  //                     Useful as a safety net even without UI.
  //
  // Agent-specific extensions come from the `extensions` frontmatter field.
  args.push("--no-extensions");

  const defaultSubagentExtensions = ["agents-loader"];
  const agentExtensions = agent.extensions ?? [];
  const allExtensions = [...new Set([...defaultSubagentExtensions, ...agentExtensions])];

  // Resolve extension names: check ~/.pi/agent/extensions/<name>/ first,
  // then treat as relative/absolute path
  const agentExtDir = path.join(os.homedir(), ".pi", "agent", "extensions");
  for (const ext of allExtensions) {
    let resolved: string | null = null;
    if (path.isAbsolute(ext)) {
      resolved = ext;
    } else {
      const asName = path.join(agentExtDir, ext);
      if (fs.existsSync(asName)) {
        resolved = asName;
      } else if (fs.existsSync(`${asName}.ts`)) {
        resolved = `${asName}.ts`;
      } else {
        const asDir = path.join(agentExtDir, ext, "index.ts");
        if (fs.existsSync(asDir)) {
          resolved = path.join(agentExtDir, ext);
        }
      }
      if (!resolved) {
        resolved = path.join(defaultCwd, ext);
      }
    }
    if (fs.existsSync(resolved)) {
      args.push("--extension", resolved);
    }
  }

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    role,
    step,
  };

  // RPC state tracking
  let isStreaming = false;
  let currentAssistantContent: { type: string; text?: string }[] = [];
  // Track tool calls with the text length at insertion point, for correct interleaving
  const streamingToolCalls: Array<{ name: string; args: Record<string, unknown>; textLenBefore: number }> = [];
  let wasAborted = false;
  let agentEndReceived = false; // tracks whether agent_end fired (normal completion)
  let eventCount = 0;
  let updateCount = 0; // how many times emitUpdate was called
  // Track how many tool calls have been sent, for incremental updates
  const emitUpdate = () => {
    if (onUpdate) {
      updateCount++;
      // Live display: show accumulated streaming text if available
      const streamingText = currentAssistantContent
        .filter((c) => c.type === "text" || c.type === "thinking")
        .map((c) => c.text || "")
        .join("");
      const finalOutput = getFinalOutput(currentResult.messages);
      const displayText = streamingText || finalOutput || "(running...)";
      // Build full content: display text interleaved with all tool calls
      const content: Array<{ type: string; text?: string; name?: string; args?: Record<string, unknown> }> = [];
      let lastIdx = 0;
      for (const tc of streamingToolCalls) {
        const textBefore = displayText.slice(lastIdx, tc.textLenBefore);
        if (textBefore) {
          content.push({ type: "text", text: textBefore });
        }
        content.push({ type: "toolCall", name: tc.name, args: tc.args });
        lastIdx = tc.textLenBefore;
      }
      const textAfter = displayText.slice(lastIdx);
      if (textAfter) {
        content.push({ type: "text", text: textAfter });
      }
      if (content.length === 0) {
        content.push({ type: "text", text: displayText });
      }
      onUpdate({
        content,
        details: makeDetails([]), // empty results → partial path in renderResult
      });
      // Footer status: guaranteed to render live in TUI
      ctx.ui.setStatus(
        "subagent",
        `[events:${eventCount} updates:${updateCount}] ${displayText.slice(0, 60)}${displayText.length > 60 ? "…" : ""}`,
      );
    }
  };

  // Build the steering handle
  const createHandle = (proc: ReturnType<typeof spawn>): SubagentHandle => ({
    steer: async (message: string) => {
      if (!isStreaming) return;
      writeRpcCommand(proc, { type: "steer", message });
    },
    isStreaming: () => isStreaming,
    abort: () => {
      wasAborted = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
    },
  });

  let handle: SubagentHandle | null = null;

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"], // stdin for steering commands
        env: { ...process.env, PI_SUBAGENT: "1" },
      });
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      // Create handle before starting event loop
      handle = createHandle(proc);
      onHandle?.(handle);

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: RpcEvent;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        const eventType = event.type;
        eventCount++;

        // ── Agent lifecycle ──
        if (eventType === "agent_start") {
          // Reset streaming state for live display
          isStreaming = false;
          currentAssistantContent = [];
          // Reset for new run
          streamingToolCalls.length = 0;
        }

        // ── Streaming events (for live display only) ──
        if (eventType === "message_update") {
          const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
          if (!assistantEvent) return;

          const deltaType = assistantEvent.type as string;
          isStreaming = true;

          if (deltaType === "text_delta") {
            const text = (assistantEvent.delta as string) || "";
            currentAssistantContent.push({ type: "text", text });
            emitUpdate();
          } else if (deltaType === "thinking_delta") {
            const text = (assistantEvent.delta as string) || "";
            currentAssistantContent.push({ type: "thinking", text });
            emitUpdate();
          }
        }

        // ── Tool execution start (for live tool call display) ──
        if (eventType === "tool_execution_start") {
          // Capture current text length so renderResult can interleave tool calls correctly
          const streamingText = currentAssistantContent
            .filter((c) => c.type === "text" || c.type === "thinking")
            .map((c) => c.text || "")
            .join("");
          streamingToolCalls.push({
            name: (event.toolName as string) || "unknown",
            args: (event.args as Record<string, unknown>) || {},
            textLenBefore: streamingText.length,
          });
          debugLog("tool_start", 0, { toolName: event.toolName, totalCalls: streamingToolCalls.length });
          emitUpdate();
        }

        // ── Tool execution end ──
        if (eventType === "tool_execution_end") {
          const toolResult = event.result as Record<string, unknown> | undefined;
          if (toolResult?.content && Array.isArray(toolResult.content)) {
            const content = toolResult.content as Array<{ type: string; text?: string }>;
            const textContent = content
              .filter((c) => c.type === "text")
              .map((c) => c.text || "")
              .join("\n");

            const toolResultMsg: Message = {
              role: "toolResult",
              toolCallId: (event.toolCallId as string) || `call_${Date.now()}`,
              toolName: (event.toolName as string) || "unknown",
              content: [{ type: "text", text: textContent }],
              isError: Boolean(toolResult.isError),
              timestamp: Date.now(),
            };
            currentResult.messages.push(toolResultMsg);
            emitUpdate();
          }
        }

        // ── Agent end (source of truth — pi provides complete messages) ──
        if (eventType === "agent_end") {
          agentEndReceived = true;
          const agentMessages = event.messages as Record<string, unknown>[] | undefined;
          if (agentMessages && agentMessages.length > 0) {
            // Clear and rebuild from pi's complete messages (truncate to limit)
            currentResult.messages = [];

            let assistantCount = 0;
            for (const rawMsg of agentMessages) {
              const role = rawMsg.role as string;

              if (role === "assistant") {
                // Truncate: keep only up to maxTurns assistant messages
                if (assistantCount >= maxTurns) {
                  currentResult.stopReason = "max_turns_exceeded";
                  break;
                }
                assistantCount++;
                // pi's assistant messages already have all required fields
                // Cast from Record to Message — pi constructs these internally
                const msg = rawMsg as unknown as Message;
                if (msg.role === "assistant") {
                  currentResult.messages.push(msg);
                  // Track model from last assistant message
                  if ("model" in msg) currentResult.model = msg.model as string;
                }
              } else if (role === "toolResult") {
                const msg = rawMsg as unknown as Message;
                if (msg.role === "toolResult") {
                  currentResult.messages.push(msg);
                }
              }
            }

            // Update usage from agent_end stats
            const stats = event.stats as Record<string, unknown> | undefined;
            if (stats) {
              currentResult.usage.input += (stats.inputTokens as number) || 0;
              currentResult.usage.output += (stats.outputTokens as number) || 0;
              currentResult.usage.cacheRead += (stats.cacheReadTokens as number) || 0;
              currentResult.usage.cacheWrite += (stats.cacheWriteTokens as number) || 0;
              currentResult.usage.cost += (stats.cost as number) || 0;
              currentResult.usage.contextTokens = (stats.contextTokens as number) || 0;
              currentResult.usage.turns = currentResult.messages.filter((m) => m.role === "assistant").length;
            }

            emitUpdate();
            // Clear footer status on completion
            ctx.ui.setStatus("subagent", undefined);
            // Pi's RPC mode runs `return new Promise(() => {})` to keep alive forever.
            // No shutdown command exists. Abort cancels the agent operation, then
            // SIGTERM triggers the registered signal handler which calls shutdown().
            if (proc.stdin) {
              proc.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
            }
            // SIGTERM triggers pi's shutdown handler (registered via registerSignalHandlers).
            proc.kill("SIGTERM");
            // Fallback: SIGKILL if SIGTERM doesn't work within 3s.
            killTimer = setTimeout(() => {
              if (!proc.killed) {
                proc.kill("SIGKILL");
              }
            }, 3000);
          }
        }

        // ── Queue update (for steering) ──
        if (eventType === "queue_update") {
          // Steering messages are queued — isStreaming tells us if we can send more
        }

        // ── Extension UI request (permission gate, etc.) ──
        if (eventType === "extension_ui_request") {
          // In RPC mode, extension UI requests come through stdout.
          // We need to forward them to the parent's UI via the RPC extension UI sub-protocol.
          // The parent TUI handles this automatically when running interactively.
          // For subagent steering, we just log it.
          const method = event.method as string;
          if (method === "confirm" || method === "select" || method === "input") {
            // Dialog methods need a response — but subagents don't have UI access.
            // Auto-resolve with defaults to avoid blocking.
            const requestId = event.id as string;
            if (method === "confirm") {
              writeRpcCommand(proc, { type: "extension_ui_response", id: requestId, cancelled: true });
            } else {
              writeRpcCommand(proc, { type: "extension_ui_response", id: requestId, cancelled: true });
            }
          }
          // Fire-and-forget methods (notify, setStatus, etc.) — no response needed
        }

        // ── Extension error ──
        if (eventType === "extension_error") {
          const extPath = event.extensionPath as string;
          const error = event.error as string;
          currentResult.stderr += `[extension error: ${extPath}] ${error}\n`;
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderrBuffer += data.toString();
      });

      proc.on("close", (code: number | null) => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        currentResult.stderr += stderrBuffer;
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        resolve(1);
      });

      // Abort signal
      if (signal) {
        const killProc = () => {
          wasAborted = true;
          handle?.abort();
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }

      // Send initial prompt
      writeRpcCommand(proc, { type: "prompt", message: `Task: ${task}` });
    });

    currentResult.exitCode = exitCode;
    // Only throw if user aborted BEFORE agent_end completed.
    // After agent_end, we send abort as cleanup — wasAborted is true but it's normal.
    if (wasAborted && !agentEndReceived) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}
