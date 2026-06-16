import { describe, expect, test } from "bun:test";
import { buildRequestBody } from "./zai";

describe("zai buildRequestBody", () => {
  test("minimal body has search-prime engine + query", () => {
    expect(buildRequestBody("foo", undefined, undefined)).toEqual({
      search_engine: "search-prime",
      search_query: "foo",
    });
  });

  test("limit maps to count", () => {
    expect(buildRequestBody("foo", 20, undefined).count).toBe(20);
  });

  test("freshness maps to search_recency_filter", () => {
    expect(buildRequestBody("foo", undefined, { freshness: "day" }).search_recency_filter).toBe("oneDay");
    expect(buildRequestBody("foo", undefined, { freshness: "week" }).search_recency_filter).toBe("oneWeek");
    expect(buildRequestBody("foo", undefined, { freshness: "month" }).search_recency_filter).toBe("oneMonth");
    expect(buildRequestBody("foo", undefined, { freshness: "year" }).search_recency_filter).toBe("oneYear");
  });

  test("includeDomains takes only the first domain (z.ai whitelist is a single string)", () => {
    const body = buildRequestBody("foo", undefined, { includeDomains: ["a.com", "b.com"] });
    expect(body.search_domain_filter).toBe("a.com");
  });

  test("excludeDomains is a no-op (not present in body)", () => {
    const body = buildRequestBody("foo", undefined, { excludeDomains: ["spam.com"] });
    expect(body.search_domain_filter).toBeUndefined();
    expect(body).not.toHaveProperty("sites_excluded");
  });

  test("combined freshness + domain", () => {
    const body = buildRequestBody("foo", 5, { freshness: "month", includeDomains: ["docs.foo.com"] });
    expect(body).toEqual({
      search_engine: "search-prime",
      search_query: "foo",
      count: 5,
      search_recency_filter: "oneMonth",
      search_domain_filter: "docs.foo.com",
    });
  });
});
