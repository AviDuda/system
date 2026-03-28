import { describe, expect, test } from "bun:test";
import {
  createInitialState,
  decide,
  type GateState,
  isBashAllowed,
  isInsideDir,
  isPathAllowed,
  isSensitivePath,
  matchGlob,
  resolveFilePath,
  stripShellPreamble,
  suggestPrefix,
} from "./logic";

// ── stripShellPreamble ──

describe("stripShellPreamble", () => {
  test("passes through simple commands", () => {
    expect(stripShellPreamble("grep -n foo bar.ts")).toBe("grep -n foo bar.ts");
  });

  test("strips cd && prefix", () => {
    expect(stripShellPreamble("cd /foo && grep -n bar")).toBe("grep -n bar");
  });

  test("strips cd ; prefix", () => {
    expect(stripShellPreamble("cd /foo; ls -la")).toBe("ls -la");
  });

  test("strips cd || prefix", () => {
    expect(stripShellPreamble("cd /foo || echo fail")).toBe("echo fail");
  });

  test("strips pushd prefix", () => {
    expect(stripShellPreamble("pushd /tmp && make build")).toBe("make build");
  });

  test("strips multiple cd prefixes", () => {
    expect(stripShellPreamble("cd /foo && cd bar && rg pattern")).toBe("rg pattern");
  });

  test("does not strip non-cd commands before &&", () => {
    expect(stripShellPreamble("echo hello && rm -rf /")).toBe("echo hello && rm -rf /");
  });

  test("handles whitespace", () => {
    expect(stripShellPreamble("  cd /foo  &&  grep bar  ")).toBe("grep bar");
  });
});

// ── suggestPrefix ──

describe("suggestPrefix", () => {
  test("single token command", () => {
    expect(suggestPrefix("ls")).toBe("ls");
  });

  test("two token command", () => {
    expect(suggestPrefix("bun test")).toBe("bun test");
  });

  test("takes first two tokens of longer command", () => {
    expect(suggestPrefix("bun test --filter=pro --watch")).toBe("bun test");
  });

  test("strips cd preamble first", () => {
    expect(suggestPrefix("cd /foo && grep -rn pattern src/")).toBe("grep -rn");
  });
});

// ── isSensitivePath ──

describe("isSensitivePath", () => {
  test(".env is sensitive", () => {
    expect(isSensitivePath(".env")).toBe(true);
  });

  test(".env.local is sensitive", () => {
    expect(isSensitivePath(".env.local")).toBe(true);
  });

  test(".env.production is sensitive", () => {
    expect(isSensitivePath(".env.production")).toBe(true);
  });

  test("nested .env is sensitive", () => {
    expect(isSensitivePath("apps/backend/.env")).toBe(true);
  });

  test(".pem file is sensitive", () => {
    expect(isSensitivePath("certs/server.pem")).toBe(true);
  });

  test(".key file is sensitive", () => {
    expect(isSensitivePath("ssl/private.key")).toBe(true);
  });

  test("secrets directory is sensitive", () => {
    expect(isSensitivePath("secrets/db-password.txt")).toBe(true);
  });

  test("path containing secret is sensitive", () => {
    expect(isSensitivePath("config/my-secret-config.json")).toBe(true);
  });

  test(".ssh directory is sensitive", () => {
    expect(isSensitivePath(".ssh/config")).toBe(true);
  });

  test("id_rsa is sensitive", () => {
    expect(isSensitivePath("id_rsa")).toBe(true);
    expect(isSensitivePath("id_rsa.pub")).toBe(true);
  });

  test("id_ed25519 is sensitive", () => {
    expect(isSensitivePath("id_ed25519")).toBe(true);
  });

  test("regular files are not sensitive", () => {
    expect(isSensitivePath("src/main.ts")).toBe(false);
    expect(isSensitivePath("package.json")).toBe(false);
    expect(isSensitivePath("README.md")).toBe(false);
  });

  test("environment.ts is not sensitive (no dot prefix)", () => {
    expect(isSensitivePath("src/environment.ts")).toBe(false);
  });
});

// ── isInsideDir ──

describe("isInsideDir", () => {
  test("file inside dir", () => {
    expect(isInsideDir("/home/user/project/src/main.ts", "/home/user/project")).toBe(true);
  });

  test("file at dir root", () => {
    expect(isInsideDir("/home/user/project/file.txt", "/home/user/project")).toBe(true);
  });

  test("file outside dir", () => {
    expect(isInsideDir("/home/user/other/file.txt", "/home/user/project")).toBe(false);
  });

  test("parent dir", () => {
    expect(isInsideDir("/home/user/file.txt", "/home/user/project")).toBe(false);
  });
});

// ── matchGlob ──

describe("matchGlob", () => {
  test("exact match", () => {
    expect(matchGlob("src/main.ts", "src/main.ts")).toBe(true);
  });

  test("* matches within directory", () => {
    expect(matchGlob("src/main.ts", "src/*.ts")).toBe(true);
    expect(matchGlob("src/utils.ts", "src/*.ts")).toBe(true);
  });

  test("* does not cross directories", () => {
    expect(matchGlob("src/deep/main.ts", "src/*.ts")).toBe(false);
  });

  test("** matches across directories", () => {
    expect(matchGlob("src/deep/main.ts", "**/*.ts")).toBe(true);
    expect(matchGlob("main.ts", "**/*.ts")).toBe(true);
  });

  test("** at start", () => {
    expect(matchGlob("a/b/c.nix", "**/*.nix")).toBe(true);
  });

  test("specific directory with **", () => {
    expect(matchGlob("config/llm/pi/foo.ts", "config/llm/pi/**")).toBe(true);
    expect(matchGlob("config/llm/pi/sub/bar.ts", "config/llm/pi/**")).toBe(true);
    expect(matchGlob("config/other/foo.ts", "config/llm/pi/**")).toBe(false);
  });

  test("? matches single char", () => {
    expect(matchGlob("src/a.ts", "src/?.ts")).toBe(true);
    expect(matchGlob("src/ab.ts", "src/?.ts")).toBe(false);
  });

  test("no match", () => {
    expect(matchGlob("src/main.js", "src/*.ts")).toBe(false);
  });
});

// ── resolveFilePath ──

describe("resolveFilePath", () => {
  test("strips leading @", () => {
    expect(resolveFilePath("@src/main.ts", "/project")).toBe("/project/src/main.ts");
  });

  test("resolves relative path", () => {
    expect(resolveFilePath("src/main.ts", "/project")).toBe("/project/src/main.ts");
  });

  test("keeps absolute path", () => {
    expect(resolveFilePath("/tmp/file.txt", "/project")).toBe("/tmp/file.txt");
  });
});

// ── isPathAllowed / isBashAllowed ──

describe("isPathAllowed", () => {
  const baseState = createInitialState();

  test("exact path match", () => {
    const state: GateState = { ...baseState, allowedPaths: ["src/main.ts"] };
    expect(isPathAllowed("/project/src/main.ts", "/project", state)).toBe(true);
  });

  test("prefix path match", () => {
    const state: GateState = { ...baseState, allowedPaths: ["src/"] };
    expect(isPathAllowed("/project/src/main.ts", "/project", state)).toBe(true);
    expect(isPathAllowed("/project/src/deep/file.ts", "/project", state)).toBe(true);
  });

  test("glob match", () => {
    const state: GateState = { ...baseState, allowedPathGlobs: ["**/*.nix"], gitRoot: "/project" };
    expect(isPathAllowed("/project/modules/foo.nix", "/project", state)).toBe(true);
    expect(isPathAllowed("/project/modules/foo.ts", "/project", state)).toBe(false);
  });

  test("no match", () => {
    const state: GateState = { ...baseState, allowedPaths: ["src/main.ts"] };
    expect(isPathAllowed("/project/other/file.ts", "/project", state)).toBe(false);
  });
});

describe("isBashAllowed", () => {
  const baseState = createInitialState();

  test("prefix match", () => {
    const state: GateState = { ...baseState, allowedBashPrefixes: ["bun test"] };
    expect(isBashAllowed("bun test --filter=pro", state)).toBe(true);
  });

  test("strips preamble before matching", () => {
    const state: GateState = { ...baseState, allowedBashPrefixes: ["grep -n"] };
    expect(isBashAllowed("cd /foo && grep -n pattern file.ts", state)).toBe(true);
  });

  test("no match", () => {
    const state: GateState = { ...baseState, allowedBashPrefixes: ["bun test"] };
    expect(isBashAllowed("rm -rf /", state)).toBe(false);
  });
});

// ── decide ──

describe("decide", () => {
  const cwd = "/project";

  function stateWith(overrides: Partial<GateState> = {}): GateState {
    return { ...createInitialState(), gitRoot: "/project", ...overrides };
  }

  // Allow-all mode
  test("allow-all passes everything", () => {
    const state = stateWith({ mode: "allow-all" });
    expect(decide("bash", { command: "rm -rf /" }, cwd, state).action).toBe("allow");
    expect(decide("write", { path: "/etc/passwd" }, cwd, state).action).toBe("allow");
  });

  // Read-only tools
  test("read-only tools always allowed", () => {
    const state = stateWith({ mode: "careful" });
    expect(decide("read", { path: "src/main.ts" }, cwd, state).action).toBe("allow");
    expect(decide("grep", { pattern: "foo" }, cwd, state).action).toBe("allow");
    expect(decide("find", { path: "." }, cwd, state).action).toBe("allow");
    expect(decide("ls", { path: "." }, cwd, state).action).toBe("allow");
  });

  // Careful mode
  test("careful: write in project needs confirmation", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("write", { path: "src/main.ts" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("write");
  });

  test("careful: write outside project needs confirmation", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("write", { path: "/tmp/file.txt" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("write");
  });

  test("careful: sensitive file gets sensitive confirmation", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("write", { path: ".env" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("sensitive");
  });

  test("careful: bash needs confirmation", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("bash", { command: "echo hello" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("bash");
  });

  test("careful: bash with prefix allowed", () => {
    const state = stateWith({ mode: "careful", allowedBashPrefixes: ["echo"] });
    expect(decide("bash", { command: "echo hello" }, cwd, state).action).toBe("allow");
  });

  test("careful: allowed path passes", () => {
    const state = stateWith({ mode: "careful", allowedPaths: ["src/main.ts"] });
    expect(decide("write", { path: "src/main.ts" }, cwd, state).action).toBe("allow");
  });

  test("careful: allowed glob passes", () => {
    const state = stateWith({ mode: "careful", allowedPathGlobs: ["**/*.nix"] });
    expect(decide("edit", { path: "modules/foo.nix" }, cwd, state).action).toBe("allow");
  });

  // Trust project mode
  test("trust-project: write in project allowed", () => {
    const state = stateWith({ mode: "trust-project" });
    expect(decide("write", { path: "src/main.ts" }, cwd, state).action).toBe("allow");
  });

  test("trust-project: write outside project needs confirmation", () => {
    const state = stateWith({ mode: "trust-project" });
    const d = decide("write", { path: "/tmp/file.txt" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("outside-project");
  });

  test("trust-project: sensitive file in project still confirms", () => {
    const state = stateWith({ mode: "trust-project" });
    const d = decide("write", { path: ".env" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("sensitive");
  });

  test("trust-project: bash still confirms", () => {
    const state = stateWith({ mode: "trust-project" });
    const d = decide("bash", { command: "npm install" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("bash");
  });

  // Tool overrides
  test("tool override allows tool but still checks sensitive", () => {
    const state = stateWith({ mode: "careful", toolOverrides: { edit: "allow" } });
    expect(decide("edit", { path: "src/main.ts" }, cwd, state).action).toBe("allow");

    const d = decide("edit", { path: ".env" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("sensitive");
  });

  test("tool override does not affect other tools", () => {
    const state = stateWith({ mode: "careful", toolOverrides: { edit: "allow" } });
    const d = decide("write", { path: "src/main.ts" }, cwd, state);
    expect(d.action).toBe("confirm");
  });

  // Bash prefix suggestion
  test("bash decision includes suggested prefix", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("bash", { command: "cd /foo && bun test --filter=pro" }, cwd, state);
    expect(d.suggestedPrefix).toBe("bun test");
  });

  // Sensitive path allowed via session allow
  test("sensitive file allowed if in allowedPaths", () => {
    const state = stateWith({ mode: "careful", allowedPaths: [".env"] });
    expect(decide("write", { path: ".env" }, cwd, state).action).toBe("allow");
  });
});
