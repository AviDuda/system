/**
 * Sidecar model benchmark — draft role (next-message suggestion quality).
 *
 * Run: bun run benchmarks/draft.ts
 *
 * Tests whether models produce useful, human-voice suggestions for what
 * the user might type next. All test cases expect "good" output — the
 * verdict reveals what went wrong (filtered, assistant-speak, empty).
 *
 * Uses the same multi-turn prompt structure as the extension:
 * few-shot examples + assistant prefill with "<suggestion>".
 *
 * Reads model config from ~/.pi/agent/roles.json + models.json.
 *
 * Usage:
 *   bun run benchmarks/draft.ts                        # all models for draft role
 *   bun run benchmarks/draft.ts --model omlx/Qwen3.6   # specific model(s)
 *
 * Add test cases: add entries to FOLLOWUP_TESTS or STARTUP_TESTS.
 */

import { filterSuggestion, parseSuggestionTag } from "../extensions/draft-suggestion/ghost-text";
import {
  FOLLOWUP_EXAMPLES,
  FOLLOWUP_SYSTEM_PROMPT,
  STARTUP_EXAMPLES,
  STARTUP_SYSTEM_PROMPT,
} from "../extensions/draft-suggestion/prompts";
import { type ChatMessage, runBenchmark, type TestCase } from "./shared";

// ── Verdict types ──

type Verdict = "good" | "filtered" | "assistant" | "empty";

/** Patterns that indicate assistant voice — what an AI would say, not a developer. */
const ASSISTANT_PATTERNS = [
  /^(would you like|shall we|do you want|are you ready|how about)\b/i,
  /^(i('ll| will| can| would| should| suggest| recommend| think| believe| notice| found)\b)/i,
  /^(here('?s| is| are) |there (is|are) )/i,
  /^(let me|let's (look|check|see|start|begin|try|move))/i,
];

function isAssistantSpeak(text: string): boolean {
  return ASSISTANT_PATTERNS.some((p) => p.test(text.trim()));
}

function parseVerdict(text: string): Verdict | null {
  const parsed = parseSuggestionTag(text);
  if (!parsed || parsed.trim().length === 0) return "empty";

  const filtered = filterSuggestion(parsed);
  if (!filtered) return "filtered";

  if (isAssistantSpeak(filtered)) return "assistant";

  return "good";
}

// ── Color function ──

function draftColor(v: string): string {
  if (v === "good") return "\x1b[32m";
  if (v === "filtered") return "\x1b[33m";
  if (v === "assistant" || v === "empty") return "\x1b[31m";
  return "\x1b[2m";
}

// ═══════════════════════════════════════════════════════════════════════
// Follow-up mode — predict next message after agent response
// ═══════════════════════════════════════════════════════════════════════

// Same message structure as draft-suggestion/index.ts generateSuggestion:
// system prompt + few-shot examples (user/assistant pairs) + test input
// as user + "<suggestion>" as assistant prefill.
function buildFollowupMessages(input: string): ChatMessage[] {
  return [
    { role: "system", content: FOLLOWUP_SYSTEM_PROMPT },
    ...FOLLOWUP_EXAMPLES.flatMap((ex) => [
      { role: "user" as const, content: ex.context },
      { role: "assistant" as const, content: `<suggestion>${ex.suggestion}</suggestion>` },
    ]),
    { role: "user", content: input },
    { role: "assistant", content: "<suggestion>" },
  ];
}

const FOLLOWUP_TESTS: TestCase<Verdict>[] = [
  // ── After code fixes ──
  {
    input:
      "human: Fix the bug in auth.ts\nassistant: I've fixed the authentication bug by updating the token validation logic.",
    expected: "good",
  },
  {
    input:
      "human: The tests are failing\nassistant: Found the issue — the mock was returning stale data. Updated the mock and tests pass now.",
    expected: "good",
  },
  {
    input:
      "human: Fix the type error in api.ts\nassistant: Fixed by adding the proper generic type to the request handler.",
    expected: "good",
  },

  // ── After showing code ──
  {
    input:
      "human: Show me the config module\nassistant: Here's config/index.ts:\n```ts\nexport const config = {\n  port: 3000,\n  db: process.env.DB_URL\n}\n```",
    expected: "good",
  },
  {
    input:
      "human: What does the router look like?\nassistant: The router handles these endpoints:\n- GET /users\n- POST /users\n- DELETE /users/:id",
    expected: "good",
  },

  // ── After feature implementation ──
  {
    input:
      "human: Add rate limiting to the API\nassistant: Added rate limiting using a token bucket algorithm. 100 requests/minute per IP.",
    expected: "good",
  },
  {
    input:
      "human: Implement user registration\nassistant: Registration endpoint done. Validates email, hashes password, stores in users table.",
    expected: "good",
  },
  {
    input:
      "human: Create the database migration\nassistant: Created migration 004_add_user_preferences.sql with preferences table and default values.",
    expected: "good",
  },

  // ── After deployment/ops ──
  {
    input:
      "human: Deploy to staging\nassistant: Deployed to staging at https://staging.example.com. Build #142 succeeded.",
    expected: "good",
  },
  {
    input:
      "human: The build is failing on CI\nassistant: TypeScript errors in src/api.ts: Property 'user' does not exist on type 'Request'.",
    expected: "good",
  },

  // ── After git operations ──
  {
    input:
      "human: Show me the diff\nassistant: ```diff\n+ import { validate } from './validators'\n+ if (!validate(input)) throw new Error('Invalid')\n```",
    expected: "good",
  },
  {
    input:
      "human: What changed since yesterday?\nassistant: 3 commits:\n- feat: add user registration\n- fix: auth token expiry\n- chore: update deps",
    expected: "good",
  },

  // ── After analysis ──
  {
    input:
      "human: How does the caching work?\nassistant: Redis cache with 5min TTL. Keys computed from request URL + query params. Invalidation via pub/sub.",
    expected: "good",
  },
  {
    input:
      "human: Why is the API slow?\nassistant: N+1 query in /users — each user triggers a separate DB call for roles.",
    expected: "good",
  },
  {
    input:
      "human: What's using all the memory?\nassistant: The image processing pipeline buffers entire files in memory instead of streaming.",
    expected: "good",
  },

  // ── After test/lint results ──
  {
    input:
      "human: Run the tests\nassistant: 47/48 passed. 1 failure in auth.test.ts: expected token to expire after 1h but still valid.",
    expected: "good",
  },
  {
    input:
      "human: Run lint\nassistant: 3 errors:\n- src/api.ts:23 — unused variable 'result'\n- src/db.ts:45 — missing return type\n- src/utils.ts:12 — prefer const",
    expected: "good",
  },

  // ── After refactoring ──
  {
    input:
      "human: Refactor the database layer\nassistant: Extracted into src/db/ with separate modules for connections, queries, migrations. All tests pass.",
    expected: "good",
  },

  // ── After documentation ──
  {
    input:
      "human: What does the API docs say?\nassistant: 12 endpoints across 3 resources: users, auth, admin. Auth uses JWT + refresh tokens.",
    expected: "good",
  },

  // ── Edge cases ──
  {
    input: "human: hello\nassistant: Hey! I see you're working on the Nix system config. What would you like to do?",
    expected: "good",
  },
  {
    input:
      "human: what's in this directory?\nassistant: Directory listing:\nsrc/\ntests/\nconfig/\npackage.json\ntsconfig.json\nREADME.md",
    expected: "good",
  },
  {
    input: "human: thanks\nassistant: No problem! Let me know if you need anything else.",
    expected: "good",
  },
];

// ═══════════════════════════════════════════════════════════════════════
// Startup mode — predict first message from project context
// ═══════════════════════════════════════════════════════════════════════

// Same message structure as draft-suggestion/index.ts generateFromContext.
function buildStartupMessages(input: string): ChatMessage[] {
  return [
    { role: "system", content: STARTUP_SYSTEM_PROMPT },
    ...STARTUP_EXAMPLES.flatMap((ex) => [
      { role: "user" as const, content: ex.context },
      { role: "assistant" as const, content: `<suggestion>${ex.suggestion}</suggestion>` },
    ]),
    { role: "user", content: `Context:\n${input}` },
    { role: "assistant", content: "<suggestion>" },
  ];
}

const STARTUP_TESTS: TestCase<Verdict>[] = [
  {
    input:
      "Git status:\n M src/auth.ts\n?? src/new-module.ts\n\nRecent commits:\nabc1234 feat: add login endpoint\ndef5678 chore: update deps\n\nProject files:\nsrc/\ntests/\npackage.json",
    expected: "good",
  },
  {
    input:
      "Recent notes: Implemented password reset flow. Tests passing. Need to add rate limiting before deploy.\n\nGit status:\nM src/password-reset.ts\n\nProject files:\nsrc/\ntests/\nDockerfile",
    expected: "good",
  },
  {
    input:
      "Recent notes: Database migration failing on production. Error: column 'preferences' already exists.\n\nGit status:\n M migrations/005_add_preferences.sql\n\nRecent commits:\n4a3b2c1 fix: migration rollback",
    expected: "good",
  },
  {
    input:
      "Git status:\n clean\n\nRecent commits:\nf1e2d3c chore: bump dependencies\n\nRecent notes: All green. Considering adding WebSocket support for real-time notifications.",
    expected: "good",
  },
  {
    input:
      "Recent notes: Found memory leak in worker process. Grows ~100MB/hour. Haven't started investigation.\n\nProject files:\nsrc/\nworkers/\nconfig/\nmonitoring/",
    expected: "good",
  },
];

// ── Run both modes ──

async function main() {
  console.log("\n\x1b[1m═══ Draft: Follow-up mode ═══\x1b[0m");

  await runBenchmark<Verdict>({
    role: "draft",
    systemPrompt: FOLLOWUP_SYSTEM_PROMPT,
    tests: FOLLOWUP_TESTS,
    parseOutput: parseVerdict,
    color: draftColor,
    buildMessages: buildFollowupMessages,
  });

  console.log("\n\x1b[1m═══ Draft: Startup mode ═══\x1b[0m");

  await runBenchmark<Verdict>({
    role: "draft",
    systemPrompt: STARTUP_SYSTEM_PROMPT,
    tests: STARTUP_TESTS,
    parseOutput: parseVerdict,
    color: draftColor,
    buildMessages: buildStartupMessages,
  });
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
