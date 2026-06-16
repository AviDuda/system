import { describe, expect, test } from "bun:test";
import {
  computeBlocked,
  formatClock,
  formatDuration,
  formatMessageStats,
  formatTokens,
  formatTps,
  mergeSpans,
  type Span,
  trendInit,
  trendUpdate,
  trendView,
  unionDuration,
} from "./timing";

describe("mergeSpans", () => {
  test("empty input", () => {
    expect(mergeSpans([])).toEqual([]);
  });

  test("disjoint spans stay separate", () => {
    expect(
      mergeSpans([
        { start: 0, end: 10 },
        { start: 20, end: 30 },
      ]),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
  });

  test("overlapping spans merge", () => {
    expect(
      mergeSpans([
        { start: 0, end: 15 },
        { start: 10, end: 30 },
      ]),
    ).toEqual([{ start: 0, end: 30 }]);
  });

  test("adjacent spans merge", () => {
    expect(
      mergeSpans([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ]),
    ).toEqual([{ start: 0, end: 20 }]);
  });

  test("nested span is absorbed", () => {
    expect(
      mergeSpans([
        { start: 0, end: 100 },
        { start: 20, end: 30 },
      ]),
    ).toEqual([{ start: 0, end: 100 }]);
  });

  test("unsorted input is handled", () => {
    expect(
      mergeSpans([
        { start: 30, end: 40 },
        { start: 0, end: 10 },
        { start: 35, end: 50 },
      ]),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 30, end: 50 },
    ]);
  });

  test("inverted/zero-length spans are dropped", () => {
    expect(
      mergeSpans([
        { start: 10, end: 5 },
        { start: 5, end: 5 },
        { start: 0, end: 10 },
      ]),
    ).toEqual([{ start: 0, end: 10 }]);
  });
});

describe("unionDuration", () => {
  test("sums merged duration without double counting", () => {
    const spans: Span[] = [
      { start: 0, end: 100 },
      { start: 50, end: 150 },
      { start: 300, end: 400 },
    ];
    // merged: [0,150] + [300,400] = 150 + 100 = 250
    expect(unionDuration(spans)).toBe(250);
  });

  test("empty", () => {
    expect(unionDuration([])).toBe(0);
  });
});

describe("computeBlocked", () => {
  test("all wall time covered = no blocking", () => {
    // wall 0..1000, generation covers it fully
    expect(computeBlocked(0, 1000, [{ start: 0, end: 1000 }])).toBe(0);
  });

  test("gap between generation and tool = blocked", () => {
    // wall 0..1000: gen [0,200], tool [800,1000], gap [200,800] = 600 blocked
    expect(
      computeBlocked(0, 1000, [
        { start: 0, end: 200 },
        { start: 800, end: 1000 },
      ]),
    ).toBe(600);
  });

  test("parallel tool spans do not double count", () => {
    // wall 0..1000: gen [0,100], two parallel tools both [100,300], rest blocked
    // active union = [0,100]+[100,300] = 300; blocked = 1000-300 = 700
    expect(
      computeBlocked(0, 1000, [
        { start: 0, end: 100 },
        { start: 100, end: 300 },
        { start: 100, end: 300 },
      ]),
    ).toBe(700);
  });

  test("spans outside the wall are clipped", () => {
    // wall 100..200, span starts before and ends after -> covers whole wall -> blocked 0
    expect(computeBlocked(100, 200, [{ start: 0, end: 1000 }])).toBe(0);
  });

  test("zero wall", () => {
    expect(computeBlocked(0, 0, [{ start: 0, end: 10 }])).toBe(0);
  });

  test("no active spans = all blocked", () => {
    expect(computeBlocked(0, 500, [])).toBe(500);
  });
});

describe("formatDuration", () => {
  test("milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(320)).toBe("320ms");
    expect(formatDuration(999)).toBe("999ms");
  });
  test("sub-10 seconds", () => {
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(9900)).toBe("9.9s");
  });
  test("10-59 seconds", () => {
    expect(formatDuration(10000)).toBe("10s");
    expect(formatDuration(42000)).toBe("42s");
  });
  test("minutes and beyond", () => {
    expect(formatDuration(60000)).toBe("1:00");
    expect(formatDuration(123000)).toBe("2:03");
  });
  test("clamps negative", () => {
    expect(formatDuration(-500)).toBe("0ms");
  });
});

describe("formatClock", () => {
  test("always M:SS", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(14000)).toBe("0:14");
    expect(formatClock(60000)).toBe("1:00");
    expect(formatClock(134000)).toBe("2:14");
  });
});

describe("formatTokens", () => {
  test("under 1k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(480)).toBe("480");
    expect(formatTokens(999)).toBe("999");
  });
  test("1k-10k keeps one decimal", () => {
    expect(formatTokens(5200)).toBe("5.2k");
    expect(formatTokens(9999)).toBe("10.0k");
  });
  test("10k+ rounds", () => {
    expect(formatTokens(12000)).toBe("12k");
    expect(formatTokens(48500)).toBe("49k");
  });
});

describe("formatTps", () => {
  test("normal", () => {
    expect(formatTps(480, 2000)).toBe("240t/s");
    expect(formatTps(100, 1000)).toBe("100t/s");
  });
  test("zero decode window", () => {
    expect(formatTps(480, 0)).toBe("—");
  });
  test("zero tokens", () => {
    expect(formatTps(0, 1000)).toBe("—");
  });
});

describe("formatMessageStats", () => {
  test("full line, no thinking", () => {
    // 480 out over 2.4s output window = 200 t/s
    expect(formatMessageStats(12000, 480, 1200, 2400)).toBe("PP 1.2s · ↑12k/↓480 · 200t/s");
  });

  test("small input keeps raw number", () => {
    expect(formatMessageStats(820, 90, 900, 1000)).toBe("PP 900ms · ↑820/↓90 · 90t/s");
  });

  test("no output window shows dash", () => {
    // output present but outputMs 0 (e.g. prefilled-only / edge) -> no tps
    expect(formatMessageStats(5000, 0, 30000, 0)).toBe("PP 30s · ↑5.0k/↓0 · —");
  });

  test("long prefill formats as clock", () => {
    expect(formatMessageStats(40000, 600, 134000, 3000)).toBe("PP 2:14 · ↑40k/↓600 · 200t/s");
  });

  test("thinking phase is shown when > 1s", () => {
    // outputMs is the FULL window (thinking + answer); 600 out / 5s = 120 t/s.
    expect(formatMessageStats(12000, 600, 1000, 5000, 2500)).toBe("PP 1.0s · ✶2.5s · ↑12k/↓600 · 120t/s");
  });

  test("thinking under 1s is omitted", () => {
    expect(formatMessageStats(12000, 600, 1000, 3000, 900)).toBe("PP 1.0s · ↑12k/↓600 · 200t/s");
  });
});

describe("trend (dual EMA)", () => {
  test("empty state", () => {
    const s = trendInit();
    expect(trendView(s)).toEqual({ value: null, arrow: "" });
  });

  test("warmup: no arrow before TREND_MIN_SAMPLES", () => {
    const s = trendInit();
    trendUpdate(s, 100);
    trendUpdate(s, 100);
    expect(trendView(s).arrow).toBe("");
    expect(trendView(s).value).toBe(100);
  });

  test("stable series shows →", () => {
    const s = trendInit();
    for (let i = 0; i < 20; i++) trendUpdate(s, 200);
    expect(trendView(s).arrow).toBe("→");
    expect(trendView(s).value).toBe(200);
  });

  test("sustained decline crosses threshold to ▼", () => {
    const s = trendInit();
    for (let i = 0; i < 20; i++) trendUpdate(s, 200);
    expect(trendView(s).arrow).toBe("→");
    for (let i = 0; i < 10; i++) trendUpdate(s, 100);
    const v = trendView(s);
    expect(v.arrow).toBe("▼");
    expect(v.value).toBeLessThan(110);
  });

  test("a single off sample (one slow generation) does NOT flip to ▼", () => {
    const s = trendInit();
    for (let i = 0; i < 20; i++) trendUpdate(s, 200);
    trendUpdate(s, 120); // one ~25% slow turn
    expect(trendView(s).arrow).toBe("→");
  });

  test("sustained rise crosses threshold to ▲", () => {
    const s = trendInit();
    for (let i = 0; i < 20; i++) trendUpdate(s, 100);
    for (let i = 0; i < 10; i++) trendUpdate(s, 200);
    const v = trendView(s);
    expect(v.arrow).toBe("▲");
    expect(v.value).toBeGreaterThan(190);
  });

  test("rejects non-finite and negative", () => {
    const s = trendInit();
    trendUpdate(s, 50);
    trendUpdate(s, Number.NaN);
    trendUpdate(s, -10);
    trendUpdate(s, Number.POSITIVE_INFINITY);
    expect(s.count).toBe(1);
    expect(s.fast).toBe(50);
  });

  test("trendInit produces a fresh independent state", () => {
    const a = trendInit();
    trendUpdate(a, 100);
    const b = trendInit();
    expect(trendView(b).value).toBeNull();
    expect(trendView(a).value).toBe(100);
  });
});
