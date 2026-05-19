/**
 * Agent discovery — parse .md agent definitions from user and project directories.
 *
 * Pure fs/path logic, no pi imports. Testable with temp directories.
 *
 * Agent .md files use YAML frontmatter:
 *   ---
 *   name: researcher
 *   description: Investigate codebases
 *   tools: read,grep,find,ls,web_search,web_fetch
 *   role: explain
 *   extensions: web-search
 *   ---
 *   System prompt body...
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  role?: string; // resolves to model from roles.json at runtime
  extensions?: string[];
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

function parseFrontmatter<T extends Record<string, string>>(
  content: string,
): {
  frontmatter: T;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {} as T, body: content };

  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const eqIndex = line.indexOf(":");
    if (eqIndex > 0) {
      const key = line.slice(0, eqIndex).trim();
      const value = line.slice(eqIndex + 1).trim();
      fm[key] = value;
    }
  }

  return { frontmatter: fm as T, body: match[2] };
}

export function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) return agents;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const role = frontmatter.role;
    const extensions = frontmatter.extensions
      ?.split(",")
      .map((e) => e.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      role: role || undefined,
      extensions: extensions && extensions.length > 0 ? extensions : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

export function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* skip */
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function discoverAgents(cwd: string, scope: "user" | "project" | "both"): AgentDiscoveryResult {
  const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, AgentConfig>();

  if (scope === "both") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  } else if (scope === "user") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
  } else {
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  }

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
export function buildToolDescription(agents: AgentConfig[]): string {
  const lines = [
    "Delegate tasks to specialized subagents with isolated context windows.",
    "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
    'Default agent scope is "user" (from ~/.pi/agent/agents).',
    'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
  ];

  if (agents.length > 0) {
    lines.push("");
    lines.push("Available agents:");
    for (const a of agents) {
      const role = a.role ? `, role: ${a.role}` : "";
      const tools = a.tools ? ` [${a.tools.join(", ")}]` : "";
      lines.push(`- ${a.name}: ${a.description}${tools}${role}`);
    }
  } else {
    lines.push("No agents defined. Add .md files to ~/.pi/agent/agents/");
  }

  return lines.join("\n");
}
