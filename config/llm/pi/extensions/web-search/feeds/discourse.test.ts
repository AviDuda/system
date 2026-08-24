import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  categoryPath,
  classify,
  cookedToText,
  type DiscoursePost,
  type DiscourseTopic,
  discourseProvider,
  jsonUrlFor,
  loadDiscourseAuth,
  matches,
  mergePosts,
  paginationUrlFor,
  renderCategoryList,
  renderDiscourse,
  resolveKeySpec,
  topicPath,
} from "./discourse";

describe("matches", () => {
  test("accepts topic URLs with slug and id", () => {
    expect(matches("https://discourse.nixos.org/t/some-topic/79490")).toBe(true);
  });

  test("accepts bare /t/<id>", () => {
    expect(matches("https://forum.example.com/t/123")).toBe(true);
  });

  test("accepts post-anchor suffix", () => {
    expect(matches("https://forum.example.com/t/slug/42/15")).toBe(true);
  });

  test("ignores query and fragment", () => {
    expect(matches("https://forum.example.com/t/slug/42?page=3#x")).toBe(true);
  });

  test("rejects non-topic paths", () => {
    expect(matches("https://forum.example.com/u/someone")).toBe(false);
    expect(matches("https://forum.example.com/c/general")).toBe(false);
  });

  test("accepts category URLs", () => {
    expect(matches("https://forum.example.org/c/7/l/latest?board=default")).toBe(true);
    expect(matches("https://forum.example.org/c/project-x/21?ascending=false&order=posts")).toBe(true);
    expect(matches("https://forum.example.org/c/parent/child/33/l/top")).toBe(true);
  });

  test("rejects slug-only category paths (no id)", () => {
    expect(matches("https://forum.example.com/c/general/l/latest")).toBe(false);
  });

  test("rejects non-http", () => {
    expect(matches("ftp://forum.example.com/t/slug/42")).toBe(false);
  });
});

describe("classify / categoryPath / json URLs", () => {
  test("classifies topic vs category", () => {
    expect(classify("https://f.io/t/s/1")).toBe("topic");
    expect(classify("https://f.io/t/s/1/5")).toBe("topic");
    expect(classify("https://f.io/c/7/l/latest")).toBe("category");
    expect(classify("https://f.io/c/x/21?order=posts")).toBe("category");
  });

  test("categoryPath keeps filter, strips query", () => {
    expect(categoryPath("https://forum.example.org/c/7/l/latest?board=default")).toBe("/c/7/l/latest");
    expect(categoryPath("https://forum.example.org/c/project-x/21?ascending=false")).toBe("/c/project-x/21");
  });

  test("category json URL preserves order/ascending, drops the rest", () => {
    const url = jsonUrlFor("https://forum.example.org/c/project-x/21?ascending=false&order=posts&board=default");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/c/project-x/21.json");
    expect(parsed.searchParams.get("extras")).toBe("excerpts");
    expect(parsed.searchParams.get("order")).toBe("posts");
    expect(parsed.searchParams.get("ascending")).toBe("false");
    expect(parsed.searchParams.get("board")).toBe(null);
  });

  test("paginationUrlFor json-ifies a more_topics_url with its query", () => {
    const url = new URL(paginationUrlFor("https://f.io", "/c/x/8/l/latest?page=1"));
    expect(url.pathname).toBe("/c/x/8/l/latest.json");
    expect(url.searchParams.get("extras")).toBe("excerpts");
    expect(url.searchParams.get("page")).toBe("1");
  });
});

describe("topicPath / json URL", () => {
  test("strips query, fragment, and post anchor", () => {
    expect(topicPath("https://forum.example.com/t/slug/42/15?page=3#x")).toBe("/t/slug/42");
  });

  test("keeps bare id form", () => {
    expect(topicPath("https://forum.example.com/t/42")).toBe("/t/42");
  });

  test("json URL appends .json on the canonical path", () => {
    expect(jsonUrlFor("https://forum.example.com/t/slug/42/15?page=3")).toBe(
      "https://forum.example.com/t/slug/42.json",
    );
  });
});

describe("resolveKeySpec", () => {
  test("runs a !command and returns trimmed stdout", () => {
    expect(resolveKeySpec("!echo key123")).toBe("key123");
  });

  test("refuses raw (non-command) values", () => {
    expect(resolveKeySpec("raw-secret-value")).toBeNull();
  });

  test("null on failing command", () => {
    expect(resolveKeySpec("!exit 3")).toBeNull();
  });

  test("null on empty stdout", () => {
    expect(resolveKeySpec("!printf ''")).toBeNull();
  });
});

describe("loadDiscourseAuth", () => {
  const dir = mkdtempSync(join(tmpdir(), "discourse-auth-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("parses entries, null on missing file", () => {
    const f = join(dir, "keys.json");
    writeFileSync(f, JSON.stringify({ "a.example": { apiKey: "!echo k", apiUsername: "u" } }));
    expect(loadDiscourseAuth(f)?.["a.example"]?.apiKey).toBe("!echo k");
    expect(loadDiscourseAuth(join(dir, "missing.json"))).toBeNull();
  });

  test("null on malformed JSON", () => {
    const f = join(dir, "bad.json");
    writeFileSync(f, "{nope");
    expect(loadDiscourseAuth(f)).toBeNull();
  });
});

describe("cookedToText", () => {
  test("keeps code blocks as fences", () => {
    expect(cookedToText('<p>before</p><pre><code class="lang-nix">x = 1;</code></pre>')).toBe(
      "before\n\n```\nx = 1;\n```",
    );
  });

  test("newlines for block ends, dashes for list items", () => {
    expect(cookedToText("<p>a</p><ul><li>b</li><li>c</li></ul>")).toBe("a\n- b\n- c");
  });

  test("decodes entities and drops inline tags", () => {
    expect(cookedToText("<p>a &amp; b &lt;= <b>c</b></p>")).toBe("a & b <= c");
  });

  test("onebox link cards collapse to a single link line", () => {
    const onebox =
      '<aside class="onebox"><header class="source"><a href="https://fz.com">fz.com</a></header>' +
      '<article class="onebox-body"><h3><a href="https://fz.com/post">Some Post</a></h3>' +
      "<div><div><p>preview noise</p></div></div></article></aside>";
    expect(cookedToText(onebox)).toBe("[Some Post](https://fz.com/post)");
  });

  test("trailing whitespace and blank-line runs are collapsed", () => {
    expect(cookedToText("<p>a</p>\u00a0\u00a0<br>  \n\n\n<p>b</p>")).toBe("a\n\nb");
  });
});

describe("mergePosts", () => {
  test("dedupes by post_number keeping first", () => {
    const posts = [
      { post_number: 1, username: "a", cooked: "x" },
      { post_number: 2, username: "b", cooked: "y" },
      { post_number: 1, username: "a", cooked: "x-dupe" },
    ] as DiscoursePost[];
    expect(mergePosts(posts).map((p) => p.post_number)).toEqual([1, 2]);
  });
});

describe("renderDiscourse", () => {
  const topic: DiscourseTopic = {
    title: "Multiverse thread",
    posts_count: 4,
    tags: ["rust", { name: "nix", slug: "nix" }],
    post_stream: {
      stream: [1, 2, 3, 4],
      posts: [
        { post_number: 1, username: "alice", cooked: "<p>root one</p>", score: 10 },
        {
          post_number: 2,
          username: "bob",
          cooked: "<p>reply to one</p>",
          score: 3,
          reply_to_post_number: 1,
        },
        {
          post_number: 3,
          username: "carol",
          cooked: "<p>reply to the reply</p>",
          reply_to_post_number: 2,
        },
        { post_number: 4, username: "dave", cooked: "<p>second root</p>", score: 0 },
      ],
    },
  };

  test("renders posts chronologically with reply markers instead of nesting", () => {
    const md = renderDiscourse(topic, "forum.example.com", 4);
    const lines = md.split("\n");
    expect(lines[0]).toBe("# Multiverse thread");
    expect(md).toContain("Tags: #rust #nix");
    const iAlice = lines.findIndex((l) => l.includes("alice"));
    const iBob = lines.findIndex((l) => l.includes("bob"));
    const iCarol = lines.findIndex((l) => l.includes("carol"));
    const iDave = lines.findIndex((l) => l.includes("dave"));
    expect(iAlice).toBeGreaterThan(-1);
    expect(iBob).toBe(iAlice + 1); // post order preserved, no reordering into trees
    expect(iCarol).toBe(iBob + 1);
    expect(iDave).toBe(iCarol + 1);
    expect(lines[iBob]).toMatch(/^- /); // no physical indentation
    expect(lines[iCarol]).toMatch(/^- /);
  });

  test("shows reply marker and score", () => {
    const md = renderDiscourse(topic, "forum.example.com", 4);
    expect(md).toContain("(#2, 3 pts, ↩ #1)");
  });

  test("notes unfetched posts when rendered < total", () => {
    const md = renderDiscourse(topic, "forum.example.com", 2);
    expect(md).toContain("2 more posts not fetched");
  });
});

describe("renderCategoryList", () => {
  const topics = [
    {
      id: 1,
      title: "Direct topic",
      slug: "direct-topic",
      posts_count: 3,
      category_id: 21,
      last_posted_at: "2026-08-20T10:00:00Z",
    },
    {
      id: 2,
      title: "Subcategory topic",
      slug: "sub-topic",
      posts_count: 12,
      category_id: 7,
      tags: [{ name: "urgent", slug: "urgent" }, "draft"],
      excerpt: "<p>about the <b>quarterly rollout</b></p>",
      pinned: true,
    },
    { id: 1, title: "dupe", slug: "d", posts_count: 9 },
  ];

  test("tags subcategory topics, dedupes, marks pinned, excerpts as one line", () => {
    const md = renderCategoryList(topics, "f.io", "General", false, {
      listingId: 21,
      nameOf: (id) => (id === 7 ? "beta-board" : undefined),
    });
    const lines = md.split("\n");
    expect(lines[0]).toBe("# General (category)");
    expect(md).toContain("**Direct topic** (3 posts, last 2026-08-20) — /t/direct-topic/1");
    expect(md).toContain("**Subcategory topic** (12 posts, in beta-board, #urgent #draft, pinned) — /t/sub-topic/2");
    expect(md).toContain("about the quarterly rollout");
    expect(md).not.toContain("dupe");
  });

  test("falls back to category id when the name map misses", () => {
    const md = renderCategoryList(topics, "f.io", "General", false, { listingId: 21 });
    expect(md).toContain("in category 7");
  });

  test("notes truncation", () => {
    const md = renderCategoryList(topics.slice(0, 1), "f.io", "X", true);
    expect(md).toContain("list truncated");
  });
});

describe("discourseProvider.fetch (categories)", () => {
  // Key mocks by pathname + sorted params so param ORDER never decides a match.
  function key(url: string): string {
    const u = new URL(url);
    const params = [...u.searchParams.entries()]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return `${u.pathname}?${params}`;
  }
  function ctxWith(pages: Record<string, { status: number; text: string }>) {
    const http = async (url: string) => pages[key(url)] ?? { status: 404, text: "" };
    return { httpFetch: http } as never as Parameters<typeof discourseProvider.fetch>[1];
  }

  const page1 = {
    topic_list: {
      topics: [
        { id: 1, title: "T1", slug: "t1", posts_count: 2, category_id: 7 },
        { id: 2, title: "T2", slug: "t2", posts_count: 5 },
      ],
      more_topics_url: "/c/x/21/l/latest?page=1",
    },
  };
  const page2 = {
    topic_list: { topics: [{ id: 3, title: "T3", slug: "t3", posts_count: 1 }] },
  };
  const siteJson = {
    categories: [
      { id: 21, name: "General" },
      { id: 7, name: "beta-board" },
    ],
  };

  test("paginates via more_topics_url, resolves names via site.json", async () => {
    const ctx = ctxWith({
      [key("https://f.io/c/x/21.json?extras=excerpts")]: { status: 200, text: JSON.stringify(page1) },
      [key("https://f.io/c/x/21/l/latest.json?extras=excerpts&page=1")]: {
        status: 200,
        text: JSON.stringify(page2),
      },
      [key("https://f.io/site.json")]: { status: 200, text: JSON.stringify(siteJson) },
    });
    const res = await discourseProvider.fetch("https://f.io/c/x/21", ctx);
    expect(res.title).toBe("General");
    expect(res.content).toContain("T3");
    expect(res.content).toContain("in beta-board");
    expect(res.content).not.toContain("list truncated");
  });

  test("403 without key returns the gated note for categories too", async () => {
    const ctx = ctxWith({
      [key("https://f.io/c/x/21.json?extras=excerpts")]: { status: 403, text: "" },
    });
    const res = await discourseProvider.fetch("https://f.io/c/x/21", ctx);
    expect(res.title).toBe("Login-gated Discourse");
  });

  test("site.json failure degrades to Category <id> without tags", async () => {
    const ctx = ctxWith({
      [key("https://f.io/c/x/21.json?extras=excerpts")]: { status: 200, text: JSON.stringify(page2) },
      [key("https://f.io/site.json")]: { status: 500, text: "" },
    });
    const res = await discourseProvider.fetch("https://f.io/c/x/21", ctx);
    expect(res.title).toBe("Category 21");
  });
});

describe("discourseProvider.fetch (topics)", () => {
  function ctxWith(pages: Record<string, { status: number; text: string }>): {
    ctx: Parameters<typeof discourseProvider.fetch>[1];
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      ctx: {
        httpFetch: async (url: string) => {
          calls.push(url);
          return pages[url] ?? { status: 404, text: "" };
        },
      },
    };
  }

  const page1: DiscourseTopic = {
    title: "T",
    posts_count: 3,
    post_stream: {
      stream: [1, 2, 3],
      posts: [
        { post_number: 1, username: "a", cooked: "<p>one</p>" },
        { post_number: 2, username: "b", cooked: "<p>two</p>" },
      ],
    },
  };
  const page2: DiscourseTopic = {
    ...page1,
    post_stream: {
      stream: [1, 2, 3],
      posts: [{ post_number: 3, username: "c", cooked: "<p>three</p>" }],
    },
  };

  test("paginates until stream is covered", async () => {
    const { ctx, calls } = ctxWith({
      "https://f.example/t/s/1.json": { status: 200, text: JSON.stringify(page1) },
      "https://f.example/t/s/1.json?page=2": { status: 200, text: JSON.stringify(page2) },
    });
    const res = await discourseProvider.fetch("https://f.example/t/s/1", ctx);
    expect(res.title).toBe("T");
    expect(res.content).toContain("three");
    expect(calls).toHaveLength(2);
  });

  test("returns actionable note on 403 without key", async () => {
    const { ctx } = ctxWith({ "https://f.example/t/s/1.json": { status: 403, text: "" } });
    const res = await discourseProvider.fetch("https://f.example/t/s/1", ctx);
    expect(res.title).toBe("Login-gated Discourse");
    expect(res.content).toContain("discourse-keys.json");
    expect(res.content).toContain("op --account");
  });

  test("throws on non-200 (lets tryFeed fall back to HTML)", async () => {
    const { ctx } = ctxWith({ "https://f.example/t/s/1.json": { status: 500, text: "" } });
    expect(discourseProvider.fetch("https://f.example/t/s/1", ctx)).rejects.toThrow("HTTP 500");
  });

  test("keeps partial posts when a later page fails", async () => {
    const { ctx } = ctxWith({
      "https://f.example/t/s/1.json": { status: 200, text: JSON.stringify(page1) },
      "https://f.example/t/s/1.json?page=2": { status: 500, text: "" },
    });
    const res = await discourseProvider.fetch("https://f.example/t/s/1", ctx);
    expect(res.content).toContain("two");
    expect(res.content).toContain("1 more posts not fetched");
  });
});
