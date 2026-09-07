/**
 * Discourse feed provider — fetches topic JSON and renders the post tree.
 *
 * Why: Discourse virtualizes its post list — beyond ~20 posts, older posts are
 * not in the DOM at all, so the HTML scrape silently loses them. The topic
 * `.json` endpoint carries every post (first 20 inline, rest via ?page=N).
 * Works on any host (Discourse self-hosts on arbitrary domains), detected by
 * the /t/<slug>/<id> URL shape.
 *
 * Auth: optional per-host key from ~/.config/llm/discourse-keys.json. No raw
 * secrets on disk — the apiKey value is a "!command" string (pi models.json
 * convention) whose stdout is the key, 1Password-backed like pi.nix:
 *   { "forum.example.com": {
 *       "apiKey": "!op --account <account> read 'op://<vault>/discourse-forum-example/api-key'",
 *       "apiUsername": "name" } }
 * Values without "!" are refused (treated as unset) so a raw key never silently
 * lands in the file. Without an entry, public forums still work (anonymous
 * .json). A login-gated forum without a key returns an actionable note instead
 * of a login-wall scrape.
 *
 * Transport: httpFetch only — no browser needed, works on browser-less hosts.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FeedContext, FeedProvider, FeedResult } from "./types";

// ── URL handling ──

/** Topic URL: /t/<slug>/<id> with optional trailing post number. */
const TOPIC_RE = /^https?:\/\/[^/]+\/t\/(?:[^/]+\/)?\d+(?:\/\d+)?/i;

/** Category URL: /c/ with one or more slugs then the id, optional /l/<filter>. */
const CATEGORY_RE = /^https?:\/\/[^/]+\/c\/(?:[a-z0-9-]+\/)*\d+(?:\/l\/[a-z0-9-]+)?/i;

export function matches(url: string): boolean {
  const noQuery = url.split(/[?#]/)[0];
  return TOPIC_RE.test(noQuery) || CATEGORY_RE.test(noQuery);
}

export type DiscourseKind = "topic" | "category";

/** Which listing a URL points at. Topic unless it matches the category shape. */
export function classify(url: string): DiscourseKind {
  return CATEGORY_RE.test(url.split(/[?#]/)[0]) ? "category" : "topic";
}

/** Canonical topic path (/t/<slug>/<id> or /t/<id>), query/fragment/post-anchor stripped. */
export function topicPath(url: string): string {
  const noQuery = url.split(/[?#]/)[0];
  const m = noQuery.match(/^https?:\/\/[^/]+(\/t\/(?:[^/]+\/)?\d+)/i);
  return m ? m[1] : noQuery.replace(/\/+$/, "");
}

/** Canonical category path (/c/.../<id>[/l/<filter>]), query stripped. */
export function categoryPath(url: string): string {
  const noQuery = url.split(/[?#]/)[0];
  const m = noQuery.match(/^(?:https?:\/\/[^/]+)?(\/c\/(?:[a-z0-9-]+\/)*\d+(?:\/l\/[a-z0-9-]+)?)/i);
  return m ? m[1] : noQuery.replace(/\/+$/, "");
}

export function jsonUrlFor(url: string): string {
  const origin = `https://${new URL(url).hostname}`;
  if (classify(url) === "category") {
    const path = categoryPath(url);
    return `${origin}${path.endsWith("/") ? path.slice(0, -1) : path}.json?${categoryQuery(url).toString()}`;
  }
  const path = topicPath(url);
  return `${origin}${path.endsWith("/") ? path.slice(0, -1) : path}.json`;
}

/** Turn a relative more_topics_url ("/c/x/8/l/latest?page=1") into its .json form. */
export function paginationUrlFor(origin: string, moreTopicsUrl: string): string {
  const [path, query = ""] = moreTopicsUrl.split("?");
  const params = new URLSearchParams(query);
  params.set("extras", "excerpts");
  return `${origin}${path.replace(/\/+$/, "")}.json?${params.toString()}`;
}

/** Query params meaningful to a category listing that must survive the .json rewrite. */
const CATEGORY_QUERY_PARAMS = ["order", "ascending"];

function categoryQuery(url: string): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of new URL(url).searchParams) {
    if (CATEGORY_QUERY_PARAMS.includes(k)) params.set(k, v);
  }
  params.set("extras", "excerpts");
  return params;
}

// ── Auth (optional, per-host) ──

interface DiscourseAuthEntry {
  /** "!command" whose stdout is the API key. Raw values are refused. */
  apiKey: string;
  apiUsername?: string;
}

const AUTH_FILE = join(homedir(), ".config", "llm", "discourse-keys.json");
let authCache: Record<string, DiscourseAuthEntry> | null | undefined;

/** Load per-host auth entries from a JSON file. Missing/malformed file → null. */
export function loadDiscourseAuth(path: string): Record<string, DiscourseAuthEntry> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, DiscourseAuthEntry>;
  } catch {
    return null;
  }
}

/** Run a "!command" key spec and return its trimmed stdout. Null if not a
 * command spec, or the command fails — never returns the raw file value. */
export function resolveKeySpec(spec: string): string | null {
  if (!spec.startsWith("!")) return null;
  try {
    const out = execSync(spec.slice(1), { encoding: "utf8", timeout: 5000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function authHeadersFor(url: string): Record<string, string> {
  if (authCache === undefined) authCache = loadDiscourseAuth(AUTH_FILE);
  const entry = authCache?.[new URL(url).hostname];
  if (!entry?.apiKey) return {};
  const key = resolveKeySpec(entry.apiKey);
  if (!key) return {};
  return { "User-Api-Key": key, "User-Api-Username": entry.apiUsername ?? "" };
}

// ── JSON shape ──

export interface DiscoursePost {
  post_number: number;
  username: string;
  cooked: string;
  score?: number;
  reply_to_post_number?: number | null;
  /** ISO timestamp of post creation (topic JSON always provides it). */
  created_at?: string;
  /** ISO timestamp of the last edit; differs from created_at only when edited. */
  updated_at?: string;
  /** True on the community-confirmed solution (Solved plugin), else false/absent. */
  accepted_answer?: boolean;
}

export interface DiscourseTopic {
  title: string;
  posts_count: number;
  tags?: (string | { name?: string; slug?: string })[];
  post_stream: { stream: number[]; posts: DiscoursePost[] };
}

// ── Category-list JSON shape ──

export interface CategoryTopic {
  id: number;
  title: string;
  slug: string;
  posts_count: number;
  category_id?: number;
  /** String tags (older Discourse) or tag objects (newer). */
  tags?: (string | { name?: string; slug?: string })[];
  last_posted_at?: string;
  excerpt?: string;
  pinned?: boolean;
  closed?: boolean;
}

export interface CategoryList {
  topic_list: {
    per_page?: number;
    more_topics_url?: string;
    topics: CategoryTopic[];
  };
}

export interface CategoryRef {
  id: number;
  name: string;
  slug?: string;
  subcategory_list?: CategoryRef[];
}

// ── Pure rendering ──

/** Convert Discourse cooked HTML to plain text (code blocks kept as fences). */
export function cookedToText(cooked: string): string {
  const text = cooked
    // Onebox link-preview cards → single "[title](url)" line (their div soup
    // otherwise renders as whitespace noise).
    .replace(/<aside[^>]*class="[^"]*\bonebox\b[^"]*"[^>]*>([\s\S]*?)<\/aside>/gi, (_m, inner: string) => {
      const link =
        inner.match(/<h3[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i) ??
        inner.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!link) return "";
      const label = link[2].replace(/<[^>]+>/g, "").trim() || "link";
      return `<p>[${label}](${link[1]})</p>`;
    })
    // Lightbox meta ("image650×454 8.19 KB") is display chrome, not content.
    .replace(/<div[^>]*class="[^"]*\bmeta\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "")
    // Lightbox anchors wrap content images; keep the image, drop the wrapper
    // (its href is the full-size version of the img src). Stray </a> is
    // removed by the generic tag strip below.
    .replace(/<a[^>]*class="[^"]*\blightbox\b[^"]*"[^>]*>/gi, "")
    // Images → markdown placeholders (src, alt, dimensions). Without this
    // they vanish entirely; screenshots/gifs in posts are real content.
    .replace(/<img[^>]*>/gi, (img) => {
      if (/class="[^"]*\bavatar/.test(img)) return "";
      if (/class="[^"]*\bemoji\b/.test(img)) return img.match(/\balt="([^"]*)"/)?.[1] ?? "";
      const src = img.match(/\bsrc="([^"]*)"/)?.[1];
      if (!src) return "";
      const alt = img.match(/\balt="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"') || "image";
      const w = img.match(/\bwidth="(\d+)"/)?.[1];
      const h = img.match(/\bheight="(\d+)"/)?.[1];
      const dims = w && h ? `|${w}x${h}` : "";
      return `\n![${alt}${dims}](${src})\n`;
    })
    // Inline links → markdown, so hrefs survive the tag strip (oneboxes are
    // handled above; this covers normal links). Fragment-only hrefs are
    // heading anchors (Discourse <a name href="#...">) — keep just the text.
    .replace(/<a\s[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m: string, href: string, inner: string) => {
      if (href.startsWith("#")) return inner;
      const label = inner.replace(/<[^>]+>/g, "").trim() || href;
      return `[${label}](${href})`;
    })
    .replace(/<pre[^>]*>\s*<code[^>]*>/gi, "\n```\n")
    .replace(/<\/code>\s*<\/pre>/gi, "\n```\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(?:p|div|li|blockquote|h[1-6]|tr|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Trim trailing whitespace per line; collapse whitespace-only line runs.
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .reduce<string[]>((acc, l) => {
      if (l === "" && acc[acc.length - 1] === "") return acc;
      acc.push(l);
      return acc;
    }, [])
    .join("\n")
    .replace(/^\n+/, "")
    .trim();
}

/** Dedupe posts by post_number (page overlap safety), keep first occurrence order. */
export function mergePosts(posts: DiscoursePost[]): DiscoursePost[] {
  const seen = new Set<number>();
  return posts.filter((p) => {
    if (seen.has(p.post_number)) return false;
    seen.add(p.post_number);
    return true;
  });
}

/** Render a topic to markdown: posts in chronological order, each reply
 * carrying an explicit "↩ #N" marker instead of physical indentation (deep
 * Discourse chains make indentation unreadable and hide late replies to early
 * posts mid-document). */
export function renderDiscourse(topic: DiscourseTopic, host: string, renderedCount: number): string {
  const posts = mergePosts(topic.post_stream.posts).sort((a, b) => a.post_number - b.post_number);

  const lines: string[] = [`# ${topic.title}`, ""];
  const meta = [host, `${topic.posts_count} posts`, `${renderedCount} rendered`];
  lines.push(meta.join(" · "));
  const tags = tagNames(topic.tags);
  if (tags.length > 0) lines.push(`Tags: ${tags.map((tag) => `#${tag}`).join(" ")}`);
  lines.push("", "---", "", "## Posts", "");

  for (const p of posts) {
    const score = Math.round(p.score ?? 0);
    const reply = p.reply_to_post_number != null ? `, ↩ #${p.reply_to_post_number}` : "";
    const date = postDate(p.created_at);
    const edited = postEdited(p.created_at, p.updated_at);
    const accepted = p.accepted_answer ? ", ✓ accepted" : "";
    lines.push(
      `- **${p.username}** (#${p.post_number}${date}${edited}, ${score} pts${reply}${accepted}): ${cookedToText(p.cooked)}`,
    );
  }

  if (renderedCount < topic.posts_count) {
    lines.push("", `[... ${topic.posts_count - renderedCount} more posts not fetched]`);
  }
  return lines.join("\n").trim();
}

/** Tag names from either tag shape (string or {name,slug} object). */
export function tagNames(tags: (string | { name?: string; slug?: string })[] | undefined): string[] {
  return (tags ?? [])
    .map((t) => (typeof t === "string" ? t : (t.name ?? t.slug)))
    .filter((t): t is string => Boolean(t));
}

/** Post creation date as YYYY-MM-DD, or "" when the post has no timestamp. */
export function postDate(createdAt: string | undefined): string {
  const day = createdAt?.slice(0, 10);
  return day ? `, ${day}` : "";
}

/** ", edited YYYY-MM-DD" when the post was edited on a later day, else "". */
export function postEdited(createdAt: string | undefined, updatedAt: string | undefined): string {
  if (!createdAt || !updatedAt || updatedAt.slice(0, 10) <= createdAt.slice(0, 10)) return "";
  return `, edited ${updatedAt.slice(0, 10)}`;
}

/** Render a category topic list: one bullet per topic with its /t/ path (the
 * URL to fetch next), posts count, subcategory tag (parent listings include
 * subcategory topics), tags, last activity, and excerpt. */
export function renderCategoryList(
  topics: CategoryTopic[],
  host: string,
  listingName: string,
  truncated: boolean,
  opts: { listingId?: number; nameOf?: (id: number) => string | undefined } = {},
): string {
  const lines: string[] = [`# ${listingName} (category)`, ""];
  const meta = [host, `${topics.length} topics listed`];
  lines.push(meta.join(" · "), "");

  const seen = new Set<number>();
  for (const t of topics) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const parts = [`${t.posts_count} posts`];
    if (t.category_id != null && t.category_id !== opts.listingId) {
      parts.push(`in ${opts.nameOf?.(t.category_id) ?? `category ${t.category_id}`}`);
    }
    const tags = tagNames(t.tags);
    if (tags.length > 0) parts.push(tags.map((tag) => `#${tag}`).join(" "));
    if (t.pinned) parts.push("pinned");
    if (t.closed) parts.push("closed");
    if (t.last_posted_at) parts.push(`last ${t.last_posted_at.slice(0, 10)}`);
    lines.push(`- **${t.title}** (${parts.join(", ")}) — /t/${t.slug}/${t.id}`);
    if (t.excerpt) {
      const excerpt = cookedToText(t.excerpt).replace(/\n+/g, " ").slice(0, 280);
      if (excerpt) lines.push(`  ${excerpt}${t.excerpt.length > 280 ? "…" : ""}`);
    }
  }

  if (truncated) lines.push("", "[... more topics available — list truncated]");
  return lines.join("\n").trim();
}

// ── Provider ──

const MAX_PAGES = 50;
const MAX_CATEGORY_PAGES = 3;

type HttpFetch = NonNullable<FeedContext["httpFetch"]>;

export const discourseProvider: FeedProvider = {
  matches,
  async fetch(url, ctx: FeedContext): Promise<FeedResult> {
    const http = ctx.httpFetch;
    if (!http) throw new Error("discourse: no httpFetch transport");
    return classify(url) === "category" ? fetchCategory(url, http) : fetchTopic(url, http);
  },
};

async function fetchTopic(url: string, http: HttpFetch): Promise<FeedResult> {
  const headers = authHeadersFor(url);
  const jsonUrl = jsonUrlFor(url);

  const first = await http(jsonUrl, { headers });
  const denied = gatedNote(url, first.status);
  if (denied) return denied;
  if (first.status !== 200) throw new Error(`discourse: topic JSON returned HTTP ${first.status}`);
  const topic = JSON.parse(first.text) as DiscourseTopic;

  // Pagination: first response carries ~20 posts; stream lists all post ids.
  // ?page=N on the topic JSON (verified; the ids[] param is ignored by some
  // instances). Failures keep what we have rather than losing the feed.
  let posts = topic.post_stream.posts;
  const total = topic.post_stream.stream?.length ?? posts.length;
  let page = 2;
  while (posts.length < total && page <= MAX_PAGES) {
    try {
      const r = await http(`${jsonUrl}${jsonUrl.includes("?") ? "&" : "?"}page=${page}`, { headers });
      if (r.status !== 200) break;
      const more = (JSON.parse(r.text) as DiscourseTopic).post_stream?.posts ?? [];
      if (more.length === 0) break;
      posts = posts.concat(more);
      page++;
    } catch {
      break;
    }
  }
  topic.post_stream.posts = posts;

  return {
    url,
    title: topic.title,
    content: renderDiscourse(topic, new URL(url).hostname, posts.length),
  };
}

async function fetchCategory(url: string, http: HttpFetch): Promise<FeedResult> {
  const headers = authHeadersFor(url);
  const origin = `https://${new URL(url).hostname}`;
  const jsonUrl = jsonUrlFor(url);

  const first = await http(jsonUrl, { headers });
  const denied = gatedNote(url, first.status);
  if (denied) return denied;
  if (first.status !== 200) throw new Error(`discourse: category JSON returned HTTP ${first.status}`);

  // Parent listings include subcategory topics — each topic carries its own
  // category_id. Follow more_topics_url (verified: relative path + ?page=N).
  let list = JSON.parse(first.text) as CategoryList;
  let topics = list.topic_list.topics;
  let pages = 1;
  while (list.topic_list.more_topics_url && pages < MAX_CATEGORY_PAGES) {
    try {
      const r = await http(paginationUrlFor(origin, list.topic_list.more_topics_url), { headers });
      if (r.status !== 200) break;
      list = JSON.parse(r.text) as CategoryList;
      topics = topics.concat(list.topic_list.topics);
      pages++;
    } catch {
      break;
    }
  }
  const truncated = Boolean(list.topic_list.more_topics_url);

  // id → name for the listing category and per-topic subcategory tags.
  // site.json carries every category including subcategories (verified:
  // categories.json does NOT). Name lookups are best-effort.
  const listingId = Number(categoryPath(url).match(/\d+/)?.[0]);
  const names = await categoryNames(origin, http, headers);
  const name = names.get(listingId) ?? `Category ${listingId || "?"}`;

  return {
    url,
    title: name,
    content: renderCategoryList(topics, new URL(url).hostname, name, truncated, {
      listingId,
      nameOf: (id) => names.get(id),
    }),
  };
}

/** Fetch site.json and map category id → name. Empty map on any failure. */
async function categoryNames(
  origin: string,
  http: HttpFetch,
  headers: Record<string, string>,
): Promise<Map<number, string>> {
  try {
    const r = await http(`${origin}/site.json`, { headers });
    if (r.status !== 200) return new Map();
    const cats = (JSON.parse(r.text) as { categories?: CategoryRef[] }).categories ?? [];
    return new Map(cats.map((c) => [c.id, c.name]));
  } catch {
    return new Map();
  }
}

/** Actionable note for auth-denied fetches, or null when status is fine. */
function gatedNote(url: string, status: number): FeedResult | null {
  if (status !== 401 && status !== 403) return null;
  const host = new URL(url).hostname;
  // Return (not throw) so the agent gets actionable text instead of an
  // HTML login-wall scrape. tryFeed only falls back on thrown errors.
  return {
    url,
    title: "Login-gated Discourse",
    content:
      `This Discourse (${host}) requires login and no API key is configured.\n` +
      `Create a User API Key on the forum, store it in 1Password, and point a\n` +
      `"!command" entry at it in ${AUTH_FILE}:\n` +
      `  { "${host}": { "apiKey": "!op --account <account> read 'op://<vault>/<item>/api-key'", "apiUsername": "<username>" } }`,
  };
}
