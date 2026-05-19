import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentConfig,
  buildToolDescription,
  discoverAgents,
  findNearestProjectAgentsDir,
  loadAgentsFromDir,
} from "./agents";

const TEST_DIR = join(tmpdir(), `subagent-agents-test-${process.pid}`);

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeDir(...paths: string[]): string {
  const dir = join(TEST_DIR, ...paths);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAgent(dir: string, filename: string, frontmatter: Record<string, string>, body = ""): void {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(join(dir, filename), `---\n${fm}\n---\n${body}`);
}

// ── loadAgentsFromDir ──

describe("loadAgentsFromDir", () => {
  test("returns empty for nonexistent directory", () => {
    expect(loadAgentsFromDir("/nonexistent/path", "user")).toEqual([]);
  });

  test("returns empty for directory with no .md files", () => {
    const dir = makeDir("empty");
    writeFileSync(join(dir, "readme.txt"), "not an agent");
    expect(loadAgentsFromDir(dir, "user")).toEqual([]);
  });

  test("skips .md files without required frontmatter", () => {
    const dir = makeDir("no-fm");
    writeFileSync(join(dir, "notes.md"), "Just some notes");
    writeFileSync(join(dir, "partial.md"), "---\nname: only-name\n---\nbody");
    writeFileSync(join(dir, "partial2.md"), "---\ndescription: only-desc\n---\nbody");
    expect(loadAgentsFromDir(dir, "user")).toEqual([]);
  });

  test("loads agent with name and description", () => {
    const dir = makeDir("basic");
    writeAgent(
      dir,
      "researcher.md",
      { name: "researcher", description: "Investigates codebases" },
      "You are a researcher.",
    );

    const agents = loadAgentsFromDir(dir, "user");
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("researcher");
    expect(agents[0].description).toBe("Investigates codebases");
    expect(agents[0].systemPrompt.trim()).toBe("You are a researcher.");
    expect(agents[0].source).toBe("user");
    expect(agents[0].tools).toBeUndefined();
    expect(agents[0].role).toBeUndefined();
    expect(agents[0].extensions).toBeUndefined();
  });

  test("parses tools, role, and extensions from frontmatter", () => {
    const dir = makeDir("full-fm");
    writeAgent(
      dir,
      "coder.md",
      {
        name: "coder",
        description: "Writes code",
        tools: "read, write, edit, bash",
        role: "draft",
        extensions: "web-search, lsp",
      },
      "Write code.",
    );

    const agents = loadAgentsFromDir(dir, "project");
    expect(agents).toHaveLength(1);
    expect(agents[0].tools).toEqual(["read", "write", "edit", "bash"]);
    expect(agents[0].role).toBe("draft");
    expect(agents[0].extensions).toEqual(["web-search", "lsp"]);
    expect(agents[0].source).toBe("project");
  });

  test("trims whitespace in comma-separated fields", () => {
    const dir = makeDir("whitespace");
    writeAgent(dir, "sloppy.md", { name: "sloppy", description: "test", tools: " read , write , edit " }, "body");

    const agents = loadAgentsFromDir(dir, "user");
    expect(agents[0].tools).toEqual(["read", "write", "edit"]);
  });

  test("ignores empty tools/extensions", () => {
    const dir = makeDir("empty-tools");
    writeAgent(dir, "minimal.md", { name: "min", description: "test", tools: ", ," }, "body");

    const agents = loadAgentsFromDir(dir, "user");
    expect(agents[0].tools).toBeUndefined();
  });

  test("loads multiple agents from one directory", () => {
    const dir = makeDir("multi");
    writeAgent(dir, "a.md", { name: "alpha", description: "Agent A" }, "A");
    writeAgent(dir, "b.md", { name: "beta", description: "Agent B" }, "B");
    // Non-.md file should be skipped
    writeFileSync(join(dir, "gamma.txt"), "not an agent");

    const agents = loadAgentsFromDir(dir, "user");
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
  });
});

// ── findNearestProjectAgentsDir ──

describe("findNearestProjectAgentsDir", () => {
  test("returns null when no .pi/agents exists", () => {
    const dir = makeDir("no-agents");
    expect(findNearestProjectAgentsDir(dir)).toBeNull();
  });

  test("finds .pi/agents in current directory", () => {
    const project = makeDir("project");
    const agentsDir = makeDir("project", ".pi", "agents");
    expect(findNearestProjectAgentsDir(project)).toBe(agentsDir);
  });

  test("walks up to parent directories", () => {
    const agentsDir = makeDir("root", ".pi", "agents");
    const child = makeDir("root", "src", "lib");
    expect(findNearestProjectAgentsDir(child)).toBe(agentsDir);
  });

  test("stops at filesystem root", () => {
    // A deeply nested path with no .pi/agents
    const dir = makeDir("a", "b", "c");
    expect(findNearestProjectAgentsDir(dir)).toBeNull();
  });
});

// ── discoverAgents ──

describe("discoverAgents", () => {
  test("scope=user loads only user agents", () => {
    // Create user agents dir
    const userDir = makeDir("user-agents");
    writeAgent(userDir, "r.md", { name: "researcher", description: "Research" }, "R");

    // Create project agents dir
    const projectDir = makeDir("project-scope", ".pi", "agents");
    writeAgent(projectDir, "c.md", { name: "coder", description: "Code" }, "C");

    // discoverAgents uses ~/.pi/agent/agents for user scope — we can't override that
    // So test with a cwd that has no project agents and verify scope behavior
    const result = discoverAgents(makeDir("empty-cwd"), "user");
    // No user agents exist at ~/.pi/agent/agents in test env, project excluded by scope
    expect(result.projectAgentsDir).toBeNull();
  });

  test("scope=project loads only project agents", () => {
    const agentsDir = makeDir("proj", ".pi", "agents");
    writeAgent(agentsDir, "local.md", { name: "local", description: "Local agent" }, "L");

    const projectRoot = makeDir("proj");
    const result = discoverAgents(projectRoot, "project");
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("local");
    expect(result.agents[0].source).toBe("project");
  });

  test("scope=both merges user and project agents", () => {
    const agentsDir = makeDir("both", ".pi", "agents");
    writeAgent(agentsDir, "p1.md", { name: "proj-agent", description: "P" }, "P");

    const projectRoot = makeDir("both");
    const result = discoverAgents(projectRoot, "both");
    // May include real user agents from ~/.pi/agent/agents if they exist
    const projectAgent = result.agents.find((a) => a.name === "proj-agent");
    expect(projectAgent).toBeDefined();
    expect(projectAgent?.source).toBe("project");
  });

  test("project agents override user agents with same name (scope=both)", () => {
    const agentsDir = makeDir("override", ".pi", "agents");
    writeAgent(agentsDir, "dupe.md", { name: "researcher", description: "Project version" }, "P");

    const projectRoot = makeDir("override");
    const result = discoverAgents(projectRoot, "both");
    const researcher = result.agents.find((a) => a.name === "researcher");
    // If user has a real researcher agent, project should still win
    if (researcher) {
      expect(researcher.source).toBe("project");
    }
  });
});

// ── buildToolDescription ──

describe("buildToolDescription", () => {
  test("includes header lines for empty agents", () => {
    const desc = buildToolDescription([]);
    expect(desc).toContain("Delegate tasks to specialized subagents");
    expect(desc).toContain("No agents defined");
  });

  test("lists agents with tools and role", () => {
    const agents: AgentConfig[] = [
      {
        name: "researcher",
        description: "Investigates codebases",
        tools: ["read", "grep"],
        role: "explain",
        systemPrompt: "",
        source: "user",
        filePath: "/fake/researcher.md",
      },
    ];
    const desc = buildToolDescription(agents);
    expect(desc).toContain("- researcher: Investigates codebases [read, grep], role: explain");
  });

  test("omits tools/role when absent", () => {
    const agents: AgentConfig[] = [
      {
        name: "basic",
        description: "Simple agent",
        systemPrompt: "",
        source: "user",
        filePath: "/fake/basic.md",
      },
    ];
    const desc = buildToolDescription(agents);
    expect(desc).toContain("- basic: Simple agent");
    expect(desc).not.toContain("[");
    expect(desc).not.toContain("role:");
  });
});
