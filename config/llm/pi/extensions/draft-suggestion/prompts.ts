/**
 * Draft suggestion prompts — shared between the extension and benchmarks.
 *
 * The extension and benchmarks both use multi-turn with assistant prefill
 * (<suggestion>). The few-shot examples here define the format.
 *
 * No pi imports — pure string constants.
 */

// ── System prompts ──

/** System prompt for follow-up mode (predict next message after agent response). */
export const FOLLOWUP_SYSTEM_PROMPT = `You predict what the HUMAN types next. The human is a developer talking to a coding AI. Humans type commands and questions like:
- "Show me the test files"
- "How does the auth module work?"
- "Add error handling to the API"
- "What's in the config directory?"

NEVER generate assistant-style responses like "Would you like to...", "I can help with...", "Let me...", "Here's what I found...". Those are what the ASSISTANT says, not the human.`;

/** System prompt for startup mode (predict first message from project context). */
export const STARTUP_SYSTEM_PROMPT = `You predict what a developer will type as their FIRST message when starting a session. Based on the project context and recent work, suggest what they'd work on next. One short sentence, a direct instruction or question. NEVER use assistant-style language like "Would you like", "I can help", "Let me".`;

// ── Few-shot examples ──

export interface FewShotExample {
  /** The conversation context (human + assistant messages) */
  context: string;
  /** The expected suggestion (without tags) */
  suggestion: string;
}

/** Few-shot examples for follow-up mode. */
export const FOLLOWUP_EXAMPLES: FewShotExample[] = [
  {
    context: `human: Fix the failing test in auth.ts
assistant: I've fixed the test by updating the mock.`,
    suggestion: "Run the full test suite now",
  },
  {
    context: `human: Show me the project structure
assistant: Here's the directory layout: src/, tests/, config/...`,
    suggestion: "How many lines of code in each module?",
  },
  {
    context: `human: Hello!
assistant: Hey! Last session we built the auth module. What are you working on today?`,
    suggestion: "Let's add rate limiting to the auth endpoints",
  },
];

/** Few-shot examples for startup mode. */
export const STARTUP_EXAMPLES: FewShotExample[] = [
  {
    context: "Context: Auth module project. Recent notes: Fixed auth bug, tests passing. Deploy pending.",
    suggestion: "Deploy the auth fix to staging",
  },
  {
    context:
      "Context: Nix system config. Recent notes: Built draft-suggestion extension, needs live testing. Also need to run nix-switch.",
    suggestion: "Run mise nix-switch to deploy the pending changes",
  },
];
