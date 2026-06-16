/**
 * Pure timing/throughput math for the stats extension.
 *
 * No pi imports — fully unit-testable.
 *
 * Terminology (per assistant message):
 *   prefill  = request sent  -> first generated token (prompt processing)
 *   decode   = first token    -> message_end          (token generation)
 *   wall     = turn_start     -> turn_end             (includes tools + blocking)
 *
 * Blocked time = wall - (generation + tool execution). This is the time the
 * agent spent waiting on something other than the model or tools — e.g. a
 * permission-gate confirmation dialog. Measured by subtraction, so it needs
 * no coupling to whichever extension does the blocking.
 */

export interface Span {
  start: number;
  end: number;
}

/** Merge overlapping or adjacent spans into a minimal set. */
export function mergeSpans(spans: Span[]): Span[] {
  const valid = spans.filter((s) => s.end >= s.start).map((s) => ({ start: s.start, end: s.end }));
  valid.sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of valid) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push(s);
    }
  }
  return out;
}

/** Total duration covered by a set of spans (union, not sum). */
export function unionDuration(spans: Span[]): number {
  return mergeSpans(spans).reduce((sum, s) => sum + (s.end - s.start), 0);
}

/**
 * Time within [wallStart, wallEnd] not covered by any active span.
 * Active spans are clipped to the wall first, so out-of-window time is ignored.
 */
export function computeBlocked(wallStart: number, wallEnd: number, active: Span[]): number {
  const wall = Math.max(0, wallEnd - wallStart);
  if (wall === 0) return 0;
  const clipped: Span[] = [];
  for (const s of active) {
    const start = Math.max(s.start, wallStart);
    const end = Math.min(s.end, wallEnd);
    if (end > start) clipped.push({ start, end });
  }
  return Math.max(0, wall - unionDuration(clipped));
}

/** Human duration: "320ms" | "1.2s" | "59s" | "2:03". */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 1000) return `${Math.round(clamped)}ms`;
  const s = clamped / 1000;
  if (s < 60) return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
  return formatClock(clamped);
}

/** Always M:SS (for live prefill clocks that can run minutes). */
export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms);
  const total = Math.floor(clamped / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Token counts: "480" | "5.2k" | "12k". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** Throughput over the full output window: "18t/s" | "—". Returns "—" when there's no window. */
export function formatTps(tokens: number, ms: number): string {
  if (ms <= 0 || tokens <= 0) return "—";
  return `${Math.round(tokens / (ms / 1000))}t/s`;
}

/**
 * Compact one-line summary for display under an assistant message.
 * Fixed field order so vertical scanning reveals patterns (e.g. declining tps):
 *   `PP 1.2s · ↑12k/↓480 · 200t/s`            (no thinking)
 *   `PP 1.2s · ✶25s · ↑12k/↓480 · 200t/s`     (with thinking)
 *
 * - prefill duration (explains local-model PP cost / correlates with input size)
 * - thinking duration, only when a reasoning phase ran and exceeded ~1s
 * - input/output tokens (real provider counts, not estimated)
 * - aggregate output throughput over the FULL output window (first token →
 *   message end, which includes thinking). It's low on heavy-thinking turns;
 *   read it next to the ✶time. `outputMs` is the full window by design.
 */
export function formatMessageStats(
  input: number,
  output: number,
  prefillMs: number,
  outputMs: number,
  thinkingMs = 0,
): string {
  const parts = [`PP ${formatDuration(prefillMs)}`];
  if (thinkingMs > 1000) parts.push(`✶${formatDuration(thinkingMs)}`);
  parts.push(`↑${formatTokens(input)}/↓${formatTokens(output)}`);
  parts.push(formatTps(output, outputMs));
  return parts.join(" · ");
}

/**
 * Decode-throughput trend via dual exponential moving average.
 *
 * Tracks a fast (recent) and slow (baseline) EMA of per-turn decode tps and
 * classifies the trend by their ratio. Comparing fast vs slow is more robust
 * than comparing consecutive turns — it surfaces genuine regime shifts
 * (e.g. local-model KV-cache pressure dragging decode down across a long
 * session) while ignoring turn-to-turn noise from context size / thinking
 * level / output length differences.
 *
 * Meaningful for local models; mostly noise on cloud (server load). The caller
 * decides whether to display it; the detector just does the math.
 */
const FAST_ALPHA = 0.4;
const SLOW_ALPHA = 0.08;
const TREND_MIN_SAMPLES = 3;
const TREND_THRESHOLD = 0.15; // 15% divergence fast vs slow

export interface TrendState {
  fast: number | null;
  slow: number | null;
  count: number;
}

export function trendInit(): TrendState {
  return { fast: null, slow: null, count: 0 };
}

/** Fold a per-turn decode tps into the detector. Skip non-finite / negative. */
export function trendUpdate(state: TrendState, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  state.count += 1;
  state.fast = state.fast === null ? value : FAST_ALPHA * value + (1 - FAST_ALPHA) * state.fast;
  state.slow = state.slow === null ? value : SLOW_ALPHA * value + (1 - SLOW_ALPHA) * state.slow;
}

export interface TrendView {
  /** The recent (fast) EMA value to display. null before the first sample. */
  value: number | null;
  /** "→" stable, "▼" declining, "▲" rising, "" not enough data. */
  arrow: string;
}

/** Classify the current trend. Needs >= TREND_MIN_SAMPLES and a nonzero baseline. */
export function trendView(state: TrendState): TrendView {
  if (state.fast === null || state.slow === null) return { value: null, arrow: "" };
  if (state.count < TREND_MIN_SAMPLES || state.slow <= 0) return { value: state.fast, arrow: "" };
  const ratio = state.fast / state.slow;
  if (ratio < 1 - TREND_THRESHOLD) return { value: state.fast, arrow: "▼" };
  if (ratio > 1 + TREND_THRESHOLD) return { value: state.fast, arrow: "▲" };
  return { value: state.fast, arrow: "→" };
}
