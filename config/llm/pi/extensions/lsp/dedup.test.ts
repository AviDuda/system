import { describe, expect, test } from "bun:test";
import type { Diagnostic } from "./client";
import { DiagnosticsLedger, diagnosticIdentity } from "./dedup";

function diag(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    source: "ts",
    code: "2322",
    message: "Type 'number' is not assignable to type 'string'",
    ...overrides,
  };
}

describe("diagnosticIdentity", () => {
  test("ignores position — a shifted error is the same error", () => {
    const a = diag({ range: { start: { line: 4, character: 7 }, end: { line: 4, character: 12 } } });
    const b = diag({ range: { start: { line: 9, character: 2 }, end: { line: 9, character: 12 } } });
    expect(diagnosticIdentity(a)).toBe(diagnosticIdentity(b));
  });

  test("distinguishes message, code, source, severity", () => {
    expect(diagnosticIdentity(diag({ message: "a" }))).not.toBe(diagnosticIdentity(diag({ message: "b" })));
    expect(diagnosticIdentity(diag({ code: "1" }))).not.toBe(diagnosticIdentity(diag({ code: "2" })));
    expect(diagnosticIdentity(diag({ source: "ts" }))).not.toBe(diagnosticIdentity(diag({ source: "biome" })));
    expect(diagnosticIdentity(diag({ severity: 1 }))).not.toBe(diagnosticIdentity(diag({ severity: 2 })));
  });
});

describe("DiagnosticsLedger", () => {
  const path = "/work/a.ts";

  test("first report: everything is fresh, nothing unchanged", () => {
    const ledger = new DiagnosticsLedger();
    const { fresh, unchanged } = ledger.reduce(path, [diag(), diag({ message: "other" })]);
    expect(fresh).toHaveLength(2);
    expect(unchanged).toHaveLength(0);
  });

  test("second report: same errors become unchanged, new ones stay fresh", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce(path, [diag(), diag({ message: "old" })]);
    const { fresh, unchanged } = ledger.reduce(path, [diag(), diag({ message: "old" }), diag({ message: "new" })]);
    expect(fresh.map((d) => d.message)).toEqual(["new"]);
    expect(unchanged.map((d) => d.message).sort()).toEqual(["Type 'number' is not assignable to type 'string'", "old"]);
  });

  test("a shifted line still counts as unchanged (position ignored)", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce(path, [diag()]);
    const { fresh, unchanged } = ledger.reduce(path, [
      diag({ range: { start: { line: 20, character: 0 }, end: { line: 20, character: 1 } } }),
    ]);
    expect(fresh).toHaveLength(0);
    expect(unchanged).toHaveLength(1);
  });

  test("going clean forgets the file, so re-appearing errors are fresh", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce(path, [diag()]);
    ledger.reduce(path, []); // clean
    const { fresh, unchanged } = ledger.reduce(path, [diag()]);
    expect(fresh).toHaveLength(1);
    expect(unchanged).toHaveLength(0);
  });

  test("ledger is per-file — one file's errors don't affect another", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce(path, [diag()]);
    const other = ledger.reduce("/work/b.ts", [diag()]);
    expect(other.fresh).toHaveLength(1);
  });

  test("clear forgets everything", () => {
    const ledger = new DiagnosticsLedger();
    ledger.reduce(path, [diag()]);
    ledger.clear();
    const { fresh } = ledger.reduce(path, [diag()]);
    expect(fresh).toHaveLength(1);
  });
});
