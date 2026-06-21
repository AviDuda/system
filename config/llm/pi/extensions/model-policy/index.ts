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
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
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

    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Model Policy — select allowed tags"))));
    container.addChild(new Text(theme.fg("dim", "Model must have at least ONE selected tag (OR logic)")));
    container.addChild(new Text(""));

    const itemsRef: Text[] = [];

    function renderItems() {
      for (const item of itemsRef) {
        container.removeChild(item);
      }
      itemsRef.length = 0;

      for (let i = 0; i < availableTags.length; i++) {
        const tag = availableTags[i];
        const isSelected = selected.has(tag);
        const isFocused = i === selectedIndex;

        let line = isFocused ? theme.fg("accent", "▸ ") : "  ";
        line += isSelected ? theme.fg("success", "● ") : theme.fg("dim", "○ ");
        line += isFocused ? theme.bold(tag) : tag;

        const text = new Text(line, 0, 0);
        itemsRef.push(text);
        container.addChild(text);
      }

      // "any" option
      const anyIdx = availableTags.length;
      const anyFocused = selectedIndex === anyIdx;
      const anySelected = selected.size === 0;
      let anyLine = anyFocused ? theme.fg("accent", "▸ ") : "  ";
      anyLine += anySelected ? theme.fg("success", "● ") : theme.fg("dim", "○ ");
      anyLine += anyFocused ? theme.bold("any (unrestricted)") : "any (unrestricted)";
      const anyText = new Text(anyLine, 0, 0);
      itemsRef.push(anyText);
      container.addChild(anyText);

      container.addChild(new Text(""));
      const hint = new Text(theme.fg("dim", "↑↓ navigate • space toggle • enter confirm • esc cancel"));
      itemsRef.push(hint);
      container.addChild(hint);
    }

    renderItems();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        const totalItems = availableTags.length + 1; // +1 for "any"

        if (data === "up") {
          selectedIndex = (selectedIndex - 1 + totalItems) % totalItems;
        } else if (data === "down") {
          selectedIndex = (selectedIndex + 1) % totalItems;
        } else if (data === " ") {
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
        } else if (data === "return") {
          if (selected.size === 0 || selectedIndex === availableTags.length) {
            done(null);
          } else {
            done([...selected]);
          }
          return;
        } else if (data === "escape") {
          done(null);
          return;
        }

        renderItems();
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

      if (result.length === 0) {
        ctx.ui.notify("No tags selected — nothing to set", "warning");
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
