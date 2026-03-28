# Draft Suggestion

Shows a suggested next message as greyed-out ghost text in the input editor. Press **Tab** to accept.

## When suggestions appear

- **After agent responds** (`agent_end`) -- predicts follow-up based on conversation
- **On session resume** -- predicts follow-up based on conversation history
- **On fresh session start** -- predicts what to work on based on journal notes + git status + project structure (via `journal:loaded` event)

## How it works

1. Fires a sidecar call using the "draft" role (Haiku) to predict what the user might type next
2. The suggestion appears as dim ghost text after the cursor in the empty editor
3. **Tab** accepts the suggestion into the editor
4. Any typing clears the ghost text
5. Widget hint "Tab to accept suggestion" appears below the editor

## Config

Requires a "draft" role in `~/.pi/agent/roles.json`:

```json
{
  "draft": {
    "models": [{ "ref": "anthropic/claude-haiku-4-5", "thinking": "off" }]
  }
}
```

`maxAttempts` (default: 1) controls retry-with-filtering per call. Useful for weaker/local models:

```json
{ "ref": "local/llama", "thinking": "off", "maxAttempts": 3 }
```

Managed by Nix via `modules/home-manager/pi.nix`.

## Commands

- `/draft` -- Toggle suggestions on/off

## Architecture

- `index.ts` -- Extension entry. `GhostEditor` extends `CustomEditor` with ghost text + Tab accept. Sidecar prompt with multi-turn few-shot examples and assistant prefill.
- `ghost-text.ts` -- Pure logic: ANSI injection, `<suggestion>` tag parsing, suggestion filtering (pleasantries, assistant-speak). No pi imports.
- `ghost-text.test.ts` -- Tests for rendering, parsing, and filtering.

## Suggestion filtering

Suggestions are discarded (no ghost text shown) if they match:
- Pleasantries: "thanks", "ok", "looks good", etc.
- Assistant-speak: "Would you like...", "Let me...", "I can help...", "Here's what...", etc.
- Very short strings (< 3 chars)

On retry (`maxAttempts > 1`), each filtered result triggers a new sidecar call.

## Ghost text rendering

Post-processes `Editor.render()` output. Finds the cursor (reverse video: `\x1b[7m...\x1b[0m`) and injects dim text (`\x1b[2m...\x1b[22m`) in the padding space after it. Only shows when the editor is empty. Fragile if pi-tui changes cursor rendering, but degrades gracefully (suggestion just won't display).

## Startup context (fresh sessions)

Listens for `journal:loaded` event from the journal extension. Gathers additional project context via `pi.exec`:
- `git status --short` -- uncommitted work
- `git log --oneline -5` -- recent commits
- `ls -1` -- project structure

Uses a separate prompt tuned for "what to work on next" rather than conversational follow-up.
