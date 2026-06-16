# stats

Live throughput readouts in the pi footer, a persistent annotation under each
assistant message, and per-turn / session totals. Built for the case where
local-model prefill can take minutes and you want proof the request isn't hung,
plus an honest throughput number that isn't polluted by human-in-the-loop
latency or fabricated from character counts.

## What it shows

**Footer pill (`stats` key) — live phases:**

| Phase | Example | Meaning |
|-------|---------|---------|
| Prefill | `PP 2:14` | Request sent → first token. Clock ticks every 0.5s, `warning` past 30s. For local models this can run minutes. |
| Thinking | `THINK 0:14` | Reasoning phase (first thinking token → first answer token). Only when the model thinks. |
| Decode | `DEC 1.2s` | Answer-writing phase (first text/tool token → message end). Elapsed only — no fabricated rate while streaming. |
| Idle | `↓480 ~22t/s →` | Last response: output tokens + dual-EMA decode trend. Arrow `→`/`▼`/`▲` gated at 15% divergence, so single off-turns don't flip it. Adds `PP42s` when prefill > 3s. Resets on model change. |

**Persistent annotation under each assistant message** (via `ctx.ui.notify`,
display-only — never enters the LLM context):

```
PP 1.2s · ✶25s · ↑12k/↓480 · 200t/s        (with thinking)
PP 1.2s · ↑12k/↓480 · 200t/s               (no thinking)
```

- prefill duration
- thinking duration (only when a reasoning phase ran and exceeded ~1s)
- input/output token counts — real provider `usage`, not estimated
- aggregate output throughput over the full output window (first token →
  message end, **includes thinking**). Read next to the `✶time` on heavy
  thinking turns.

**`/stats` command** — last response, session totals (turns, in/out tokens,
total prefill/think/output/blocked, avg tps, cost), and a table of the last 12
turns. Toggle live display or reset.

## Why tps includes thinking time (option a)

`tps = usage.output / (first_token → message_end)` — the full output window,
thinking included. The alternatives were all worse:

- Splitting thinking vs text token counts requires estimating tokens from
  characters (provider-dependent whether `usage.output` includes thinking) —
  that's fabricating numbers, so rejected.
- A text-only rate can't be computed honestly without that estimation.

The full-window rate is honest and turn-consistent (so the EMA trend stays
valid). It's low on heavy-thinking turns; the adjacent `✶25s` contextualizes
it. During streaming the footer shows elapsed time only — no token rate is
invented before `usage` arrives.

## How blocking is excluded

Two independent guarantees:

1. **Per-message metrics are gate-free by construction.** They're measured
   entirely within one LLM generation
   (`before_provider_request` → first `message_update` → `message_end`), which
   never overlaps tool execution. The permission gate only blocks tool
   execution, which happens *between* generations — so it can't touch these.

2. **Turn-level `blocked` is measured by subtraction**, with no coupling to any
   specific extension:
   ```
   blocked = turn_wall − union(generation_spans ∪ tool_execution_spans)
   ```
   Whatever remains — permission-gate dialogs, any future blocking extension —
   shows up as `blocked`. Parallel tools are unioned, not summed.

## Anchors (verified against pi internals)

- `before_provider_request` — fires in the provider's `onPayload`, **before**
  the HTTP fetch. = prefill start. (Compaction's LLM call omits `onPayload`, so
  it does *not* fire this event — the state machine is never orphaned.)
- first assistant `message_update` — first generated token. = end of prefill.
- `assistantMessageEvent.type` — phase detection: `thinking_*` = reasoning,
  `text_*`/`toolcall_*` = answer phase.
- `message_end` (assistant) — carries `usage.output`. = generation end.
- `tool_execution_start` / `tool_execution_end` — tool execution span
  (post-gate).
- `turn_start` / `turn_end` — turn wall.

## Caveats

- Prefill time includes network latency (cloud) as well as server-side prompt
  processing. For local models it's ~all prefill.
- The idle-pill trend arrow is a **dual-EMA** (fast α=0.4 recent vs slow α=0.08
  baseline), gated at 15% divergence with a 3-sample warmup. *Meaningful for
  local models* (growing KV cache + memory pressure drags decode across a long
  session) and *mostly noise on cloud* (server load). Resets on model change.
- Annotations persist in the scrollback but are not saved to the session file
  (notify is render-only), so reopening a session won't show past annotations.
- Per-turn timing IS persisted to a `custom` session entry (`customType:
  "stats"`) via `pi.appendEntry`, as write-only insurance — it's NOT sent to the
  LLM. Token counts are reconstructable from the session's per-message
  `usage`, but timing (prefill/thinking/output/tps) is irrecoverable without
  this. No re-render path: the extension never reads these back; they're for
  offline analysis of session JSONL.
- Data is per-session (reset on `session_start`); not persisted across
  sessions.
