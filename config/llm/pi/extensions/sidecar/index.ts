/**
 * /sidecar command — pick models for sidecar roles (explain, draft, etc.)
 *
 * Two-screen TUI:
 * 1. Role list (explain, draft) showing current primary model
 * 2. Model picker for the selected role, with chain position labels
 *
 * Keybindings (role list):
 *   Enter: select role → model picker
 *   r: reset all roles to defaults
 *   Esc: cancel
 *
 * Keybindings (model picker):
 *   Enter: set model as primary (#1)
 *   p: promote one position up the chain
 *   d: demote one position down the chain
 *   x: remove from chain
 *   /: toggle search filter
 *   r: reset this role to defaults
 *   Esc: exit search → back to role list
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir, type ModelRegistry } from "@mariozechner/pi-coding-agent";
import { matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

// ── Types ──

interface ModelEntry {
  ref: string;
  thinking?: string;
  maxAttempts?: number;
}

interface RoleConfig {
  models: ModelEntry[];
  maxTokens?: number;
}

type RolesFile = Record<string, RoleConfig>;

interface ModelOption {
  ref: string;
  name: string;
}

// ── Config helpers ──

function localPath(): string {
  return join(getAgentDir(), "roles.local.json");
}

function defaultsPath(): string {
  return join(getAgentDir(), "roles.json");
}

function readJson(path: string): RolesFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RolesFile;
  } catch {
    return {};
  }
}

function writeLocal(data: RolesFile): void {
  writeFileSync(localPath(), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function mergedRoles(): RolesFile {
  const defaults = readJson(defaultsPath());
  const local = readJson(localPath());
  return { ...defaults, ...local };
}

function getAvailableModels(registry: ModelRegistry): ModelOption[] {
  return registry
    .getAvailable()
    .map((m) => ({ ref: `${m.provider}/${m.id}`, name: m.name ?? m.id }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

// ── Command ──

type Screen = "roles" | "models";

export default function sidecarCommand(pi: ExtensionAPI) {
  pi.registerCommand("sidecar", {
    description: "Configure sidecar model roles (explain, draft)",

    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/sidecar requires interactive mode", "error");
        return;
      }

      const roleNames = Object.keys(mergedRoles());
      if (roleNames.length === 0) {
        ctx.ui.notify("No roles configured in roles.json", "warning");
        return;
      }

      await ctx.ui.custom((tui, theme, _kb, done) => {
        let screen: Screen = "roles";
        let selectedRole = roleNames[0];
        let filterMode = false;
        let filterText = "";

        // ── Header & help ──

        const headerText = new Text("", 1, 0);
        const helpText = new Text("", 1, 0);

        function updateHeader() {
          if (screen === "roles") {
            headerText.setText(theme.fg("accent", theme.bold("Sidecar Model Roles")));
          } else {
            const fresh = mergedRoles();
            const chainLen = fresh[selectedRole]?.models?.length ?? 0;
            const hasLocal = existsSync(localPath()) && selectedRole in readJson(localPath());
            const localTag = hasLocal ? theme.fg("dim", " (custom)") : "";
            headerText.setText(
              `${theme.fg("accent", theme.bold(`Role: ${selectedRole}`))}${localTag}\n${theme.fg("dim", `${chainLen} model${chainLen !== 1 ? "s" : ""} in fallback chain`)}`,
            );
          }
        }

        function updateHelp() {
          if (screen === "roles") {
            helpText.setText(theme.fg("dim", "Enter select  |  r reset all  |  Esc cancel"));
          } else if (filterMode) {
            helpText.setText(theme.fg("dim", `filter: ${filterText}_  |  Enter/Esc close filter`));
          } else {
            helpText.setText(
              theme.fg(
                "dim",
                "Enter primary  |  p promote  |  d demote  |  x remove  |  / search  |  r reset role  |  Esc back",
              ),
            );
          }
        }

        // ── Roles screen ──

        const roleItems: SelectItem[] = roleNames.map((name) => {
          const role = mergedRoles()[name];
          const primary = role?.models?.[0]?.ref ?? "(none)";
          return { value: name, label: name, description: primary };
        });

        const roleList = new SelectList(roleItems, Math.min(roleItems.length + 2, 10), {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        });

        roleList.onSelect = (item) => {
          selectedRole = item.value;
          switchToModels();
        };
        roleList.onCancel = () => done(undefined);

        function refreshRoleDescriptions() {
          const fresh = mergedRoles();
          for (const item of roleItems) {
            const role = fresh[item.value];
            item.description = role?.models?.[0]?.ref ?? "(none)";
          }
          roleList.setFilter("");
        }

        // ── Models screen ──

        // Full unfiltered items, used by custom filter
        let allModelItems: SelectItem[] = [];

        let modelList: SelectList = buildModelList(undefined);

        function buildModelList(preserveRef: string | undefined): SelectList {
          const available = getAvailableModels(ctx.modelRegistry);
          const role = mergedRoles()[selectedRole];
          const chain = role?.models ?? [];

          // Current chain first, then remaining available
          const seen = new Set(chain.map((m) => m.ref));
          const ordered: ModelOption[] = [
            ...chain.map((m) => {
              const found = available.find((a) => a.ref === m.ref);
              return { ref: m.ref, name: found?.name ?? m.ref };
            }),
            ...available.filter((a) => !seen.has(a.ref)),
          ];

          const items: SelectItem[] = ordered.map((m, idx) => {
            const inChain = idx < chain.length;
            return {
              value: m.ref,
              label: `${inChain ? `#${idx + 1} ` : "   "}${m.name}`,
              description: m.ref,
            };
          });
          allModelItems = items;

          const list = new SelectList(items, Math.min(items.length + 2, 15), {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          });

          // Override setFilter to match against label + description with includes (not value with startsWith)
          const originalSetFilter = list.setFilter.bind(list);
          list.setFilter = (filter: string) => {
            if (!filter) {
              originalSetFilter("");
              return;
            }
            const lower = filter.toLowerCase();
            // @ts-expect-error accessing private filteredItems
            list.filteredItems = allModelItems.filter(
              (item) => item.label.toLowerCase().includes(lower) || item.description?.toLowerCase().includes(lower),
            );
            list.setSelectedIndex(0);
            list.invalidate?.();
          };

          // Restore selection to the previously selected model
          if (preserveRef) {
            const idx = items.findIndex((item) => item.value === preserveRef);
            if (idx !== -1) list.setSelectedIndex(idx);
          }

          list.onSelect = (item) => {
            promoteToPrimary(item.value);
          };
          list.onCancel = () => {
            if (filterMode) {
              exitFilter();
            } else {
              switchToRoles();
            }
          };
          return list;
        }

        // ── Chain mutations ──

        /** Get the ref of the currently selected model, for preserving selection across rebuilds. */
        function getSelectedModelRef(): string | undefined {
          return modelList.getSelectedItem()?.value;
        }

        function saveChain(newChain: ModelEntry[], preserveRef?: string) {
          const local = readJson(localPath());
          const base = mergedRoles();
          local[selectedRole] = { ...base[selectedRole], models: newChain };
          writeLocal(local);
          rebuildModelsScreen(preserveRef);
        }

        function promoteToPrimary(ref: string) {
          const base = mergedRoles();
          const existing = base[selectedRole]?.models ?? [];
          const filtered = existing.filter((m) => m.ref !== ref);
          const moved = existing.find((m) => m.ref === ref);
          saveChain([moved ?? { ref, thinking: "off" as const }, ...filtered], ref);
        }

        function moveModel(ref: string, direction: -1 | 1) {
          const base = mergedRoles();
          const chain = [...(base[selectedRole]?.models ?? [])];
          const idx = chain.findIndex((m) => m.ref === ref);
          if (idx === -1) return;
          const newIdx = idx + direction;
          if (newIdx < 0 || newIdx >= chain.length) return;
          [chain[idx], chain[newIdx]] = [chain[newIdx], chain[idx]];
          saveChain(chain, ref);
        }

        function removeModel(ref: string) {
          const base = mergedRoles();
          const chain = base[selectedRole]?.models ?? [];
          if (chain.length <= 1) return; // don't empty the chain entirely
          saveChain(
            chain.filter((m) => m.ref !== ref),
            ref,
          );
        }

        function resetRole() {
          const local = readJson(localPath());
          delete local[selectedRole];
          if (Object.keys(local).length === 0) {
            if (existsSync(localPath())) unlinkSync(localPath());
          } else {
            writeLocal(local);
          }
          rebuildModelsScreen(getSelectedModelRef());
        }

        // ── Filter ──

        function enterFilter() {
          filterMode = true;
          filterText = "";
          updateHelp();
          tui.requestRender();
        }

        function exitFilter() {
          filterMode = false;
          filterText = "";
          modelList.setFilter("");
          updateHelp();
          tui.requestRender();
        }

        // ── Screen switching ──

        function switchToRoles() {
          screen = "roles";
          filterMode = false;
          refreshRoleDescriptions();
          updateHeader();
          updateHelp();
          tui.requestRender();
        }

        function switchToModels() {
          screen = "models";
          filterMode = false;
          filterText = "";
          rebuildModelsScreen(undefined);
        }

        function rebuildModelsScreen(preserveRef: string | undefined) {
          modelList = buildModelList(preserveRef);
          if (filterText) modelList.setFilter(filterText);
          updateHeader();
          updateHelp();
          tui.requestRender();
        }

        // ── Initial render ──
        updateHeader();
        updateHelp();

        return {
          render(width: number) {
            const lines: string[] = [];
            lines.push(...headerText.render(width));
            lines.push("");
            if (screen === "roles") {
              lines.push(...roleList.render(width));
            } else {
              lines.push(...modelList.render(width));
            }
            lines.push("");
            lines.push(...helpText.render(width));
            return lines;
          },
          invalidate() {},
          handleInput(data: string) {
            // Reset works on both screens
            if (matchesKey(data, "r") && !filterMode) {
              resetRole();
              if (screen === "roles") {
                refreshRoleDescriptions();
                updateHeader();
                tui.requestRender();
              }
              return;
            }

            if (screen === "roles") {
              roleList.handleInput(data);
              tui.requestRender();
              return;
            }

            // ── Models screen ──

            // Filter mode: only intercept typing and backspace; let arrows/actions pass through
            if (filterMode) {
              if (matchesKey(data, "escape")) {
                exitFilter();
                return;
              }
              if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
                if (filterText.length > 0) {
                  filterText = filterText.slice(0, -1);
                  modelList.setFilter(filterText);
                  updateHelp();
                  tui.requestRender();
                }
                return;
              }
              // Printable character → append to filter
              if (data.length === 1 && data >= " " && data <= "~") {
                filterText += data;
                modelList.setFilter(filterText);
                updateHelp();
                tui.requestRender();
                return;
              }
              // Fall through: arrows, Enter, and action keys work while filtered
            }

            // Normal mode shortcuts
            if (matchesKey(data, "/")) {
              enterFilter();
              return;
            }
            if (matchesKey(data, "p")) {
              const ref = getSelectedModelRef();
              if (ref) moveModel(ref, -1);
              return;
            }
            if (matchesKey(data, "d")) {
              const ref = getSelectedModelRef();
              if (ref) moveModel(ref, 1);
              return;
            }
            if (matchesKey(data, "x")) {
              const ref = getSelectedModelRef();
              if (ref) removeModel(ref);
              return;
            }

            // Default: pass to select list (arrows, Enter, Esc)
            modelList.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  });
}
