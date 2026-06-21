import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TAGS,
  expandPattern,
  findCompliantFromList,
  getAvailableTags,
  getModelTags,
  loadPolicies,
  loadProviderTags,
  type ModelLike,
  modelComplies,
  readEnabledModels,
  writePolicies,
} from "./policy";

// ── Helpers ──────────────────────────────────────────────────────────────────

function model(provider: string, id: string): ModelLike {
  return { provider, id };
}

// ── getModelTags ─────────────────────────────────────────────────────────────

describe("getModelTags", () => {
  test("returns provider tags when known", () => {
    const tags = new Map([["omlx", ["local"]]]);
    expect(getModelTags(model("omlx", "qwen"), tags)).toEqual(["local"]);
  });

  test("returns DEFAULT_TAGS for unknown provider", () => {
    const tags = new Map<string, string[]>();
    expect(getModelTags(model("unknown", "model"), tags)).toEqual(DEFAULT_TAGS);
  });

  test("returns multiple tags", () => {
    const tags = new Map([["openrouter", ["zdr", "cloud"]]]);
    expect(getModelTags(model("openrouter", "x"), tags)).toEqual(["zdr", "cloud"]);
  });
});

// ── modelComplies ────────────────────────────────────────────────────────────

describe("modelComplies", () => {
  const tags = new Map([
    ["omlx", ["local"]],
    ["openrouter", ["zdr", "cloud"]],
    ["zai", ["cloud"]],
  ]);

  test("complies when model has one required tag (local)", () => {
    const policy = { requireTags: ["local", "zdr"] };
    expect(modelComplies(model("omlx", "qwen"), policy, tags)).toBe(true);
  });

  test("complies when model has one required tag (zdr)", () => {
    const policy = { requireTags: ["local", "zdr"] };
    expect(modelComplies(model("openrouter", "ds"), policy, tags)).toBe(true);
  });

  test("does not comply when model has none of the required tags", () => {
    const policy = { requireTags: ["local", "zdr"] };
    expect(modelComplies(model("zai", "glm"), policy, tags)).toBe(false);
  });

  test("empty requireTags matches nothing (no policy = unrestricted)", () => {
    const policy = { requireTags: [] as string[] };
    expect(modelComplies(model("omlx", "qwen"), policy, tags)).toBe(false);
  });

  test("complies with single tag requirement", () => {
    const policy = { requireTags: ["cloud"] };
    expect(modelComplies(model("zai", "glm"), policy, tags)).toBe(true);
    expect(modelComplies(model("omlx", "qwen"), policy, tags)).toBe(false);
  });
});

// ── findCompliantFromList ────────────────────────────────────────────────────

describe("findCompliantFromList", () => {
  const tags = new Map([
    ["omlx", ["local"]],
    ["openrouter", ["zdr", "cloud"]],
    ["zai", ["cloud"]],
  ]);
  const policy = { requireTags: ["local", "zdr"] };

  test("returns first compliant model", () => {
    const models = [model("zai", "glm"), model("omlx", "qwen"), model("openrouter", "ds")];
    expect(findCompliantFromList(models, policy, tags)).toEqual(model("omlx", "qwen"));
  });

  test("returns undefined when no models comply", () => {
    const models = [model("zai", "glm"), model("zai", "glm-2")];
    expect(findCompliantFromList(models, policy, tags)).toBeUndefined();
  });

  test("returns undefined for empty list", () => {
    expect(findCompliantFromList([], policy, tags)).toBeUndefined();
  });
});

// ── expandPattern ────────────────────────────────────────────────────────────

describe("expandPattern", () => {
  const available = [model("omlx", "qwen"), model("omlx", "gemma"), model("openrouter", "ds"), model("zai", "glm")];

  test("exact match", () => {
    expect(expandPattern("omlx/qwen", available)).toEqual([model("omlx", "qwen")]);
  });

  test("wildcard match returns all models for provider", () => {
    expect(expandPattern("omlx/*", available)).toEqual([model("omlx", "qwen"), model("omlx", "gemma")]);
  });

  test("no match returns empty", () => {
    expect(expandPattern("omlx/nonexistent", available)).toEqual([]);
  });

  test("provider not found returns empty", () => {
    expect(expandPattern("missing/*", available)).toEqual([]);
  });

  test("malformed pattern (no slash) returns empty", () => {
    expect(expandPattern("badpattern", available)).toEqual([]);
  });

  test("model id with slash matches correctly", () => {
    const models = [model("openrouter", "deepseek/deepseek-v4-flash")];
    expect(expandPattern("openrouter/deepseek/deepseek-v4-flash", models)).toEqual([
      model("openrouter", "deepseek/deepseek-v4-flash"),
    ]);
  });
});

// ── File-based config loading ────────────────────────────────────────────────

describe("loadProviderTags", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "model-policy-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads tags from models.json", () => {
    writeFileSync(
      join(tmpDir, "models.json"),
      JSON.stringify({
        providers: {
          omlx: { tags: ["local"], models: [] },
          openrouter: { tags: ["zdr", "cloud"], models: [] },
        },
      }),
    );
    const tags = loadProviderTags(tmpDir);
    expect(tags.get("omlx")).toEqual(["local"]);
    expect(tags.get("openrouter")).toEqual(["zdr", "cloud"]);
  });

  test("defaults to DEFAULT_TAGS when tags field missing", () => {
    writeFileSync(
      join(tmpDir, "models.json"),
      JSON.stringify({
        providers: {
          zai: { models: [] },
        },
      }),
    );
    const tags = loadProviderTags(tmpDir);
    expect(tags.get("zai")).toEqual(DEFAULT_TAGS);
  });

  test("returns empty map when models.json missing", () => {
    const tags = loadProviderTags(tmpDir);
    expect(tags.size).toBe(0);
  });

  test("returns empty map on parse error", () => {
    writeFileSync(join(tmpDir, "models.json"), "not json");
    const tags = loadProviderTags(tmpDir);
    expect(tags.size).toBe(0);
  });
});

describe("loadPolicies", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "model-policy-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads policies from model-policies.json", () => {
    writeFileSync(
      join(tmpDir, "model-policies.json"),
      JSON.stringify({
        policies: {
          "/some/project": { requireTags: ["local", "zdr"], comment: "test" },
        },
      }),
    );
    const policies = loadPolicies(tmpDir);
    expect(policies["/some/project"]).toEqual({
      requireTags: ["local", "zdr"],
      comment: "test",
    });
  });

  test("returns empty when file missing", () => {
    expect(loadPolicies(tmpDir)).toEqual({});
  });

  test("returns empty on parse error", () => {
    writeFileSync(join(tmpDir, "model-policies.json"), "bad");
    expect(loadPolicies(tmpDir)).toEqual({});
  });
});

describe("readEnabledModels", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "model-policy-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads enabledModels from settings.json", () => {
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ enabledModels: ["claude-*", "omlx/*"] }));
    expect(readEnabledModels(tmpDir)).toEqual(["claude-*", "omlx/*"]);
  });

  test("returns empty when file missing", () => {
    expect(readEnabledModels(tmpDir)).toEqual([]);
  });

  test("returns empty when enabledModels not set", () => {
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark" }));
    expect(readEnabledModels(tmpDir)).toEqual([]);
  });
});

describe("getAvailableTags", () => {
  test("returns unique sorted tags", () => {
    const tags = new Map([
      ["omlx", ["local"]],
      ["openrouter", ["zdr", "cloud"]],
      ["zai", ["cloud"]],
    ]);
    expect(getAvailableTags(tags)).toEqual(["cloud", "local", "zdr"]);
  });

  test("returns empty for empty map", () => {
    expect(getAvailableTags(new Map())).toEqual([]);
  });
});

describe("writePolicies", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "model-policy-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes policies to model-policies.json", () => {
    const policies = {
      "/some/project": { requireTags: ["local", "zdr"], comment: "test" },
    };
    writePolicies(tmpDir, policies);
    const content = JSON.parse(readFileSync(join(tmpDir, "model-policies.json"), "utf-8"));
    expect(content.policies).toEqual(policies);
  });

  test("overwrites existing file", () => {
    writeFileSync(
      join(tmpDir, "model-policies.json"),
      JSON.stringify({ policies: { old: { requireTags: ["cloud"] } } }),
    );
    const policies = { "/new": { requireTags: ["local"] } };
    writePolicies(tmpDir, policies);
    const content = JSON.parse(readFileSync(join(tmpDir, "model-policies.json"), "utf-8"));
    expect(content.policies).toEqual(policies);
  });
});
