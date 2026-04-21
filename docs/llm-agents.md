# LLM Agent Design

Design philosophy for LLM coding agent setup. Reference for agents working on extensions, instructions, or journal infrastructure.

## Stack

**Pi** (vanilla) with custom extensions. Not a fork or batteries-included variant -- custom behavior is built as extensions on top of upstream pi. The goal is owning the customization layer while staying on a maintained base. Extensions are TypeScript, live-reloadable, and symlinked from `config/llm/pi/extensions/`.

Multiple agents share the same global instructions and journal system: pi, Claude Code, and OpenCode all read the same `instructions.md` and journal directory. Agent-specific behavior (pi extensions, CC hooks, OpenCode plugins) wraps the shared core.

## Knowledge Tiers

Knowledge is routed to the right durability level, not dumped in one place.

| Tier | What goes here | Where |
|------|---------------|-------|
| Human+LLM docs | Patterns, conventions, architecture decisions useful to both humans and agents | Project documentation, @-mentioned from AGENTS.md |
| LLM shared instructions | Agent workflow rules, project-specific behavioral constraints | AGENTS.md (committed) |
| LLM personal instructions | Private workflow context, local paths, personal preferences | AGENTS.local.md (gitignored) |
| Temporal context | Session history, work in progress, things still being figured out | Journal entries |

Agents suggest AGENTS.md changes but don't edit directly. Repeated patterns in journals are signals to promote knowledge to a durable tier.

**No auto-memory.** Automatic memory extraction (reading past sessions to build a durable memory file) was tried and rejected. It creates a silo outside the repo, duplicates what journals + AGENTS.md do better, and the quality of automatic extraction is poor. The journal system is the memory system -- agents write during work, future agents read at session start.

## Journal System

Journals live in `~/notes/llm/{project-name}/`, one file per topic per day. Agents see the 3 most recent entries at session start (injected by the journal extension). The rest are accessible via `read` if the agent knows the filename.

### Design principles

- **Agents write unprompted.** Instructions mandate journaling after each completed step. No human intervention needed.
- **Temporal, not archival.** Entries capture what happened and what was learned, not polished documentation. Voice and opinions are encouraged.
- **Cross-tool.** All agents (pi, CC, OpenCode) read and write the same journal directory. A pi session can continue work started in CC.
- **Handoff via journal.** Long tasks span multiple sessions. The agent journals progress, the next agent reads recent notes and continues. No special handoff mechanism needed -- the journal *is* the handoff.
- **Start fresh often.** Rather than compacting a long session, start a new one. The journal carries context forward. This avoids compaction lossiness and keeps sessions focused.

### What agents see at startup

1. Global instructions from `instructions.md`
2. `TODO.md` from the project's journal directory (if it exists) -- persistent, not subject to the recency window
3. Full content of the 3 most recent journal entries (recency window)
4. Filename listing of older entries (up to 30) and recent filenames from other projects (up to 5 each)
5. Project-specific AGENTS.md files (loaded by pi natively + agents-loader extension)

## Extensions

Custom pi extensions follow a pattern: augment the agent with context and guardrails, using cheap sidecar models where real-time analysis is needed.

**Context injection** -- agents-loader discovers AGENTS.md files from touched directories; journal extension injects notes and instructions; at-mentions inlines file contents on `@path` references.

**Guardrails** -- permission-gate intercepts tool calls with a confirmation dialog showing colored diffs, sidecar-generated verdicts (SAFE/RISKY/DANGEROUS), and session-allow rules with shell escalation detection.

**Augmentation** -- LSP extension runs diagnostics after every edit/write so the agent sees type errors immediately; draft-suggestion predicts the next user message as ghost text; web-search provides Kagi and Claude-based search.

**Sidecar pattern** -- cheap models (Haiku-class) run alongside the main conversation for tasks like classification, explanation generation, and draft prediction. They don't share conversation context -- they get focused, purpose-built prompts.

### What's intentionally absent

- **Sub-agents / plan mode.** Subagents lack session context and can't be steered. Plan mode prevents journaling and burns context on planning that should be captured in the journal. The journal is the plan.
- **Prompt history storage.** Less tracking preferred.
- **MCP integration.** CLI tools with READMEs (skills) cover the same ground without the protocol overhead. May be added later if needed for specific project work.
- **Autonomous features.** No auto-commit, auto-compact customization, or background processing. The human steers; the agent executes and journals.

## Local LLMs

Two local inference servers run on this machine for offline fallback and sidecar model serving.

### Architecture

| Server | Port | Engine | Format | Use |
|--------|------|--------|--------|-----|
| LM Studio | `:1234` | llama.cpp (GGUF) + MLX | GGUF Q4_K_M, MLX | Main model, model discovery |
| oMLX | `:8124` | MLX | MLX 4-bit (unsloth UD) | Sidecar roles, continuous batching |

Both share `~/.lmstudio/models/` -- LM Studio can load both GGUF and MLX models, oMLX only loads MLX. No duplication of model files.

**LM Studio** is kept for model discovery (tells you if a model fits your RAM, curated suggestions, HuggingFace search). oMLX is the performance server -- tiered KV cache (RAM + SSD), continuous batching, multi-model serving with LRU eviction. oMLX's admin dashboard at `:8124/admin` also provides model search/download, chat, benchmarking, and settings -- sufficient for day-to-day without the GUI app.

### Models (M4 Pro 48 GB)

| Model | Format | Server | Size | Generation |
|-------|--------|--------|------|------------|
| Qwen 3.6 35B A3B | GGUF Q4_K_M | LM Studio :1234 | ~17.5 GB | ~41 tok/s |
| Qwen 3.6 35B A3B UD | MLX 4-bit | oMLX :8124 | ~20.4 GB | ~65 tok/s |
| Qwen 3.5 9B | GGUF | LM Studio :1234 | ~5 GB | -- |
| GLM-4.7 Flash | MLX 6-bit | oMLX :8124 | ~23.8 GB | -- |

Qwen 3.6 35B A3B is MoE (3B active params per token) -- fast enough for sidecar tasks.

### Why both GGUF and MLX

GGUF via llama.cpp has better quantization quality (K-quants allocate more bits to sensitive tensors, 4.7x lower perplexity than uniform 4-bit). MLX has faster generation (~60% faster) and continuous batching for concurrent requests. For main model coding work where quality matters, GGUF wins. For sidecar tasks (explain, draft, vision) where speed matters more, MLX via oMLX wins.

Prefill speed: llama.cpp is faster at batch prompt processing (3+ years of optimization). MLX is younger here. For agent workloads with growing context, prefill dominates total response time. But oMLX's tiered KV cache mitigates this -- cached prefixes don't recompute.

### Model routing in pi

`modules/home-manager/pi.nix` defines providers and sidecar role fallback chains. Roles (explain, draft, vision) try cloud models first, then local oMLX, then local LM Studio as last resort. The `omlx` provider at `:8124` serves MLX models; `lmstudio` at `:1234` serves GGUF models.

Per-model `requestParams` in roles.json controls thinking behavior per role (implemented via pi's `onPayload` hook):
- `explain`/`draft`: `chat_template_kwargs: { enable_thinking: false }` -- skip chain-of-thought for fast sidecar responses
- `vision`: `thinking_budget: 1024` -- capped thinking for better image descriptions

### oMLX model management

Models are managed through a combination of automatic and manual controls:

- **LRU eviction**: least-recently-used models are unloaded automatically when memory runs low
- **Manual load/unload**: status badges in the admin panel (`/admin`)
- **Model pinning**: pin frequently used models (e.g., sidecar models) to keep them always loaded
- **Per-model TTL**: auto-unload after a configurable idle timeout -- useful for freeing RAM for VMs when not doing LLM work
- **Process memory limit**: default is system RAM - 8 GB, prevents OOM

On unload, MLX arrays (weights + KV cache) are freed from Metal memory and returned to the OS. SSD-cached KV blocks persist on disk but don't consume RAM.

### oMLX experimental features

Enabled per-model in the admin panel under Experimental Features.

**TurboQuant KV cache** (enabled on Qwen 3.6 at 4-bit): compresses KV cache using vector quantization. At 4-bit, ~4x compression with negligible quality loss. This is the most impactful feature for memory-constrained setups -- a 32K context that would need ~6-8 GB KV cache at fp16 drops to ~1.5-2 GB.

**SpecPrefill** (not enabled): attention-based sparse prefill for MoE models. Skipped because prefill speed (~705 tok/s) isn't the bottleneck, and there are open bugs with quantized models.

**DFlash** (not enabled): block diffusion speculative decoding for 3-4x faster generation. Only supports Qwen 3.5 family, falls back to normal engine for contexts >4K tokens (most agent conversations), and no paged/SSD cache integration. Faster generation would also make iTerm2 flicker worse.

### oMLX setup

- **CLI**: `brew install jundot/omlx/omlx` (tap: `brew tap jundot/omlx https://github.com/jundot/omlx`)
- **Start**: `omlx serve --model-dir ~/.lmstudio/models --port 8124`
- **Admin**: `http://127.0.0.1:8124/admin` (HF downloader, benchmark, model management)
- **GUI app**: Optional DMG from releases with in-app auto-update and menu bar control. Not in brew.nix (no cask available, auto-update conflicts with cask management). The admin dashboard via CLI is sufficient for most use.
- **Config**: `~/.omlx/settings.json`
- **Benchmarks**: [omlx.ai/benchmarks](https://omlx.ai/benchmarks) (filter by chip/model/quant)

### Key references

- [MLX vs GGUF benchmarks on Apple Silicon](https://famstack.dev/guides/mlx-vs-gguf-apple-silicon/) -- thorough comparison showing prefill vs generation tradeoffs, effective throughput vs UI-reported tok/s
- [Part 2: isolating variables](https://famstack.dev/guides/mlx-vs-gguf-part-2-isolating-variables/) -- runtime comparison (LM Studio, Ollama, oMLX), quantization quality (K-quants vs uniform), bf16 fix for M1/M2
- [oMLX](https://github.com/jundot/omlx) -- 10.9k stars, Apache 2.0, tiered KV cache, continuous batching
- [Rapid-MLX](https://github.com/raullenchai/Rapid-MLX) -- agent-focused MLX server with tool call parsers, DeltaNet state snapshots for Qwen hybrid attention. Worth watching.
- [SwiftLM](https://github.com/SharpAI/SwiftLM) -- native Swift, SSD expert streaming for 100B+ MoE. Ambitious but young.
- [Ollama MLX backend](https://ollama.com/blog/mlx) -- MLX support added March 2026, but 37% overhead from Go wrapper makes it uncompetitive for latency-sensitive use

## Nix Integration

Agent configuration is declarative. `modules/home-manager/pi.nix` symlinks extensions, `modules/home-manager/llm.nix` generates shared config (`journal.json`), and `modules/home-manager/llm-shared.nix` defines constants shared across all agents. Adding a new pi extension is just creating a directory with `index.ts` -- the Nix module auto-discovers it.

Runtime config (journal paths, model roles) is generated by Nix into `~/.config/llm/` so it's consistent across agents without manual setup.
