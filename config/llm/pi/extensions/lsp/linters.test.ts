import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DetectedLinter } from "./linters";
import {
  findLinterByExtension,
  KNOWN_LINTERS,
  lintersForFile,
  parseGolangciOutput,
  readLinterOverrides,
} from "./linters";

// ── Known linters ──

describe("KNOWN_LINTERS", () => {
  test("has golangci-lint", () => {
    expect(KNOWN_LINTERS["golangci-lint"]).toBeDefined();
    expect(KNOWN_LINTERS["golangci-lint"].command).toBe("golangci-lint");
    expect(KNOWN_LINTERS["golangci-lint"].fileTypes).toContain(".go");
  });
});

// ── lintersForFile ──

describe("lintersForFile", () => {
  const detected: DetectedLinter[] = [
    {
      name: "golangci-lint",
      config: KNOWN_LINTERS["golangci-lint"],
      resolvedCommand: "/usr/bin/golangci-lint",
    },
  ];

  test("matches .go files to golangci-lint", () => {
    expect(lintersForFile("cmd/main.go", detected)).toHaveLength(1);
    expect(lintersForFile("cmd/main.go", detected)[0].name).toBe("golangci-lint");
  });

  test("returns empty for unknown extensions", () => {
    expect(lintersForFile("file.rs", detected)).toHaveLength(0);
  });
});

// ── parseGolangciOutput ──

describe("parseGolangciOutput", () => {
  test("parses issue for target file", () => {
    const output = JSON.stringify({
      Issues: [
        {
          FromLinter: "errcheck",
          Text: "Error return value not checked",
          Severity: "warning",
          Pos: {
            Filename: "main.go",
            Line: 10,
            Column: 5,
          },
        },
      ],
    });

    const diags = parseGolangciOutput(output, "/tmp/main.go");
    expect(diags).toHaveLength(1);
    expect(diags[0].source).toBe("golangci-lint");
    expect(diags[0].code).toBe("errcheck");
    expect(diags[0].severity).toBe(2); // warning
    expect(diags[0].range.start.line).toBe(9); // 0-based
    expect(diags[0].range.start.character).toBe(4); // 0-based
  });

  test("filters to target file only", () => {
    const output = JSON.stringify({
      Issues: [
        {
          FromLinter: "errcheck",
          Text: "Error return value not checked",
          Severity: "warning",
          Pos: {
            Filename: "other.go",
            Line: 10,
            Column: 5,
          },
        },
      ],
    });

    const diags = parseGolangciOutput(output, "/tmp/main.go");
    expect(diags).toHaveLength(0);
  });

  test("maps error severity to 1", () => {
    const output = JSON.stringify({
      Issues: [
        {
          FromLinter: "typecheck",
          Text: "undefined: foo",
          Severity: "error",
          Pos: { Filename: "main.go", Line: 1, Column: 1 },
        },
      ],
    });

    const diags = parseGolangciOutput(output, "/tmp/main.go");
    expect(diags[0].severity).toBe(1);
  });

  test("handles invalid JSON", () => {
    const diags = parseGolangciOutput("not json", "/tmp/main.go");
    expect(diags).toHaveLength(0);
  });

  test("handles null Issues", () => {
    const diags = parseGolangciOutput(JSON.stringify({}), "/tmp/main.go");
    expect(diags).toHaveLength(0);
  });
});

describe("findLinterByExtension", () => {
  test("returns null when no root marker is present up the tree (binary alone is not enough)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-lint-"));
    try {
      const file = path.join(tmp, "x.go");
      fs.writeFileSync(file, "");
      // No .golangci.* marker anywhere up the tree → golangci-lint must NOT be
      // detected, even if the binary happens to be on PATH. A globally-installed
      // linter shouldn't fire in a project that doesn't configure it.
      expect(findLinterByExtension(file, tmp)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("readLinterOverrides", () => {
  test("parses enabled + disabled; missing file = empty", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-lint-"));
    try {
      expect(readLinterOverrides(tmp)).toEqual({ enabled: new Set(), disabled: new Set() });
      fs.mkdirSync(path.join(tmp, ".lsp"));
      fs.writeFileSync(
        path.join(tmp, ".lsp", "linters.json"),
        JSON.stringify({ enabled: ["custom"], disabled: ["golangci-lint"], ignored: 1 }),
      );
      expect(readLinterOverrides(tmp)).toEqual({
        enabled: new Set(["custom"]),
        disabled: new Set(["golangci-lint"]),
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("findLinterByExtension overrides", () => {
  test("disabled suppresses a linter even when its marker is present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-lint-"));
    try {
      fs.writeFileSync(path.join(tmp, ".golangci.yml"), ""); // marker present
      fs.mkdirSync(path.join(tmp, ".lsp"));
      fs.writeFileSync(path.join(tmp, ".lsp", "linters.json"), JSON.stringify({ disabled: ["golangci-lint"] }));
      const file = path.join(tmp, "x.go");
      fs.writeFileSync(file, "");
      expect(findLinterByExtension(file, tmp)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
