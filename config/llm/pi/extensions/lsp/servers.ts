/**
 * LSP server configurations and auto-detection.
 *
 * Server configs adapted from oh-my-pi's defaults.json.
 * Auto-detection: checks root markers in cwd, then verifies binary is on PATH.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerConfig } from "./client";
import { hasRootMarkers, resolveCommand } from "./client";
import { findDevcontainerRoot } from "./devcontainer";

/** Calculate tsserver memory limit: 1/8 of system RAM, min 4096 MB */
export function getTsServerMemory(): number {
  const systemMB = Math.floor(os.totalmem() / (1024 * 1024));
  return Math.max(4096, Math.floor(systemMB / 8));
}

/**
 * Known LSP server configurations.
 * Key = server name, value = how to start it and what files it handles.
 */
export const KNOWN_SERVERS: Record<string, ServerConfig> = {
  "typescript-language-server": {
    command: "typescript-language-server",
    args: ["--stdio"],
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
    initOptions: {
      hostInfo: "pi-lsp-extension",
      maxTsServerMemory: getTsServerMemory(),
      preferences: {
        includeInlayParameterNameHints: "all",
        includeInlayVariableTypeHints: true,
      },
    },
  },

  "rust-analyzer": {
    command: "rust-analyzer",
    args: [],
    fileTypes: [".rs"],
    rootMarkers: ["Cargo.toml", "rust-analyzer.toml"],
    // Disable hover actions (implementations, references, debug) — the agent
    // doesn't use interactive hover UI, and these cause timeouts on complex types.
    // Keep hover content (type info + docs) but skip the action buttons.
    initOptions: {
      hover: {
        actions: { enable: false },
        // Disable memory layout info — not useful for an agent, adds computation
        memoryLayout: { enable: false },
      },
    },
  },

  gopls: {
    command: "gopls",
    args: ["serve"],
    fileTypes: [".go"],
    rootMarkers: ["go.mod", "go.work"],
    settings: {
      gopls: {
        analyses: { unusedparams: true, shadow: true },
        staticcheck: true,
      },
    },
  },

  pyright: {
    command: "pyright-langserver",
    args: ["--stdio"],
    fileTypes: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "requirements.txt"],
    settings: {
      python: {
        analysis: {
          autoSearchPaths: true,
          diagnosticMode: "openFilesOnly",
          useLibraryCodeForTypes: true,
        },
      },
    },
  },

  nixd: {
    command: "nixd",
    args: [],
    fileTypes: [".nix"],
    rootMarkers: ["flake.nix", "default.nix", "shell.nix"],
  },

  "lua-language-server": {
    command: "lua-language-server",
    args: [],
    fileTypes: [".lua"],
    rootMarkers: [".luarc.json", ".luarc.jsonc", ".stylua.toml"],
    settings: {
      Lua: {
        runtime: { version: "LuaJIT" },
        diagnostics: { globals: ["vim"] },
        workspace: { checkThirdParty: false },
        telemetry: { enable: false },
      },
    },
  },

  bashls: {
    command: "bash-language-server",
    args: ["start"],
    fileTypes: [".sh", ".bash", ".zsh"],
    rootMarkers: [".git"],
    settings: {
      bashIde: {
        globPattern: "*@(.sh|.inc|.bash|.command)",
        diagnosticsIgnorePatterns: ["**/node_modules"],
      },
    },
  },

  yamlls: {
    command: "yaml-language-server",
    args: ["--stdio"],
    fileTypes: [".yaml", ".yml"],
    rootMarkers: [".git"],
    settings: {
      yaml: {
        validate: true,
        format: { enable: true },
        hover: true,
        completion: true,
        schemaStore: { enable: false },
      },
      redhat: { telemetry: { enabled: false } },
    },
  },

  taplo: {
    command: "taplo",
    args: ["lsp", "stdio"],
    fileTypes: [".toml"],
    rootMarkers: [".taplo.toml", "taplo.toml", ".git"],
  },

  marksman: {
    command: "marksman",
    args: ["server"],
    fileTypes: [".md", ".markdown"],
    rootMarkers: [".marksman.toml", ".git"],
  },

  clangd: {
    command: "clangd",
    args: ["--background-index", "--clang-tidy"],
    fileTypes: [".c", ".cpp", ".cc", ".h", ".hpp"],
    rootMarkers: ["compile_commands.json", "CMakeLists.txt", ".clangd"],
  },

  zls: {
    command: "zls",
    args: [],
    fileTypes: [".zig"],
    rootMarkers: ["build.zig", "build.zig.zon"],
  },

  "sourcekit-lsp": {
    command: "sourcekit-lsp",
    args: [],
    fileTypes: [".swift"],
    rootMarkers: ["Package.swift", "*.xcodeproj", "*.xcworkspace"],
  },

  "slint-lsp": {
    command: "slint-lsp",
    args: [],
    fileTypes: [".slint"],
    rootMarkers: ["Cargo.toml", ".slint"],
  },
};

export interface DetectedServer {
  name: string;
  config: ServerConfig;
  resolvedCommand: string;
}

/**
 * Read `.lsp/servers.json` `{ "disabled": ["nixd", ...] }` from the devcontainer
 * root (git root) when present, else cwd. Servers don't need an `enabled` list —
 * they lazy-start by file extension — so only `disabled` is honored. Mirrors the
 * `.lsp/linters.json` mechanism.
 */
export function readDisabledServers(cwd: string): Set<string> {
  const base = findDevcontainerRoot(cwd) ?? cwd;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(base, ".lsp", "servers.json"), "utf-8")) as {
      disabled?: unknown;
    };
    if (Array.isArray(parsed.disabled)) {
      return new Set(parsed.disabled.filter((n): n is string => typeof n === "string"));
    }
  } catch {
    // no file or parse error
  }
  return new Set();
}

/**
 * Detect which LSP servers are available for a given directory.
 * Checks root markers first, then verifies the binary exists.
 */
export function detectServers(cwd: string): DetectedServer[] {
  const disabled = readDisabledServers(cwd);
  const detected: DetectedServer[] = [];

  for (const [name, config] of Object.entries(KNOWN_SERVERS)) {
    if (disabled.has(name)) continue;
    if (!hasRootMarkers(cwd, config.rootMarkers)) continue;

    // Check if binary exists
    const resolved = resolveCommand(config.command, cwd);
    if (!resolved) continue;

    detected.push({ name, config, resolvedCommand: resolved });
  }

  return detected;
}

/**
 * Find servers that handle a given file extension.
 */
export function serversForFile(filePath: string, detected: DetectedServer[]): DetectedServer[] {
  const ext = path.extname(filePath).toLowerCase();
  return detected.filter((s) => s.config.fileTypes.includes(ext));
}

/**
 * Find a known server for a file extension, ignoring root markers.
 * Used for lazy startup when a file is touched that no detected server handles.
 * Returns null if no server binary is available.
 */
export function findServerByExtension(filePath: string, cwd: string): DetectedServer | null {
  const ext = path.extname(filePath).toLowerCase();
  const disabled = readDisabledServers(cwd);

  for (const [name, config] of Object.entries(KNOWN_SERVERS)) {
    if (!config.fileTypes.includes(ext)) continue;
    if (disabled.has(name)) continue;

    const resolved = resolveCommand(config.command, cwd);
    if (!resolved) continue;

    return { name, config, resolvedCommand: resolved };
  }

  return null;
}
