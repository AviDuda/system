/**
 * Model roles - shared module for sidecar LLM calls.
 *
 * Reads ~/.pi/agent/roles.json for role definitions.
 * Each role maps to an ordered list of models (fallback chain).
 * Extensions use this to make cheap LLM calls for auxiliary tasks
 * (explain tool calls, auto-decide permissions, draft messages, etc.)
 * without touching the main agent model.
 *
 * Config format (~/.pi/agent/roles.json):
 * {
 *   "explain": {
 *     "models": [
 *       { "ref": "anthropic/claude-haiku-4-5", "thinking": "off" },
 *       { "ref": "openrouter/some-fallback", "thinking": "off" }
 *     ]
 *   },
 *   "decide": {
 *     "models": [
 *       { "ref": "anthropic/claude-haiku-4-5", "thinking": "minimal" }
 *     ]
 *   }
 * }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessage,
  type Context,
  completeSimple,
  type Model,
  type ThinkingLevel as PiThinkingLevel,
} from "@mariozechner/pi-ai";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent/dist/core/model-registry.js";

// ── Types ──

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface ModelEntry {
  /** "provider/modelId" reference */
  ref: string;
  /** Thinking level for this specific model. Default: "off" */
  thinking?: ThinkingLevel;
}

export interface RoleConfig {
  models: ModelEntry[];
}

export interface RolesFile {
  [roleName: string]: RoleConfig;
}

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string | undefined;
  headers: Record<string, string> | undefined;
  thinking: ThinkingLevel;
}

export interface SidecarResult {
  message: AssistantMessage;
  /** Which model from the fallback chain was used */
  modelUsed: string;
  /** Cost in dollars for this call */
  cost: number;
}

// ── Cost tracker ──

let cumulativeCost = 0;
let cumulativeCalls = 0;

export function getSidecarStats() {
  return { cost: cumulativeCost, calls: cumulativeCalls };
}

export function resetSidecarStats() {
  cumulativeCost = 0;
  cumulativeCalls = 0;
}

// ── Config loading ──

let cachedConfig: RolesFile | null = null;
let configPath: string | null = null;

function getConfigPath(): string {
  if (!configPath) {
    configPath = join(getAgentDir(), "roles.json");
  }
  return configPath;
}

export function loadConfig(): RolesFile {
  const path = getConfigPath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = readFileSync(path, "utf-8");
    cachedConfig = JSON.parse(raw) as RolesFile;
    return cachedConfig;
  } catch (err) {
    console.error(`Failed to load roles.json: ${err}`);
    return {};
  }
}

/** Force reload config from disk. */
export function reloadConfig(): RolesFile {
  cachedConfig = null;
  return loadConfig();
}

function getConfig(): RolesFile {
  if (cachedConfig) return cachedConfig;
  return loadConfig();
}

// ── Model resolution ──

function parseRef(ref: string): { provider: string; modelId: string } | null {
  const slash = ref.indexOf("/");
  if (slash === -1) return null;
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/**
 * Resolve a role to a usable model with auth.
 * Tries each model in the fallback chain until one has valid auth.
 * Returns null if no model is available.
 */
export async function resolveRole(
  roleName: string,
  modelRegistry: ModelRegistry,
): Promise<(ResolvedModel & { entry: ModelEntry }) | null> {
  const config = getConfig();
  const role = config[roleName];
  if (!role?.models?.length) return null;

  for (const entry of role.models) {
    const parsed = parseRef(entry.ref);
    if (!parsed) continue;

    const model = modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) continue;

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) continue;

    return {
      model,
      apiKey: auth.apiKey,
      headers: auth.headers,
      thinking: entry.thinking ?? "off",
      entry,
    };
  }

  return null;
}

// ── Sidecar call ──

/**
 * Make a sidecar LLM call using a named role.
 * Tries each model in the fallback chain.
 * Returns null if no model is available or all fail.
 */
export async function sidecarComplete(
  roleName: string,
  context: Context,
  modelRegistry: ModelRegistry,
  options?: { signal?: AbortSignal },
): Promise<SidecarResult | null> {
  const config = getConfig();
  const role = config[roleName];
  if (!role?.models?.length) return null;

  const errors: Array<{ ref: string; error: unknown }> = [];

  for (const entry of role.models) {
    const parsed = parseRef(entry.ref);
    if (!parsed) continue;

    const model = modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) continue;

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) continue;

    try {
      const thinking = entry.thinking ?? "off";
      // completeSimple uses "reasoning" for thinking level, but "off" isn't a valid
      // SimpleStreamOptions reasoning value -- it means no reasoning at all.
      // Only pass reasoning if it's not "off".
      const reasoning = thinking === "off" ? undefined : thinking;

      const message = await completeSimple(model, context, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        reasoning: reasoning as PiThinkingLevel | undefined,
        signal: options?.signal,
      });

      const cost = message.usage.cost.total;
      cumulativeCost += cost;
      cumulativeCalls += 1;

      return {
        message,
        modelUsed: entry.ref,
        cost,
      };
    } catch (err) {
      errors.push({ ref: entry.ref, error: err });
    }
  }

  // All models failed
  if (errors.length > 0) {
    console.error(`All models failed for role "${roleName}":`, errors.map((e) => `${e.ref}: ${e.error}`).join(", "));
  }
  return null;
}

/**
 * Check if a role is configured (has at least one model entry).
 */
export function hasRole(roleName: string): boolean {
  const config = getConfig();
  const role = config[roleName];
  return !!role?.models?.length;
}

/**
 * Get the display name for a role's active model (first available).
 */
export async function getRoleModelName(roleName: string, modelRegistry: ModelRegistry): Promise<string | null> {
  const resolved = await resolveRole(roleName, modelRegistry);
  if (!resolved) return null;
  return `${resolved.model.provider}/${resolved.model.id}`;
}

/**
 * Extract text content from an AssistantMessage.
 */
export function extractText(message: AssistantMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}
