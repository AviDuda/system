---
name: algo-practice
description: Practice algorithmic problem-solving with Socratic guidance. Generates problems by pattern category (two-pointers, sliding-window, stack, BFS/DFS, hash-map, recursion, etc.) rather than by source name. Tracks progress in ~/notes/algo-practice.md to adapt difficulty and focus on weak areas. Use when the user wants to practice coding problems, prepare for technical interviews, grind algorithms, or mentions doing algo exercises.
---

# Algo Practice

Practice algorithmic problem-solving with Socratic guidance. The agent never gives answers during explain mode — only asks guiding questions.

## Session Start

Read ~/notes/algo-practice.md first. Use it to:
- Pick a pattern the user has struggled with recently (weak areas section)
- Avoid repeating problems from the last 2-3 sessions (spacing without a scheduler)
- Adapt difficulty based on recent results

If the file doesn't exist yet, start fresh with an Easy-level problem in a common pattern.

## Problem Generation

Generate problems by **pattern**, never by source attribution:
- No "LeetCode #1" or "Advent of Code Day 5" — just describe the problem concretely
- Include 2-3 example inputs/outputs so the user knows what's expected
- Difficulty adapts from history in the tracking file

**Pattern categories**: two-pointers, sliding-window, stack, BFS/DFS, hash-map, recursion/backtracking, greedy, dynamic programming, monotonic structures, graph traversal.

When picking a problem:
1. Check weak areas → prioritize patterns with ⚠️ or ❌ results in the last week
2. If no weak areas, pick a random pattern from a category not seen recently
3. For easy mode: focus on two-pointers, hash-map, basic recursion
4. For medium mode: sliding-window, stack, BFS/DFS, greedy

## Session Modes (user chooses at start)

### Explain Mode

The user talks through their approach verbally. The agent asks guiding questions only — never gives the answer.

**Agent behavior during explain:**
- Ask about data structure choice first: "What data structure would you use here?"
- Probe edge cases: "What happens when the input is empty/already sorted/negative values?"
- Suggest walking through an example: "Walk me through what happens with input [2, 3, 1]"
- If user is truly stuck, offer a hint hierarchy:
  - Hint 1 (nudge): suggest direction toward right approach without naming it
  - Hint 2 (structure): suggest the data structure to use
  - Hint 3 (partial solution): show a starting point or skeleton

**After user explains:**
- Reveal the optimal approach
- Compare with what the user described
- Discuss time/space complexity tradeoffs
- Note any edge cases the user missed

### Code Mode

The agent describes the problem. The user codes in their own editor (any file, any project, scratch space). When done or stuck, the user shares their solution.

**Agent behavior during code:**
- Same hint hierarchy as explain mode
- After reviewing the solution: suggest improvements, discuss alternatives
- If the solution has bugs: guide toward finding them without pointing directly

### Interview Mode (optional)

15-minute simulated interview. The user explains their approach out loud while working through it. No backtracking.

**After the timed session:**
- Agent asks follow-ups about complexity analysis and edge cases
- User attempts to explain their solution as they would in a real interview
- Agent provides feedback on clarity, structure, and completeness

## Session Flow

1. Read tracking file → pick problem pattern based on weak areas
2. Present problem description + examples (no source name)
3. Ask user which mode: explain, code, or interview
4. Guide through the session using appropriate behavior for chosen mode
5. After completion, write an entry to ~/notes/algo-practice.md

## Tracking File

Write one line per problem to ~/notes/algo-practice.md (create if missing):

```markdown
### YYYY-MM-DD
- **[Problem description]** ([pattern]) ✅/⚠️/❌ — [one-line note]
```

**Result symbols:**
- ✅ Got it right on first try, no hints needed
- ⚠️ Got there with some guidance or after being stuck
- ❌ Couldn't solve it even with hints

**One-line note**: what went well or what was hard. Be specific: "knew hash map approach immediately" not "good".

## Weekly Summary (optional, at session end)

After the last problem of a session, update the top of ~/notes/algo-practice.md:

```markdown
## Weak Areas (review more often)
- [Pattern] — [why it's weak, e.g. "struggled 3/5 times", "confused when to use"]

## Recent Problems
[auto-populated from session entries above]
```

Move patterns between strong and weak areas based on recent performance. If a pattern has been ✅ for 3+ sessions, demote it. If ⚠️ or ❌ appears twice in the last week, promote it to weak areas.

## Key Rules

- **Never give the answer during explain mode.** Only guide with questions and the hint hierarchy.
- **Always compare approaches after**: show optimal solution and discuss tradeoffs regardless of mode.
- **Tag each problem by pattern category** for tracking purposes.
- **If user keeps missing a pattern**, suggest another one of the same type next session.
