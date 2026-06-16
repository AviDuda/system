/**
 * Stats extension — live throughput readouts + per-message annotations.
 *
 * Footer pill (live, belongs to this extension — no conflict with the working
 * spinner, unlike setWorkingMessage):
 *   - PP M:SS     prefill (request sent -> first token), clock ticks 0.5s.
 *                 Turns warning past 30s. For local models this can run minutes.
 *   - THINK M:SS  reasoning phase (first thinking token -> first answer token).
 *                 Only shown when the model actually thinks.
 *   - DEC X.Xs    answer-writing phase (first text/tool token -> message end).
 *                 Elapsed only — no fabricated token rate during streaming.
 *   - at rest:    last response summary + dual-EMA decode trend, e.g.
 *                 `↓480 ~22t/s →`. Resets on model change.
 *
 * Persistent annotation under each assistant message (ctx.ui.notify, render-only,
 * never enters the LLM context):
 *   `PP 1.2s · ✶25s · ↑12k/↓480 · 200t/s`
 *   - prefill duration
 *   - thinking duration (only when a reasoning phase ran and exceeded ~1s)
 *   - input/output token counts (real provider usage, not estimated)
 *   - aggregate output throughput over the FULL output window (first token ->
 *     message end, includes thinking). Low on heavy-thinking turns; read it
 *     next to the ✶time. Chosen as option (a): honest & turn-consistent so the
 *     EMA trend stays valid; we don't fake a text-only rate from char counts.
 *
 * Phase detection (via assistantMessageEvent.type):
 *   thinking_*  -> thinking phase
 *   text_* / toolcall_* -> answer phase
 *
 * How blocking (e.g. the permission gate) is excluded:
 *   All per-message metrics are measured within one LLM generation
 *   (before_provider_request -> message_end), which never overlaps tool
 *   execution. The gate only blocks tool execution, which happens *between*
 *   generations. Turn-level "blocked" = turn_wall − union(generation ∪ tool
 *   execution spans); whatever remains is human-in-the-loop latency, with no
 *   coupling to the gate. Parallel tools are unioned, not summed.
 *
 * Annotations persist in the scrollback (render-only) and timing is also stashed
 * in `custom` session entries (pi.appendEntry, NOT sent to the LLM) as
 * write-only insurance — the timing can't be reconstructed from the session
 * file later (only usage tokens can). No re-render path is implemented.
 *
 * Compaction's LLM call does NOT fire before_provider_request (its options
 * omit onPayload), so the state machine is never orphaned by compaction.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  computeBlocked,
  formatClock,
  formatDuration,
  formatMessageStats,
  formatTokens,
  formatTps,
  type Span,
  type TrendState,
  trendInit,
  trendUpdate,
  trendView,
} from "./timing";

interface TurnRecord {
  idx: number;
  model: string;
  prefillMs: number;
  thinkingMs: number;
  outputMs: number;
  output: number;
  input: number;
  tps: number;
  blockedMs: number;
  wallMs: number;
}

interface SessionTotals {
  turns: number;
  input: number;
  output: number;
  prefillMs: number;
  thinkingMs: number;
  outputMs: number;
  blockedMs: number;
  cost: number;
}

interface LastSummary {
  prefillMs: number;
  thinkingMs: number;
  outputMs: number;
  tps: number;
  output: number;
  input: number;
  model: string;
}

const TICK_MS = 500;
const PREFILL_NOTICE_MS = 30_000; // switch clock color to warning past this
const PREFILL_IDLE_THRESHOLD_MS = 3000; // only surface prefill in idle pill when it matters
type StatColor = "dim" | "accent" | "warning" | "muted";
type TickerPhase = "prefill" | "thinking" | "decode";

const HISTORY_LIMIT = 50;

function freshTotals(): SessionTotals {
  return { turns: 0, input: 0, output: 0, prefillMs: 0, thinkingMs: 0, outputMs: 0, blockedMs: 0, cost: 0 };
}

export default function stats(pi: ExtensionAPI) {
  let enabled = true;

  // Current generation phase timestamps
  let prefillStart: number | null = null;
  let firstTokenTs: number | null = null; // first delta of any kind (PP end, full-output-window start)
  let thinkingStartTs: number | null = null; // first thinking_* event
  let answerStartTs: number | null = null; // first text_*/toolcall_* event

  // Current turn spans
  let genSpans: Span[] = [];
  const toolStarts = new Map<string, number>();
  let toolSpans: Span[] = [];
  let turnStartTs: number | null = null;
  let turnIdx = 0;

  // Records
  let lastSummary: LastSummary | null = null;
  let history: TurnRecord[] = [];
  let totals = freshTotals();
  let tpsTrend: TrendState = trendInit();

  // Live ticker
  let ticker: ReturnType<typeof setInterval> | null = null;
  let tickerPhase: TickerPhase = "prefill";

  // ── helpers ──

  function stopTicker(): void {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function setStats(ui: ExtensionUIContext, text: string | undefined, color: StatColor = "dim"): void {
    if (!enabled) {
      ui.setStatus("stats", undefined);
      return;
    }
    ui.setStatus("stats", text ? ui.theme.fg(color, text) : undefined);
  }

  function paint(ui: ExtensionUIContext): void {
    if (tickerPhase === "prefill" && prefillStart !== null) {
      const elapsed = Date.now() - prefillStart;
      setStats(ui, `PP ${formatClock(elapsed)}`, elapsed > PREFILL_NOTICE_MS ? "warning" : "accent");
    } else if (tickerPhase === "thinking" && thinkingStartTs !== null) {
      setStats(ui, `THINK ${formatClock(Date.now() - thinkingStartTs)}`, "muted");
    } else if (tickerPhase === "decode" && answerStartTs !== null) {
      setStats(ui, `DEC ${formatDuration(Date.now() - answerStartTs)}`, "muted");
    }
  }

  /** Start (or re-arm) the ticker for a phase. No-op if already running that phase. */
  function armTicker(ui: ExtensionUIContext, phase: TickerPhase): void {
    if (ticker && tickerPhase === phase) return;
    stopTicker();
    tickerPhase = phase;
    paint(ui);
    ticker = setInterval(() => paint(ui), TICK_MS);
  }

  function idlePill(): string {
    if (!lastSummary) return "";
    const s = lastSummary;
    const view = trendView(tpsTrend);
    const tpsStr = view.value !== null ? `~${Math.round(view.value)}t/s` : "—";
    const arrow = view.arrow ? ` ${view.arrow}` : "";
    const parts = [`↓${formatTokens(s.output)}`];
    if (s.prefillMs > PREFILL_IDLE_THRESHOLD_MS) parts.push(`PP${formatDuration(s.prefillMs)}`);
    parts.push(`${tpsStr}${arrow}`);
    return parts.join(" ");
  }

  function showIdle(ui: ExtensionUIContext): void {
    stopTicker();
    setStats(ui, idlePill() || undefined, "dim");
  }

  function resetGenerationState(): void {
    prefillStart = null;
    firstTokenTs = null;
    thinkingStartTs = null;
    answerStartTs = null;
  }

  // ── events ──

  pi.on("session_start", async (_event, ctx) => {
    resetGenerationState();
    genSpans = [];
    toolStarts.clear();
    toolSpans = [];
    turnStartTs = null;
    turnIdx = 0;
    lastSummary = null;
    history = [];
    totals = freshTotals();
    tpsTrend = trendInit();
    stopTicker();
    if (ctx.hasUI) showIdle(ctx.ui);
  });

  pi.on("turn_start", async (event, ctx) => {
    genSpans = [];
    toolStarts.clear();
    toolSpans = [];
    turnStartTs = event.timestamp ?? Date.now();
    // Clear a stale ticker if a previous generation was aborted mid-stream.
    stopTicker();
    if (ctx.hasUI) showIdle(ctx.ui);
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    prefillStart = Date.now();
    firstTokenTs = null;
    thinkingStartTs = null;
    answerStartTs = null;
    if (enabled && ctx.hasUI) armTicker(ctx.ui, "prefill");
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const t = (event.assistantMessageEvent as { type?: string }).type ?? "";
    const now = Date.now();

    // First token of any kind ends prefill.
    firstTokenTs ??= now;
    if (t.startsWith("thinking")) thinkingStartTs ??= now;
    if (t.startsWith("text") || t.startsWith("toolcall")) answerStartTs ??= now;

    if (enabled && ctx.hasUI) {
      // Advance the live ticker: thinking first (if present), then decode once
      // the answer phase begins. answerStartTs takes priority so a late-arriving
      // thinking_delta after text has started never moves us backwards.
      if (answerStartTs !== null) armTicker(ctx.ui, "decode");
      else if (thinkingStartTs !== null) armTicker(ctx.ui, "thinking");
      else armTicker(ctx.ui, "decode");
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const m = event.message as AssistantMessage;
    const genEnd = Date.now();
    const preStart = prefillStart;

    if (preStart !== null) genSpans.push({ start: preStart, end: genEnd });

    // outputMs = full output window (first token -> end), includes thinking.
    // This is the tps denominator by design (option a): honest & turn-consistent.
    const outputMs = firstTokenTs !== null ? genEnd - firstTokenTs : 0;
    const prefillMs = preStart !== null ? (firstTokenTs ?? genEnd) - preStart : 0;
    const thinkingMs = thinkingStartTs !== null ? (answerStartTs ?? genEnd) - thinkingStartTs : 0;
    const output = m.usage?.output ?? 0;
    const input = m.usage?.input ?? 0;
    const tps = outputMs > 0 ? output / (outputMs / 1000) : 0;
    const model = m.model || ctx.model?.id || "?";

    // Fold into the decode-throughput trend. Only turns with a real output
    // window count — prefill-only / error turns would pollute the baseline.
    if (outputMs > 0 && output > 0) trendUpdate(tpsTrend, tps);

    lastSummary = { prefillMs, thinkingMs, outputMs, tps, output, input, model };

    totals.input += input;
    totals.output += output;
    totals.prefillMs += prefillMs;
    totals.thinkingMs += thinkingMs;
    totals.outputMs += outputMs;
    totals.cost += m.usage?.cost?.total ?? 0;

    // Persistent annotation under this assistant message. notify -> showStatus
    // renders a dim line in the chat scrollback; it's display-only, never
    // persisted to the session JSONL, so zero context pollution.
    if (ctx.hasUI) {
      ctx.ui.notify(formatMessageStats(input, output, prefillMs, outputMs, thinkingMs), "info");
    }

    // Write-only persistence: stash the per-turn timing in a `custom` session
    // entry (NOT sent to the LLM). Insurance for later analysis — the timing
    // data (prefill/thinking/output/tps) is otherwise irrecoverable from the
    // session file, which only stores completion timestamps + usage. No rebuild
    // path on /resume is implemented; this is never read back by the extension.
    pi.appendEntry("stats", {
      model,
      prefillMs,
      thinkingMs,
      outputMs,
      output,
      input,
      tps: Math.round(tps * 10) / 10,
      cacheRead: m.usage?.cacheRead ?? 0,
      cacheWrite: m.usage?.cacheWrite ?? 0,
      cost: m.usage?.cost?.total ?? 0,
      ts: genEnd,
    });

    resetGenerationState();
    stopTicker();
    if (ctx.hasUI) showIdle(ctx.ui);
  });

  pi.on("tool_execution_start", async (event) => {
    toolStarts.set(event.toolCallId, Date.now());
  });

  pi.on("tool_execution_end", async (event) => {
    const start = toolStarts.get(event.toolCallId);
    if (start !== undefined) {
      toolSpans.push({ start, end: Date.now() });
      toolStarts.delete(event.toolCallId);
    }
  });

  // Model change invalidates the throughput baseline — comparing oMLX decode
  // tps to a cloud model's (or two different quants) is noise, not trend.
  pi.on("model_select", async (_event, ctx) => {
    tpsTrend = trendInit();
    if (ctx.hasUI) showIdle(ctx.ui);
  });

  pi.on("turn_end", async (_event, ctx) => {
    const wallEnd = Date.now();
    const wallStart = turnStartTs ?? genSpans[0]?.start ?? wallEnd;
    const blockedMs = computeBlocked(wallStart, wallEnd, [...genSpans, ...toolSpans]);

    turnIdx += 1;
    history.push({
      idx: turnIdx,
      model: lastSummary?.model ?? ctx.model?.id ?? "?",
      prefillMs: lastSummary?.prefillMs ?? 0,
      thinkingMs: lastSummary?.thinkingMs ?? 0,
      outputMs: lastSummary?.outputMs ?? 0,
      output: lastSummary?.output ?? 0,
      input: lastSummary?.input ?? 0,
      tps: lastSummary?.tps ?? 0,
      blockedMs,
      wallMs: Math.max(0, wallEnd - wallStart),
    });
    if (history.length > HISTORY_LIMIT) history.shift();

    totals.turns += 1;
    totals.blockedMs += blockedMs;

    genSpans = [];
    toolStarts.clear();
    toolSpans = [];
    turnStartTs = null;
  });

  pi.on("agent_end", async (_event, ctx) => {
    stopTicker();
    if (ctx.hasUI) showIdle(ctx.ui);
  });

  // ── /stats command ──

  function buildStatsMessage(): string {
    const lines: string[] = ["Throughput stats", ""];

    if (lastSummary) {
      const s = lastSummary;
      lines.push(`Last response — ${s.model}`);
      const thinkStr = s.thinkingMs > 0 ? `   think ${formatDuration(s.thinkingMs)}` : "";
      lines.push(
        `  prefill ${formatDuration(s.prefillMs)}${thinkStr}   output ${formatDuration(
          s.outputMs,
        )}   ↓${formatTokens(s.output)}   ${formatTps(s.output, s.outputMs)}`,
      );
      lines.push("");
    }

    const avgTps = totals.outputMs > 0 ? totals.output / (totals.outputMs / 1000) : 0;
    lines.push(
      `Session — ${totals.turns} turns, ↓${formatTokens(totals.output)} out ↑${formatTokens(totals.input)} in`,
    );
    lines.push(
      `  prefill ${formatDuration(totals.prefillMs)}   think ${formatDuration(
        totals.thinkingMs,
      )}   output ${formatDuration(totals.outputMs)}   avg ${avgTps > 0 ? `${Math.round(avgTps)}t/s` : "—"}`,
    );
    lines.push(
      `  blocked ${formatDuration(totals.blockedMs)}${totals.cost > 0 ? `   $${totals.cost.toFixed(3)}` : ""}`,
    );

    if (history.length > 0) {
      lines.push("");
      lines.push("Recent turns");
      lines.push("  #   prefill     think    output     out   tps  blocked");
      for (const r of history.slice(-12)) {
        lines.push(
          `  ${String(r.idx).padStart(2, " ")}  ${formatDuration(r.prefillMs).padStart(8, " ")}  ${formatDuration(
            r.thinkingMs,
          ).padStart(7, " ")}  ${formatDuration(r.outputMs).padStart(8, " ")}  ${formatTokens(r.output).padStart(
            5,
            " ",
          )}  ${formatTps(r.output, r.outputMs).padStart(3, " ")}  ${formatDuration(r.blockedMs).padStart(8, " ")}`,
        );
      }
    }

    lines.push("");
    lines.push(`Live display: ${enabled ? "on" : "off"}`);
    return lines.join("\n");
  }

  pi.registerCommand("stats", {
    description: "Throughput stats (tokens/sec, prefill, thinking, blocked time)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      let msg = buildStatsMessage();
      while (true) {
        const choice = await ctx.ui.select(msg, [
          "Back",
          enabled ? "Hide live stats" : "Show live stats",
          "Reset stats",
        ]);
        if (!choice || choice === "Back") break;
        if (choice === "Reset stats") {
          history = [];
          totals = freshTotals();
          turnIdx = 0;
          lastSummary = null;
          showIdle(ctx.ui);
          ctx.ui.notify("Stats reset", "info");
        } else {
          enabled = !enabled;
          if (enabled) {
            showIdle(ctx.ui);
          } else {
            stopTicker();
            ctx.ui.setStatus("stats", undefined);
          }
          ctx.ui.notify(`Live stats: ${enabled ? "on" : "off"}`, "info");
        }
        msg = buildStatsMessage();
      }
    },
  });
}
