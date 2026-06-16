import { describe, expect, test } from "bun:test";
import { buildRequestBody } from "./kagi";

describe("kagi buildRequestBody", () => {
  test("minimal body is just query + limit", () => {
    expect(buildRequestBody("foo", 10, undefined, undefined)).toEqual({ query: "foo", limit: 10 });
  });

  test("includeDomains maps to lens.sites_included", () => {
    const body = buildRequestBody("foo", 10, { includeDomains: ["docs.python.org", "github.com"] }, undefined);
    expect(body.lens).toEqual({ sites_included: ["docs.python.org", "github.com"] });
  });

  test("excludeDomains maps to lens.sites_excluded", () => {
    const body = buildRequestBody("foo", 10, { excludeDomains: ["pinterest.com"] }, undefined);
    expect(body.lens).toEqual({ sites_excluded: ["pinterest.com"] });
  });

  test("freshness day/week/month maps to lens.time_relative", () => {
    for (const f of ["day", "week", "month"] as const) {
      const body = buildRequestBody("foo", 10, { freshness: f }, undefined);
      expect(body.lens).toEqual({ time_relative: f });
      expect(body.filters).toBeUndefined();
    }
  });

  test("freshness year maps to filters.after (ISO date), not lens.time_relative", () => {
    const body = buildRequestBody("foo", 10, { freshness: "year" }, undefined);
    expect(body.lens).toBeUndefined();
    expect(body.filters).toBeDefined();
    const after = (body.filters as { after: string }).after;
    expect(after).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // "year" should be roughly today minus one year.
    const expected = new Date();
    expected.setFullYear(expected.getFullYear() - 1);
    expect(after).toBe(expected.toISOString().slice(0, 10));
  });

  test("extractCount sets extract.count", () => {
    const body = buildRequestBody("foo", 10, undefined, 3);
    expect(body.extract).toEqual({ count: 3 });
  });

  test("extractCount clamps to 1-10", () => {
    expect(buildRequestBody("foo", 10, undefined, 0).extract).toBeUndefined();
    expect(buildRequestBody("foo", 10, undefined, -2).extract).toBeUndefined();
    expect((buildRequestBody("foo", 10, undefined, 11).extract as { count: number }).count).toBe(10);
  });

  test("combined filters populate lens with all fields", () => {
    const body = buildRequestBody(
      "foo",
      5,
      { freshness: "week", includeDomains: ["a.com"], excludeDomains: ["b.com"] },
      2,
    );
    expect(body.lens).toEqual({
      time_relative: "week",
      sites_included: ["a.com"],
      sites_excluded: ["b.com"],
    });
    expect(body.extract).toEqual({ count: 2 });
    expect(body.filters).toBeUndefined();
  });

  test("empty domain arrays do not create lens entries", () => {
    const body = buildRequestBody("foo", 10, { includeDomains: [], excludeDomains: [] }, undefined);
    expect(body.lens).toBeUndefined();
  });
});
