/**
 * Model Policy Extension
 *
 * Enforces per-project model policies based on provider tags.
 * Tags are defined on providers in ~/.pi/agent/models.json and indicate
 * provider categories: "local", "zdr", "cloud", etc.
 *
 * Policy file (~/.pi/agent/model-policies.json):
 * {
 *   "policies": {
 *     "~/projects/my-journal": {
 *       "requireTags": ["local", "zdr"],  // must have at least ONE
 *       "comment": "Personal journal"
 *     }
 *   }
 * }
 *
 * Provider tags in models.json:
 * {
 *   "providers": {
 *     "omlx": { "tags": ["local"], "models": [...] },
 *     "openrouter": { "tags": ["zdr", "cloud"], "models": [...] }
 *   }
 * }
 *
 * Unknown providers default to ["cloud"].
 *
 * Enforcement:
 * - session_start: validate current model, auto-switch if non-compliant
 * - model_select: validate new model, revert if non-compliant
 * - before_provider_request: warn if non-compliant model reaches request stage
 * - /policy: interactive tag selector for current project
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
  expandPattern,
  findCompliantFromList,
  getAvailableTags,
  getModelTags,
  loadPolicies,
  loadProviderTags,
  modelComplies,
  type PolicyConfig,
  readEnabledModels,
  writePolicies,
} from "./policy";

// ── Compliant model resolution ───────────────────────────────────────────────

/**
 * Find a compliant model. Priority:
 * 1. First model from enabledModels (settings) that matches required tags
 * 2. First available model from registry that matches required tags
 */
async function findCompliantModel(
  policy: PolicyConfig,
  providerTags: Map<string, string[]>,
  modelRegistry: ExtensionContext["modelRegistry"],
): Promise<Model<Api> | undefined> {
  const allAvailable = modelRegistry.getAvailable();

  // Try enabledModels first (user's preferred order)
  const enabledModels = readEnabledModels(getAgentDir());
  if (enabledModels.length > 0) {
    for (const pattern of enabledModels) {
      const candidates = expandPattern(pattern, allAvailable);
      const match = findCompliantFromList(candidates, policy, providerTags);
      if (match) return match;
    }
  }

  // Fallback: scan all available models for first compliant
  return findCompliantFromList(allAvailable, policy, providerTags);
}

// ── Policy selector UI ───────────────────────────────────────────────────────

function showPolicySelector(
  availableTags: string[],
  currentTags: string[],
  ctx: ExtensionContext,
): Promise<string[] | null> {
  return ctx.ui.custom((tui, theme, _kb, done) => {
    const selected = new Set(currentTags);
    let selectedIndex = 0;
    const accent = (s: string) => theme.fg("accent", s);
    const dim = (s: string) => theme.fg("dim", s);

    function render(width: number): string[] {
      const lines: string[] = [];
      lines.push(accent("─".repeat(width)));
      lines.push(accent(theme.bold("Model Policy — select allowed tags")));
      lines.push(dim("Model must have at least ONE selected tag (OR logic)"));
      lines.push("");

      for (let i = 0; i < availableTags.length; i++) {
        const tag = availableTags[i];
        const isSelected = selected.has(tag);
        const isFocused = i === selectedIndex;

        let line = isFocused ? accent("▸ ") : "  ";
        line += isSelected ? theme.fg("success", "● ") : dim("○ ");
        line += isFocused ? theme.bold(tag) : tag;
        lines.push(line);
      }

      // "any" option
      const anyFocused = selectedIndex === availableTags.length;
      const anySelected = selected.size === 0;
      let anyLine = anyFocused ? accent("▸ ") : "  ";
      anyLine += anySelected ? theme.fg("success", "● ") : dim("○ ");
      anyLine += anyFocused ? theme.bold("any (unrestricted)") : "any (unrestricted)";
      lines.push(anyLine);

      lines.push("");
      lines.push(dim("↑↓ navigate • space toggle • enter confirm • esc cancel"));
      lines.push(accent("─".repeat(width)));
      return lines;
    }

    return {
      render,
      invalidate() {},
      handleInput(data: string) {
        const totalItems = availableTags.length + 1; // +1 for "any"

        if (matchesKey(data, Key.up)) {
          selectedIndex = (selectedIndex - 1 + totalItems) % totalItems;
        } else if (matchesKey(data, Key.down)) {
          selectedIndex = (selectedIndex + 1) % totalItems;
        } else if (matchesKey(data, Key.space)) {
          if (selectedIndex < availableTags.length) {
            const tag = availableTags[selectedIndex];
            if (selected.has(tag)) {
              selected.delete(tag);
            } else {
              selected.add(tag);
            }
          } else {
            // "any" — clear all selections
            selected.clear();
          }
        } else if (matchesKey(data, Key.enter)) {
          if (selectedIndex === availableTags.length) {
            // "any" — remove policy (unrestricted)
            done([]);
          } else if (selected.size === 0) {
            done([]);
          } else {
            done([...selected]);
          }
          return;
        } else if (matchesKey(data, Key.escape)) {
          done(null);
          return;
        }

        tui.requestRender();
      },
    };
  });
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function modelPolicyExtension(pi: ExtensionAPI) {
  let activePolicy: PolicyConfig | undefined;
  let providerTags: Map<string, string[]> = new Map();
  let isReverting = false;

  // ── /policy command ────────────────────────────────────────────────────

  pi.registerCommand("policy", {
    description: "Set model policy for this project (local, zdr, cloud tags)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/policy requires interactive mode", "error");
        return;
      }

      const agentDir = getAgentDir();
      const tags = loadProviderTags(agentDir);
      const availableTags = getAvailableTags(tags);
      const policies = loadPolicies(agentDir);
      const currentPolicy = policies[ctx.cwd];
      const currentTags = currentPolicy?.requireTags ?? [];

      const result = await showPolicySelector(availableTags, currentTags, ctx);

      if (result === null) {
        // Escape — cancel without changes
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      if (result.length === 0) {
        // "any" — remove policy for this project
        if (currentPolicy) {
          delete policies[ctx.cwd];
          writePolicies(agentDir, policies);
          activePolicy = undefined;
          ctx.ui.setStatus("policy", undefined);
          ctx.ui.notify("Policy removed — unrestricted", "info");
        } else {
          ctx.ui.notify("No policy set — already unrestricted", "info");
        }
        return;
      }

      // Set policy
      const newPolicy: PolicyConfig = {
        requireTags: result,
        comment: currentPolicy?.comment,
      };
      policies[ctx.cwd] = newPolicy;
      writePolicies(agentDir, policies);
      activePolicy = newPolicy;
      providerTags = tags;

      const tagLabel = result.join("|");
      ctx.ui.setStatus("policy", `policy:${tagLabel}`);
      ctx.ui.notify(`Policy set: requires ${tagLabel}`, "info");

      // Re-validate current model
      await applyPolicy(ctx);
    },
  });

  // ── session_start: load config, validate, auto-switch ──────────────────

  pi.on("session_start", async (_event, ctx) => {
    const agentDir = getAgentDir();
    providerTags = loadProviderTags(agentDir);
    const policies = loadPolicies(agentDir);
    const policy = policies[ctx.cwd];

    if (!policy) {
      activePolicy = undefined;
      ctx.ui.setStatus("policy", undefined);
      return;
    }

    activePolicy = policy;
    await applyPolicy(ctx);
  });

  // ── model_select: validate new model, revert if non-compliant ──────────

  pi.on("model_select", async (event, ctx) => {
    if (!activePolicy || isReverting) return;

    const { model } = event;
    if (modelComplies(model, activePolicy, providerTags)) {
      ctx.ui.setStatus("policy", `policy:${activePolicy.requireTags.join("|")}`);
      return;
    }

    // Non-compliant model selected — revert
    isReverting = true;
    try {
      const compliant = await findCompliantModel(activePolicy, providerTags, ctx.modelRegistry);
      if (compliant) {
        await pi.setModel(compliant);
        ctx.ui.notify(
          `Model ${model.provider}/${model.id} blocked by policy (requires ${activePolicy.requireTags.join(" or ")}). Switched to ${compliant.provider}/${compliant.id}.`,
          "warning",
        );
      } else {
        ctx.ui.notify(
          `Model ${model.provider}/${model.id} blocked by policy (requires ${activePolicy.requireTags.join(" or ")}). No compliant model available.`,
          "error",
        );
      }
    } finally {
      isReverting = false;
    }
  });

  // ── before_provider_request: warn if non-compliant reaches request ─────

  pi.on("before_provider_request", (_event, ctx) => {
    if (!activePolicy) return;

    const currentModel = ctx.model;
    if (!currentModel || modelComplies(currentModel, activePolicy, providerTags)) return;

    ctx.ui.notify(
      `Warning: Non-compliant model ${currentModel.provider}/${currentModel.id} reached provider request (policy: ${activePolicy.requireTags.join("|")}).`,
      "warning",
    );
  });

  // ── Shared logic ───────────────────────────────────────────────────────

  async function applyPolicy(ctx: ExtensionContext): Promise<void> {
    if (!activePolicy) return;

    const currentModel = ctx.model;
    const tagLabel = activePolicy.requireTags.join("|");
    ctx.ui.setStatus("policy", `policy:${tagLabel}`);

    if (!currentModel) {
      const compliant = await findCompliantModel(activePolicy, providerTags, ctx.modelRegistry);
      if (compliant) {
        await pi.setModel(compliant);
        ctx.ui.notify(`Model policy active (${tagLabel}). Using ${compliant.provider}/${compliant.id}.`, "info");
      }
      return;
    }

    if (modelComplies(currentModel, activePolicy, providerTags)) return;

    // Current model is non-compliant — auto-switch
    const currentTags = getModelTags(currentModel, providerTags);
    const compliant = await findCompliantModel(activePolicy, providerTags, ctx.modelRegistry);

    if (compliant) {
      isReverting = true;
      try {
        await pi.setModel(compliant);
        ctx.ui.notify(
          `Model policy active (${tagLabel}). Switched from ${currentModel.provider}/${currentModel.id} [${currentTags.join(",")}] to ${compliant.provider}/${compliant.id}.`,
          "warning",
        );
      } finally {
        isReverting = false;
      }
    } else {
      ctx.ui.notify(
        `Model policy active (${tagLabel}). Current model ${currentModel.provider}/${currentModel.id} [${currentTags.join(",")}] is non-compliant and no compliant model was found.`,
        "error",
      );
    }
  }
}
