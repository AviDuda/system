import { describe, expect, test } from "bun:test";
import type { DetectedLinter } from "./linters";
import { biomeOffsetToPosition, KNOWN_LINTERS, lintersForFile, parseBiomeOutput, parseGolangciOutput } from "./linters";

// ── Known linters ──

describe("KNOWN_LINTERS", () => {
  test("has biome", () => {
    expect(KNOWN_LINTERS.biome).toBeDefined();
    expect(KNOWN_LINTERS.biome.command).toBe("biome");
    expect(KNOWN_LINTERS.biome.fileTypes).toContain(".ts");
    expect(KNOWN_LINTERS.biome.rootMarkers).toContain("biome.json");
  });

  test("has golangci-lint", () => {
    expect(KNOWN_LINTERS["golangci-lint"]).toBeDefined();
    expect(KNOWN_LINTERS["golangci-lint"].command).toBe("golangci-lint");
    expect(KNOWN_LINTERS["golangci-lint"].fileTypes).toContain(".go");
  });
});

// ── lintersForFile ──

describe("lintersForFile", () => {
  const detected: DetectedLinter[] = [
    { name: "biome", config: KNOWN_LINTERS.biome, resolvedCommand: "/usr/bin/biome" },
    {
      name: "golangci-lint",
      config: KNOWN_LINTERS["golangci-lint"],
      resolvedCommand: "/usr/bin/golangci-lint",
    },
  ];

  test("matches .ts files to biome", () => {
    expect(lintersForFile("src/main.ts", detected)).toHaveLength(1);
    expect(lintersForFile("src/main.ts", detected)[0].name).toBe("biome");
  });

  test("matches .go files to golangci-lint", () => {
    expect(lintersForFile("cmd/main.go", detected)).toHaveLength(1);
    expect(lintersForFile("cmd/main.go", detected)[0].name).toBe("golangci-lint");
  });

  test("matches .json files to biome", () => {
    expect(lintersForFile("config.json", detected)).toHaveLength(1);
    expect(lintersForFile("config.json", detected)[0].name).toBe("biome");
  });

  test("returns empty for unknown extensions", () => {
    expect(lintersForFile("file.rs", detected)).toHaveLength(0);
  });
});

// ── biomeOffsetToPosition ──

describe("biomeOffsetToPosition", () => {
  test("first line offset", () => {
    const pos = biomeOffsetToPosition("const x = 1;", [5, 6]);
    expect(pos.line).toBe(0);
    expect(pos.column).toBe(5);
  });

  test("second line offset", () => {
    const source = "line one\nline two";
    // "line two" starts at offset 9, 'l' of 'line' on line 1
    const pos = biomeOffsetToPosition(source, [9, 13]);
    expect(pos.line).toBe(1);
    expect(pos.column).toBe(0);
  });

  test("null source returns 0:0", () => {
    const pos = biomeOffsetToPosition(null, [5, 6]);
    expect(pos.line).toBe(0);
    expect(pos.column).toBe(0);
  });

  test("null span returns 0:0", () => {
    const pos = biomeOffsetToPosition("const x = 1;", null);
    expect(pos.line).toBe(0);
    expect(pos.column).toBe(0);
  });
});

// ─�� parseBiomeOutput ─���

describe("parseBiomeOutput", () => {
  test("parses modern biome format (line/column, string message)", () => {
    const output = JSON.stringify({
      diagnostics: [
        {
          category: "lint/correctness/noUnusedVariables",
          severity: "warning",
          message: "This variable unused is unused.",
          location: {
            path: "test.ts",
            start: { line: 5, column: 7 },
            end: { line: 5, column: 13 },
          },
        },
      ],
    });

    const diags = parseBiomeOutput(output, "/tmp/test.ts");
    expect(diags).toHaveLength(1);
    expect(diags[0].source).toBe("biome");
    expect(diags[0].code).toBe("lint/correctness/noUnusedVariables");
    expect(diags[0].severity).toBe(2); // warning
    expect(diags[0].message).toBe("This variable unused is unused.");
    expect(diags[0].range.start.line).toBe(4); // 0-based
    expect(diags[0].range.start.character).toBe(6); // 0-based
  });

  test("parses legacy biome format (span/sourceCode, structured message)", () => {
    const output = JSON.stringify({
      diagnostics: [
        {
          category: "lint/correctness/noUnusedVariables",
          severity: "warning",
          description: "This variable is unused.",
          message: [{ content: "This variable is unused." }],
          location: {
            path: { file: "/tmp/test.ts" },
            span: [6, 7],
            sourceCode: "const x = 1;",
          },
        },
      ],
    });

    const diags = parseBiomeOutput(output, "/tmp/test.ts");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("This variable is unused.");
    expect(diags[0].range.start.line).toBe(0);
    expect(diags[0].range.start.character).toBe(6);
  });

  test("filters to target file only", () => {
    const output = JSON.stringify({
      diagnostics: [
        {
          category: "lint/style/useConst",
          severity: "warning",
          message: "Use const.",
          location: {
            path: "other.ts",
            start: { line: 1, column: 1 },
            end: { line: 1, column: 5 },
          },
        },
      ],
    });

    const diags = parseBiomeOutput(output, "/tmp/test.ts");
    expect(diags).toHaveLength(0);
  });

  test("skips informational diagnostics", () => {
    const output = JSON.stringify({
      diagnostics: [
        {
          category: "info",
          severity: "information",
          message: "Just info.",
          location: {
            path: "test.ts",
            start: { line: 1, column: 1 },
          },
        },
      ],
    });

    const diags = parseBiomeOutput(output, "/tmp/test.ts");
    expect(diags).toHaveLength(0);
  });

  test("handles invalid JSON", () => {
    const diags = parseBiomeOutput("not json", "/tmp/test.ts");
    expect(diags).toHaveLength(0);
  });

  test("maps error severity to 1", () => {
    const output = JSON.stringify({
      diagnostics: [
        {
          category: "parse",
          severity: "error",
          message: "Parse error.",
          location: {
            path: "test.ts",
            start: { line: 1, column: 1 },
          },
        },
      ],
    });

    const diags = parseBiomeOutput(output, "/tmp/test.ts");
    expect(diags[0].severity).toBe(1);
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
