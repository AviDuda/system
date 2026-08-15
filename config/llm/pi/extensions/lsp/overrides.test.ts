import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPathOverrides, matchPathOverride } from "./overrides";

function mkConfig(config: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ovr-"));
  fs.mkdirSync(path.join(dir, ".lsp"));
  fs.writeFileSync(path.join(dir, ".lsp", "config.json"), config);
  return dir;
}

describe("loadPathOverrides", () => {
  test("reads paths from .lsp/config.json", () => {
    const dir = mkConfig(JSON.stringify({ paths: { "generated/*.sqlinc": "sqls" } }));
    expect(loadPathOverrides(dir).paths).toEqual({ "generated/*.sqlinc": "sqls" });
  });

  test("absent config → empty", () => {
    expect(loadPathOverrides(fs.mkdtempSync(path.join(os.tmpdir(), "ovr-"))).paths).toEqual({});
  });

  test("non-object paths → empty", () => {
    expect(loadPathOverrides(mkConfig('{"paths": 42}')).paths).toEqual({});
  });

  test("malformed json → empty", () => {
    expect(loadPathOverrides(mkConfig("{nope")).paths).toEqual({});
  });
});

describe("matchPathOverride", () => {
  test("glob matches the absolute path", () => {
    const overrides = { paths: { "**/*.sqlinc": "sqls" } };
    expect(matchPathOverride("/work/x/generated/a.sqlinc", overrides)).toBe("sqls");
    expect(matchPathOverride("/work/x/generated/a.sql", overrides)).toBeNull();
  });

  test("first match wins in insertion order", () => {
    const overrides = { paths: { "**/*.a": "serverA", "**/*.b": "serverB" } };
    expect(matchPathOverride("/x/f.b", overrides)).toBe("serverB");
  });

  test("empty paths → null", () => {
    expect(matchPathOverride("/x/f.b", { paths: {} })).toBeNull();
  });
});
