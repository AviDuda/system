/**
 * LSP server configurations and auto-detection.
 *
 * Server configs adapted from oh-my-pi's defaults.json.
 * Auto-detection: checks root markers in cwd, then verifies binary is on PATH.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ServerConfig } from "./client";
import { hasRootMarkers, resolveCommand } from "./client";

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
      bashIde: { globPattern: "*@(.sh|.inc|.bash|.command)" },
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
};

export interface DetectedServer {
  name: string;
  config: ServerConfig;
  resolvedCommand: string;
}

/**
 * Detect which LSP servers are available for a given directory.
 * Checks root markers first, then verifies the binary exists.
 */
export function detectServers(cwd: string): DetectedServer[] {
  const detected: DetectedServer[] = [];

  for (const [name, config] of Object.entries(KNOWN_SERVERS)) {
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

  for (const [name, config] of Object.entries(KNOWN_SERVERS)) {
    if (!config.fileTypes.includes(ext)) continue;

    const resolved = resolveCommand(config.command, cwd);
    if (!resolved) continue;

    return { name, config, resolvedCommand: resolved };
  }

  return null;
}
