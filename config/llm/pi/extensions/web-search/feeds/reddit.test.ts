import { describe, expect, test } from "bun:test";
import { matches, normalizeUrl, renderReddit } from "./reddit";

describe("matches", () => {
  test("accepts www thread URLs", () => {
    expect(matches("https://www.reddit.com/r/rust/comments/1rxbygj/some_slug/")).toBe(true);
  });

  test("accepts old.reddit and new.reddit (normalize later)", () => {
    expect(matches("https://old.reddit.com/r/MacOSBeta/comments/1no1dqv/fix/")).toBe(true);
    expect(matches("https://new.reddit.com/r/rust/comments/abc/title/")).toBe(true);
  });

  test("accepts a bare subdomain and a slugless URL", () => {
    expect(matches("https://reddit.com/r/x/comments/abc/")).toBe(true);
    expect(matches("https://www.reddit.com/r/x/comments/abc")).toBe(true);
  });

  test("rejects non-thread reddit URLs", () => {
    expect(matches("https://www.reddit.com/r/rust/")).toBe(false);
    expect(matches("https://www.reddit.com/user/someone")).toBe(false);
    expect(matches("https://example.com/r/rust/comments/abc/x/")).toBe(false);
  });
});

describe("normalizeUrl", () => {
  test("rewrites old.reddit to www, strips query + fragment", () => {
    expect(normalizeUrl("https://old.reddit.com/r/x/comments/abc/slug/?sort=top#bottom")).toBe(
      "https://www.reddit.com/r/x/comments/abc/slug/",
    );
  });

  test("leaves www URLs as-is aside from query/fragment", () => {
    expect(normalizeUrl("https://www.reddit.com/r/x/comments/abc/slug/?raw_json=1")).toBe(
      "https://www.reddit.com/r/x/comments/abc/slug/",
    );
  });

  test("handles slugless trailing forms", () => {
    expect(normalizeUrl("https://reddit.com/r/x/comments/abc")).toBe("https://www.reddit.com/r/x/comments/abc");
  });
});

describe("renderReddit", () => {
  // Minimal but representative: a post with selftext + a 2-level comment chain.
  const thread = [
    {
      kind: "Listing",
      data: {
        children: [
          {
            kind: "t3",
            data: {
              title: "Which clippy lints?",
              subreddit: "rust",
              author: "op",
              score: 14,
              num_comments: 2,
              link_flair_text: "help",
              selftext: "Starting a new project.",
            },
          },
        ],
      },
    },
    {
      kind: "Listing",
      data: {
        children: [
          {
            kind: "t1",
            data: {
              author: "alice",
              body: "Top-level reply.",
              score: 30,
              replies: {
                data: {
                  children: [{ kind: "t1", data: { author: "bob", body: "Nested.", score: 5 } }],
                },
              },
            },
          },
          { kind: "t1", data: { author: "carol", body: "Second.", score: 3 } },
        ],
      },
    },
  ];

  test("renders post title, meta, flair, selftext", () => {
    const out = renderReddit(thread);
    expect(out).toContain("# Which clippy lints?");
    expect(out).toContain("r/rust · u/op · 14 points · 2 comments");
    expect(out).toContain("*help*");
    expect(out).toContain("Starting a new project.");
    expect(out).toContain("## Comments");
  });

  test("preserves nesting via indentation", () => {
    const out = renderReddit(thread);
    const lines = out.split("\n");
    const aliceIdx = lines.findIndex((l) => l.includes("u/alice"));
    const bobIdx = lines.findIndex((l) => l.includes("u/bob"));
    expect(aliceIdx).toBeGreaterThan(-1);
    expect(bobIdx).toBeGreaterThan(aliceIdx);
    // alice is top-level (0 indent), bob is nested (2 spaces)
    expect(lines[aliceIdx].startsWith("- ")).toBe(true);
    expect(lines[bobIdx].startsWith("  - ")).toBe(true);
  });

  test("includes scores", () => {
    const out = renderReddit(thread);
    expect(out).toContain("(30 pts)");
    expect(out).toContain("(5 pts)");
  });

  test("indents multi-line bodies so they stay in their bullet", () => {
    const multi = [
      { kind: "Listing", data: { children: [] } },
      {
        kind: "Listing",
        data: {
          children: [
            {
              kind: "t1",
              data: {
                author: "x",
                body: "line one\nline two",
                score: 1,
                replies: { data: { children: [{ kind: "t1", data: { author: "y", body: "nested", score: 1 } }] } },
              },
            },
          ],
        },
      },
    ];
    const out = renderReddit(multi);
    const lines = out.split("\n");
    const oneIdx = lines.findIndex((l) => l.includes("line one"));
    expect(lines[oneIdx + 1]).toBe("  line two"); // continuation at 2-space indent
    expect(lines[oneIdx + 2].startsWith("  - ")).toBe(true); // reply at same indent
  });

  test("handles deleted author + missing body", () => {
    const deleted = [
      { kind: "Listing", data: { children: [] } },
      {
        kind: "Listing",
        data: {
          children: [{ kind: "t1", data: { author: null, body: null, score: -1 } }],
        },
      },
    ];
    const out = renderReddit(deleted);
    expect(out).toContain("u/[deleted]");
    expect(out).toContain("[no body]");
  });

  test("skips 'more' placeholders but notes the count", () => {
    const withMore = [
      { kind: "Listing", data: { children: [] } },
      {
        kind: "Listing",
        data: {
          children: [
            { kind: "more", data: { count: 42, children: ["a", "b"] } },
            { kind: "t1", data: { author: "z", body: "ok", score: 1 } },
          ],
        },
      },
    ];
    const out = renderReddit(withMore);
    expect(out).toContain("[…42 more collapsed]");
    expect(out).toContain("u/z");
  });
});
