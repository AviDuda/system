/**
 * Model policy logic — pure functions, no pi imports.
 * Reads config files and evaluates model compliance against policies.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PolicyConfig {
  requireTags: string[];
  comment?: string;
}

export interface PoliciesFile {
  policies: Record<string, PolicyConfig>;
}

export interface ProviderEntry {
  tags?: string[];
  models?: unknown[];
  [key: string]: unknown;
}

export interface ModelsFile {
  providers?: Record<string, ProviderEntry>;
}

/** Minimal model shape for compliance checks. */
export interface ModelLike {
  provider: string;
  id: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_TAGS: string[] = ["cloud"];

// ── Config loading ───────────────────────────────────────────────────────────

/**
 * Load provider→tags mapping from models.json.
 * Unknown providers get DEFAULT_TAGS when looked up.
 */
export function loadProviderTags(agentDir: string): Map<string, string[]> {
  const modelsPath = join(agentDir, "models.json");
  const tags = new Map<string, string[]>();

  if (!existsSync(modelsPath)) return tags;

  try {
    const raw = JSON.parse(readFileSync(modelsPath, "utf-8")) as ModelsFile;
    if (raw.providers) {
      for (const [provider, config] of Object.entries(raw.providers)) {
        tags.set(provider, config.tags ?? DEFAULT_TAGS);
      }
    }
  } catch {
    // parse error — return empty
  }

  return tags;
}

/**
 * Load project policies from model-policies.json.
 */
export function loadPolicies(agentDir: string): Record<string, PolicyConfig> {
  const policiesPath = join(agentDir, "model-policies.json");

  if (!existsSync(policiesPath)) return {};

  try {
    const raw = JSON.parse(readFileSync(policiesPath, "utf-8")) as PoliciesFile;
    return raw.policies ?? {};
  } catch {
    return {};
  }
}

/**
 * Read enabledModels from global settings.json.
 */
export function readEnabledModels(agentDir: string): string[] {
  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) return [];
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    if (Array.isArray(settings.enabledModels)) {
      return settings.enabledModels as string[];
    }
  } catch {
    // ignore
  }
  return [];
}

// ── Tag matching ─────────────────────────────────────────────────────────────

/**
 * Get tags for a model by its provider name.
 * Unknown providers default to DEFAULT_TAGS.
 */
export function getModelTags(model: ModelLike, providerTags: Map<string, string[]>): string[] {
  return providerTags.get(model.provider) ?? DEFAULT_TAGS;
}

/**
 * Check if a model satisfies a policy.
 * requireTags is OR logic: model must have at least ONE required tag.
 */
export function modelComplies(model: ModelLike, policy: PolicyConfig, providerTags: Map<string, string[]>): boolean {
  const tags = getModelTags(model, providerTags);
  return policy.requireTags.some((t) => tags.includes(t));
}

/**
 * Find first compliant model from a list.
 * Returns undefined if none match.
 */
export function findCompliantFromList<T extends ModelLike>(
  models: T[],
  policy: PolicyConfig,
  providerTags: Map<string, string[]>,
): T | undefined {
  return models.find((m) => modelComplies(m, policy, providerTags));
}

/**
 * Expand an enabledModels pattern against available models.
 * Supports exact match ("provider/model-id") and wildcard ("provider/*").
 * Returns matching models in the order they appear in availableModels.
 */
export function expandPattern<T extends ModelLike>(pattern: string, availableModels: T[]): T[] {
  const parts = pattern.split("/");
  if (parts.length < 2) return [];
  const provider = parts[0];
  const modelId = parts.slice(1).join("/");

  if (modelId === "*") {
    return availableModels.filter((m) => m.provider === provider);
  }

  return availableModels.filter((m) => m.provider === provider && m.id === modelId);
}

// ── Tags ─────────────────────────────────────────────────────────────────────

/** Get all unique tags from the provider tags map. */
export function getAvailableTags(providerTags: Map<string, string[]>): string[] {
  const tags = new Set<string>();
  for (const tagList of providerTags.values()) {
    for (const tag of tagList) {
      tags.add(tag);
    }
  }
  return [...tags].sort();
}

// ── Policy file writing ──────────────────────────────────────────────────────

export function writePolicies(agentDir: string, policies: Record<string, PolicyConfig>): void {
  const policiesPath = join(agentDir, "model-policies.json");
  writeFileSync(policiesPath, `${JSON.stringify({ policies }, null, 2)}\n`, "utf-8");
}
