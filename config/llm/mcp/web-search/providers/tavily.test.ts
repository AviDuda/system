import { describe, expect, test } from "bun:test";
import { buildRequestBody } from "./tavily";

describe("tavily buildRequestBody", () => {
  test("applies agent-grade defaults (advanced + chunks_per_source=3 + max_results=10)", () => {
    expect(buildRequestBody("foo", undefined, undefined)).toEqual({
      query: "foo",
      search_depth: "advanced",
      chunks_per_source: 3,
      max_results: 10,
    });
  });

  test("explicit limit overrides the default max_results", () => {
    expect(buildRequestBody("foo", 5, undefined).max_results).toBe(5);
  });

  test("limit clamps to Tavily's 1-20 range", () => {
    expect(buildRequestBody("foo", 0, undefined).max_results).toBe(1);
    expect(buildRequestBody("foo", 99, undefined).max_results).toBe(20);
  });

  test("freshness maps to time_range (native enum, no remapping needed)", () => {
    for (const f of ["day", "week", "month", "year"] as const) {
      expect(buildRequestBody("foo", undefined, { freshness: f }).time_range).toBe(f);
    }
  });

  test("includeDomains maps to include_domains (native array)", () => {
    const body = buildRequestBody("foo", undefined, { includeDomains: ["a.com", "b.com"] });
    expect(body.include_domains).toEqual(["a.com", "b.com"]);
  });

  test("excludeDomains maps to exclude_domains (native array)", () => {
    const body = buildRequestBody("foo", undefined, { excludeDomains: ["spam.com"] });
    expect(body.exclude_domains).toEqual(["spam.com"]);
  });

  test("combined filters populate all three fields", () => {
    const body = buildRequestBody("foo", 5, {
      freshness: "month",
      includeDomains: ["a.com"],
      excludeDomains: ["b.com"],
    });
    expect(body).toEqual({
      query: "foo",
      search_depth: "advanced",
      chunks_per_source: 3,
      max_results: 5,
      time_range: "month",
      include_domains: ["a.com"],
      exclude_domains: ["b.com"],
    });
  });

  test("empty domain arrays do not create body entries", () => {
    const body = buildRequestBody("foo", undefined, { includeDomains: [], excludeDomains: [] });
    expect(body).not.toHaveProperty("include_domains");
    expect(body).not.toHaveProperty("exclude_domains");
  });

  test("no include_raw_content emitted (full-page extraction belongs on /extract)", () => {
    const body = buildRequestBody("foo", 5, undefined);
    expect(body).not.toHaveProperty("include_raw_content");
  });
});
