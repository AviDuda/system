/**
 * Model scan: discover interesting LLM models, detect config drift, find local MLX options.
 *
 * Usage:
 *   bun run scripts/model-scan.ts              # discover interesting ZDR-eligible models
 *   bun run scripts/model-scan.ts --drift       # check current pi.nix config for drift
 *   bun run scripts/model-scan.ts --local       # find trending MLX models via oMLX
 *   bun run scripts/model-scan.ts --model <repo> # estimate specific HF repo (repeatable)
 *   bun run scripts/model-scan.ts --json        # machine-readable output
 *
 * Data sources:
 *   - OpenRouter /api/v1/models (public) + /api/v1/models/user (ZDR-filtered)
 *   - Artificial Analysis /api/v2/data/llms/models (benchmarks, speed)
 *   - oMLX admin API (local MLX models, HF search)
 *   - ~/.pi/agent/models.json (current pi config)
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

// ── ANSI helpers ──

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

// ── Types ──

interface ORModel {
  id: string;
  name: string;
  context_length: number | null;
  pricing: { prompt: string; completion: string; input_cache_read?: string };
  architecture: { input_modalities: string[]; output_modalities: string[] };
  top_provider: { context_length?: number | null; max_completion_tokens?: number | null; is_moderated: boolean };
  supported_parameters: string[];
  hugging_face_id: string | null;
}

interface AAModel {
  id: string;
  name: string;
  slug: string;
  release_date: string | null;
  model_creator: { id: string; name: string; slug: string };
  evaluations: Record<string, number | null>;
  pricing: { price_1m_blended_3_to_1: number; price_1m_input_tokens: number; price_1m_output_tokens: number };
  median_output_tokens_per_second: number | null;
  median_time_to_first_token_seconds: number | null;
}

interface PiProvider {
  baseUrl?: string;
  models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>;
}

interface PiModelsFile {
  providers: Record<string, PiProvider>;
}

interface JoinedModel {
  orId: string;
  name: string;
  promptPrice: number;
  completionPrice: number;
  context: number;
  maxOutput: number;
  inputTypes: string[];
  hasReasoning: boolean;
  hasTools: boolean;
  aaCoding?: number;
  aaIntel?: number;
  aaSpeed?: number;
  aaLatency?: number;
  aaMmluPro?: number;
  aaLiveCodeBench?: number;
  creator: string;
}

// ── CLI args ──

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    drift: { type: "boolean", default: false },
    local: { type: "boolean", default: false },
    model: { type: "string", default: [], short: "m", multiple: true },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false, short: "v" },
    help: { type: "boolean", default: false, short: "h" },
  },
  strict: true,
  allowPositionals: true,
});

if (parsed.values.help) {
  console.log(
    `
${BOLD}model-scan${RESET} — discover LLM models, detect config drift, find local MLX options

${BOLD}USAGE${RESET}
  bun run scripts/model-scan.ts [options]

${BOLD}OPTIONS${RESET}
  --drift       Check current pi.nix config for price/spec drift
  --local       Find trending MLX models via oMLX admin API
  --model, -m   Estimate specific HF repo (repeatable, e.g. --model mlx-community/Qwen3.6-27B-4bit)
  --json        Output machine-readable JSON instead of formatted table
  --quiet       Suppress status messages on stderr
  --verbose, -v Include low-scoring models in output
  --help, -h    Show this help message

${BOLD}DATA SOURCES${RESET}
  OpenRouter    /api/v1/models (public) + /api/v1/models/user (ZDR-filtered)
  AA            /api/v2/data/llms/models (benchmarks, speed, pricing)
  oMLX          Admin API at localhost:8124 (local MLX models, HF search)
  pi.nix        ~/.pi/agent/models.json (current config for drift check)
`.trim(),
  );
  process.exit(0);
}

const modeDrift = parsed.values.drift;
const modeLocal = parsed.values.local;
const modeModels = parsed.values.model;
const modeJson = parsed.values.json;
const modeQuiet = parsed.values.quiet;
const verbose = parsed.values.verbose;

// ── Key resolution ──

function getOpenRouterKey(): string {
  try {
    return execSync("security find-generic-password -s openrouter-pi-main -w", { encoding: "utf-8" }).trim();
  } catch {
    console.error(`${RED}OpenRouter key not found in keychain (openrouter-pi-main)${RESET}`);
    process.exit(1);
  }
}

function getAAKey(): string {
  try {
    const secretsPath = join(import.meta.dirname ?? ".", "..", "secrets", "llm.yaml");
    return execSync(`sops --decrypt --extract '["artificialanalysis"]' "${secretsPath}"`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    console.error(`${RED}Artificial Analysis key not found in sops (secrets/llm.yaml:artificialanalysis)${RESET}`);
    process.exit(1);
  }
}

// ── Data fetching (with file cache) ──

const CACHE_DIR = join(homedir(), ".cache", "model-scan");
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

function readCache<T>(name: string): T | null {
  const p = join(CACHE_DIR, `${name}.json`);
  if (!existsSync(p)) return null;
  try {
    const fs = require("node:fs");
    const s = fs.statSync(p);
    if (Date.now() - s.mtimeMs > CACHE_TTL) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeCache(name: string, data: unknown): void {
  const fs = require("node:fs");
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(join(CACHE_DIR, `${name}.json`), JSON.stringify(data));
}

async function fetchORModels(): Promise<ORModel[]> {
  const cached = readCache<ORModel[]>("or-models");
  if (cached) {
    if (!modeQuiet) process.stderr.write(`${DIM}Using cached OpenRouter models${RESET}\n`);
    return cached;
  }
  if (!modeQuiet) process.stderr.write(`${DIM}Fetching OpenRouter models...${RESET}\n`);
  const res = await fetch("https://openrouter.ai/api/v1/models");
  const data = (await res.json()) as { data: ORModel[] };
  writeCache("or-models", data.data);
  return data.data;
}

async function fetchORUserModels(key: string): Promise<Set<string>> {
  const cached = readCache<string[]>("or-user-ids");
  if (cached) {
    if (!modeQuiet) process.stderr.write(`${DIM}Using cached ZDR models${RESET}\n`);
    return new Set(cached);
  }
  if (!modeQuiet) process.stderr.write(`${DIM}Fetching ZDR-eligible models...${RESET}\n`);
  const res = await fetch("https://openrouter.ai/api/v1/models/user", {
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = (await res.json()) as { data: ORModel[] };
  const ids = data.data.map((m: ORModel) => m.id);
  writeCache("or-user-ids", ids);
  return new Set(ids);
}

async function fetchAAModels(key: string): Promise<AAModel[]> {
  const cached = readCache<AAModel[]>("aa-models");
  if (cached) {
    if (!modeQuiet) process.stderr.write(`${DIM}Using cached Artificial Analysis benchmarks${RESET}\n`);
    return cached;
  }
  if (!modeQuiet) process.stderr.write(`${DIM}Fetching Artificial Analysis benchmarks...${RESET}\n`);
  const res = await fetch("https://artificialanalysis.ai/api/v2/data/llms/models", {
    headers: { "x-api-key": key },
  });
  const data = (await res.json()) as { data: AAModel[] };
  writeCache("aa-models", data.data);
  return data.data;
}

function loadPiConfig(): PiModelsFile | null {
  const path = join(homedir(), ".pi", "agent", "models.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ── Join logic ──

function buildAALookup(aaModels: AAModel[]): Map<string, AAModel> {
  const lookup = new Map<string, AAModel>();
  for (const m of aaModels) {
    // Index by slug (e.g. "deepseek-v4-flash")
    lookup.set(m.slug, m);
    // Also index by "creator/slug" pattern
    if (m.model_creator?.slug) {
      lookup.set(`${m.model_creator.slug}/${m.slug}`, m);
    }
  }
  return lookup;
}

function joinORWithAA(orModel: ORModel, aaLookup: Map<string, AAModel>): AAModel | undefined {
  const parts = orModel.id.split("/");
  const slug = (parts.length > 1 ? parts[parts.length - 1] : orModel.id) ?? orModel.id;
  const normalized = slug.replace(/\./g, "-");
  const creatorPart = parts[0] ?? "";
  return (
    aaLookup.get(slug) ??
    aaLookup.get(orModel.id) ??
    aaLookup.get(normalized) ??
    aaLookup.get(parts.length > 1 ? `${creatorPart}/${normalized}` : normalized)
  );
}

function parsePrice(p: string): number {
  const v = parseFloat(p);
  if (v <= 0) return NaN; // "-1" is OpenRouter sentinel for dynamic/auto-routing pricing
  return v * 1_000_000;
}

// ── Formatting helpers ──

function fmtPrice(p: number): string {
  if (Number.isNaN(p)) return "(dynamic)";
  if (p < 0.001) return `$${p.toFixed(4)}`;
  if (p < 1) return `$${p.toFixed(3)}`;
  return `$${p.toFixed(2)}`;
}

function fmtScore(v: number | undefined | null, width = 5): string {
  if (v == null) return `${DIM}${"".padStart(width)}${RESET}`;
  const s = v.toFixed(1);
  if (v >= 45) return `${GREEN}${s.padStart(width)}${RESET}`;
  if (v >= 30) return `${YELLOW}${s.padStart(width)}${RESET}`;
  return `${DIM}${s.padStart(width)}${RESET}`;
}

function fmtSpeed(v: number | undefined | null): string {
  if (v == null) return `${DIM}   --${RESET}`;
  return `${CYAN}${v.toFixed(0).padStart(4)}${RESET}`;
}

function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function fmtInput(types: string[]): string {
  if (types.includes("image")) return "txt+img";
  return "txt";
}

// ── Local model estimation ──

const SYSTEM_OVERHEAD_GB = 8; // macOS + apps + oMLX overhead

interface ModelEstimate {
  type: "dense" | "moe";
  tokPerSec: number;
  tokConfidence: "high" | "medium" | "low";
  headroomGB: number;
  comfort: "comfortable" | "tight" | "cramped" | "overflow";
}

function getSystemRAMGB(): number {
  try {
    const memsize = execSync("sysctl -n hw.memsize", { encoding: "utf-8" }).trim();
    return Math.round(parseInt(memsize, 10) / 1024 ** 3);
  } catch {
    return 48;
  }
}

/**
 * Estimate generation performance on Apple Silicon.
 *
 * Dense models: memory-bandwidth bound, tok/s scales inversely with size.
 * MoE models: only active experts loaded per token. Scaling follows
 *   tok/s = dense_ref * (total_params / active_params)^0.35
 * The exponent < 1 captures routing overhead that partially offsets sparsity benefit.
 * Calibrated against measured: 35B-A3B-UD at ~36.5 tok/s.
 *
 * Known benchmarks (dense) from oMLX community, M4 Pro 16c:
 */
function estimateModel(sizeBytes: number, repoId: string, totalRAMGB: number): ModelEstimate {
  const sizeGB = sizeBytes / 1e9;
  const available = totalRAMGB - SYSTEM_OVERHEAD_GB;
  const headroomGB = Math.round((available - sizeGB) * 10) / 10;
  const lower = repoId.toLowerCase();

  const isMoE = /a[34]b|[_-]moe/i.test(lower);
  const type = isMoE ? ("moe" as const) : ("dense" as const);

  // Extract parameter counts from repo ID for MoE models.
  // Patterns: "35B-A3B" (total 35B, active 3B), "26B-A4B" (total 26B, active 4B)
  // Also handles: "30B-A3B", "48B-A3B", "21B-A3B" etc.
  const totalMatch = lower.match(/(\d+(?:\.\d+)?)b[._-]a(\d+(?:\.\d+)?)b/);
  const moeMatch = lower.match(/a(\d+(?:\.\d+)?)b/);
  const totalParamsB = totalMatch?.[1] ? parseFloat(totalMatch[1]) : null;
  const activeParamsB =
    totalParamsB && totalMatch?.[2] ? parseFloat(totalMatch[2]) : moeMatch?.[1] ? parseFloat(moeMatch[1]) : null;

  // Known dense benchmarks: [pattern, tokPerSec, refSizeGB]
  const denseRefs: Array<[RegExp, number, number]> = [
    [/qwen3\.6-27b/i, 15.1, 15.0],
    [/qwen3\.5-27b/i, 14.8, 15.0],
    [/gemma-4-31b/i, 10.2, 17.1],
    [/qwen3\.5-9b/i, 48.0, 5.5],
    [/glm-4\.7/i, 14.0, 23.8],
    [/llama-3\.2-1b/i, 120, 0.7],
    [/qwen2\.5-0\.5b/i, 180, 0.3],
  ];

  let tokPerSec: number;
  let tokConfidence: ModelEstimate["tokConfidence"];

  const known = denseRefs.find(([pat]) => pat.test(lower));
  if (known) {
    tokPerSec = known[1] * (known[2] / sizeGB);
    tokConfidence = "high";
  } else if (isMoE && activeParamsB && totalParamsB) {
    // MoE: compute-based estimate.
    // Generation = attention + MLP + KV-cache overhead.
    // MLP scales with active params; attention/KV are fixed per architecture.
    // speedup = 1 / (1 - mlp_share + mlp_share * (active/total))
    // Calibrated against measured: 35B-A3B-UD at 36.5 tok/s.
    // UD variant is ~1.7x faster than standard 4-bit (kernel optimizations).
    // So standard 4-bit 35B-A3B baseline = 36.5 / 1.7 = 21.5 tok/s.
    const mlpShare = 0.5;
    const udRefTok = 36.5; // measured: Qwen3.6-35B-A3B-UD
    const udToStdFactor = 1.7; // UD ~1.7x faster than standard 4-bit
    const stdRefAtSize = udRefTok / udToStdFactor; // 21.5 tok/s for standard 4-bit
    const speedup = 1 / (1 - mlpShare + mlpShare * (activeParamsB / totalParamsB));
    tokPerSec = stdRefAtSize * speedup;
    tokConfidence = "medium";
  } else if (isMoE) {
    // MoE without known active params -- rough guess
    tokPerSec = 30;
    tokConfidence = "low";
  } else {
    // Scale from Qwen 27B reference (best dense reference point)
    tokPerSec = 15.1 * (15.0 / sizeGB);
    tokConfidence = "medium";
  }

  let comfort: ModelEstimate["comfort"];
  if (headroomGB < 0) comfort = "overflow";
  else if (headroomGB < 6) comfort = "cramped";
  else if (headroomGB < 14) comfort = "tight";
  else comfort = "comfortable";

  return { type, tokPerSec: Math.round(tokPerSec), tokConfidence, headroomGB, comfort };
}

function fmtComfort(c: ModelEstimate["comfort"]): string {
  switch (c) {
    case "comfortable":
      return `${GREEN}ok${RESET}`;
    case "tight":
      return `${YELLOW}tight${RESET}`;
    case "cramped":
      return `${RED}tight${RESET}`;
    case "overflow":
      return `${RED}NO${RESET}`;
  }
}

function fmtEstTokPerSec(est: ModelEstimate): string {
  const s = `${est.tokPerSec}`;
  switch (est.tokConfidence) {
    case "high":
      return `${GREEN}${s}${RESET}`;
    case "medium":
      return `${YELLOW}~${s}${RESET}`;
    case "low":
      return `${DIM}?${s}${RESET}`;
  }
}

// ── Discover mode ──

async function discover(): Promise<void> {
  const orKey = getOpenRouterKey();
  const aaKey = getAAKey();

  const [orModels, zdrIds, aaModels] = await Promise.all([
    fetchORModels(),
    fetchORUserModels(orKey),
    fetchAAModels(aaKey),
  ]);

  const aaLookup = buildAALookup(aaModels);

  // Filter: ZDR-eligible, has pricing, reasonable size
  const candidates: JoinedModel[] = [];

  for (const m of orModels) {
    if (!zdrIds.has(m.id)) continue;
    const prompt = parseFloat(m.pricing.prompt);
    const completion = parseFloat(m.pricing.completion);
    if (prompt <= 0 || completion <= 0) continue; // skip free tier
    if (!m.architecture.input_modalities.includes("text")) continue;

    const aa = joinORWithAA(m, aaLookup);
    const maxOut = m.top_provider.max_completion_tokens ?? 0;

    candidates.push({
      orId: m.id,
      name: m.name,
      promptPrice: parsePrice(m.pricing.prompt),
      completionPrice: parsePrice(m.pricing.completion),
      context: m.context_length ?? 0,
      maxOutput: maxOut,
      inputTypes: m.architecture.input_modalities,
      hasReasoning:
        m.supported_parameters.includes("reasoning") || m.supported_parameters.includes("include_reasoning"),
      hasTools: m.supported_parameters.includes("tools"),
      aaCoding: aa?.evaluations?.artificial_analysis_coding_index ?? undefined,
      aaIntel: aa?.evaluations?.artificial_analysis_intelligence_index ?? undefined,
      aaSpeed: aa?.median_output_tokens_per_second ?? undefined,
      aaLatency: aa?.median_time_to_first_token_seconds ?? undefined,
      aaMmluPro: aa?.evaluations?.mmlu_pro ?? undefined,
      aaLiveCodeBench: aa?.evaluations?.livecodebench ?? undefined,
      creator: m.id.split("/")[0] ?? "",
    });
  }

  // Sort by coding index descending (models without benchmarks go last)
  candidates.sort((a, b) => (b.aaCoding ?? -1) - (a.aaCoding ?? -1));

  if (modeJson) {
    console.log(JSON.stringify(candidates, null, 2));
    return;
  }

  // ── Print table ──
  const tableRows = candidates
    .filter((m) => (m.aaCoding ?? 0) >= 15 || verbose)
    .map((m) => ({
      Model: m.orId,
      Coding: fmtScore(m.aaCoding),
      Intel: fmtScore(m.aaIntel),
      Speed: fmtSpeed(m.aaSpeed),
      "In/M": fmtPrice(m.promptPrice),
      "Out/M": fmtPrice(m.completionPrice),
      Ctx: fmtCtx(m.context),
      "I/O": fmtInput(m.inputTypes),
      Tools: `${m.hasTools ? `${GREEN}✓${RESET}` : `${DIM}✗${RESET}`}${m.hasReasoning ? ` ${CYAN}R${RESET}` : ""}`,
    }));

  console.log(
    `\n${BOLD}ZDR-eligible models ranked by coding quality${RESET}  ${DIM}(${tableRows.length} models)${RESET}`,
  );
  console.log(
    Bun.inspect.table(tableRows, ["Model", "Coding", "Intel", "Speed", "In/M", "Out/M", "Ctx", "I/O", "Tools"]),
  );

  // ── Highlights ──
  console.log(`\n${BOLD}Highlights${RESET}`);

  // Best coding for cheap (< $1/M input)
  const cheap = candidates.filter((m) => m.promptPrice < 1 && m.aaCoding != null);
  const bestCheap = cheap[0];
  if (bestCheap) {
    console.log(
      `  Best cheap coding: ${CYAN}${bestCheap.orId}${RESET} (coding=${bestCheap.aaCoding}, ${fmtPrice(bestCheap.promptPrice)}/M in)`,
    );
  }

  // Best coding overall
  const withCoding = candidates.filter((m) => m.aaCoding != null);
  const bestOverall = withCoding[0];
  if (bestOverall) {
    console.log(`  Best coding overall: ${CYAN}${bestOverall.orId}${RESET} (coding=${bestOverall.aaCoding})`);
  }

  // Fastest with decent quality
  const decent = candidates.filter((m) => (m.aaCoding ?? 0) >= 25 && m.aaSpeed != null);
  if (decent.length > 0) {
    decent.sort((a, b) => (b.aaSpeed ?? 0) - (a.aaSpeed ?? 0));
    const fastest = decent[0];
    if (fastest) {
      console.log(
        `  Fastest decent quality: ${CYAN}${fastest.orId}${RESET} (${fastest.aaSpeed} tok/s, coding=${fastest.aaCoding})`,
      );
    }
  }

  // 1M context with benchmarks
  const bigCtx = candidates.filter((m) => m.context >= 900_000 && m.aaCoding != null);
  if (bigCtx.length > 0) {
    bigCtx.sort((a, b) => (b.aaCoding ?? 0) - (a.aaCoding ?? 0));
    const bestCtx = bigCtx[0];
    if (bestCtx) {
      console.log(
        `  Best 1M context: ${CYAN}${bestCtx.orId}${RESET} (coding=${bestCtx.aaCoding}, ${fmtCtx(bestCtx.context)})`,
      );
    }
  }
}

// ── Drift mode ──

async function drift(): Promise<void> {
  const piConfig = loadPiConfig();
  if (!piConfig) {
    console.error(`${RED}No pi config found at ~/.pi/agent/models.json${RESET}`);
    process.exit(1);
  }

  const [orModels, aaModels] = await Promise.all([fetchORModels(), fetchAAModels(getAAKey())]);

  const orLookup = new Map(orModels.map((m) => [m.id, m]));
  const aaLookup = buildAALookup(aaModels);

  console.log(`\n${BOLD}Config drift check${RESET}\n`);

  for (const [providerName, provider] of Object.entries(piConfig.providers)) {
    for (const model of provider.models) {
      const isOpenRouter = providerName.startsWith("openrouter");
      const orId = model.id; // OR model IDs are like "deepseek/deepseek-v3.2", not "openrouter-main/deepseek/..."
      const orModel = isOpenRouter ? orLookup.get(orId) : undefined;

      if (isOpenRouter) {
        if (!orModel) {
          console.log(`  ${RED}MISSING${RESET} ${orId} -- not found on OpenRouter`);
          continue;
        }

        // Price check
        const prompt = parsePrice(orModel.pricing.prompt);
        const completion = parsePrice(orModel.pricing.completion);

        const priceStr = Number.isNaN(prompt) ? "(dynamic)" : `${fmtPrice(prompt)}/${fmtPrice(completion)} per M`;

        console.log(`  ${orId}`);
        console.log(
          `    Current: ${priceStr}  ctx=${fmtCtx(orModel.context_length ?? 0)}  max_out=${orModel.top_provider.max_completion_tokens ?? "?"}`,
        );

        // AA benchmarks if available
        const aa = joinORWithAA(orModel, aaLookup);
        if (aa?.evaluations) {
          const e = aa.evaluations;
          const parts: string[] = [];
          if (e.artificial_analysis_coding_index != null) parts.push(`coding=${e.artificial_analysis_coding_index}`);
          if (e.artificial_analysis_intelligence_index != null)
            parts.push(`intel=${e.artificial_analysis_intelligence_index}`);
          if (aa.median_output_tokens_per_second != null)
            parts.push(`speed=${aa.median_output_tokens_per_second.toFixed(0)}tok/s`);
          if (parts.length > 0) {
            console.log(`    Benchmarks: ${parts.join("  ")}`);
          }
        }

        // Check for newer/better models from same creator
        const currentAa = joinORWithAA(orModel, aaLookup);
        if (currentAa?.model_creator && currentAa?.evaluations) {
          const currentCreator = currentAa.model_creator.slug;
          const currentCoding = currentAa.evaluations.artificial_analysis_coding_index ?? 0;
          const currentDate = currentAa.release_date;

          const betterModels = aaModels
            .filter(
              (m) =>
                m.model_creator.slug === currentCreator &&
                (m.evaluations.artificial_analysis_coding_index ?? 0) > currentCoding &&
                (m.release_date ?? "") > (currentDate ?? ""),
            )
            .sort(
              (a, b) =>
                (b.evaluations.artificial_analysis_coding_index ?? 0) -
                (a.evaluations.artificial_analysis_coding_index ?? 0),
            )
            .slice(0, 3);

          for (const bm of betterModels) {
            const orMatch = orLookup.get(bm.slug) ?? orLookup.get(bm.name);
            const price = orMatch
              ? fmtPrice(parsePrice(orMatch.pricing.prompt))
              : fmtPrice(bm.pricing.price_1m_input_tokens);
            console.log(
              `    ${YELLOW}Better?${RESET} ${bm.name} (coding=${bm.evaluations.artificial_analysis_coding_index}, ${price}/M in)`,
            );
          }
        }
      } else {
        // Local provider -- just report
        console.log(`  ${DIM}${orId}${RESET} (local/provider, not checked)`);
      }
    }
  }
}

// ── Local mode ──

async function local(): Promise<void> {
  const omlxBase = "http://127.0.0.1:8124/admin/api";

  // Check oMLX is running
  try {
    await fetch(`${omlxBase.replace("/admin/api", "")}/health`);
  } catch {
    console.error(`${RED}oMLX not running at localhost:8124${RESET}`);
    process.exit(1);
  }

  // Get current loaded models
  const modelsRes = await fetch(`${omlxBase}/models`);
  const modelsData = await (modelsRes.json() as Promise<{
    models: Array<{
      id: string;
      loaded: boolean;
      estimated_size: number;
      estimated_size_formatted: string;
      pinned: boolean;
    }>;
  }>);
  const currentModels = modelsData.models;

  // Get trending MLX models
  if (!modeQuiet) process.stderr.write(`${DIM}Fetching trending MLX models from oMLX...${RESET}\n`);
  const trendingRes = await fetch(`${omlxBase}/hf/recommended?mlx_only=true`);
  const trendingData = await (trendingRes.json() as Promise<{
    trending: Array<{
      repo_id: string;
      name: string;
      downloads: number;
      likes: number;
      trending_score: number;
      size_formatted: string;
      size: number;
      params_formatted: string;
    }>;
  }>);
  const trending = trendingData.trending ?? [];

  if (modeJson) {
    console.log(JSON.stringify({ currentModels, trending }, null, 2));
    return;
  }

  // RAM budget
  const totalRAM = getSystemRAMGB();
  const available = totalRAM - SYSTEM_OVERHEAD_GB;

  console.log(
    `\n${BOLD}RAM Budget: ${totalRAM} GB${RESET}  ${DIM}(system ~${SYSTEM_OVERHEAD_GB} GB, inference ~${available} GB)${RESET}`,
  );

  // Show current models
  console.log(`\n${BOLD}Current oMLX models${RESET}`);
  console.log(
    Bun.inspect.table(
      currentModels.map((m) => {
        const est = estimateModel(m.estimated_size, m.id, totalRAM);
        return {
          Model: m.id,
          Size: m.estimated_size_formatted,
          Status: `${m.loaded ? `${GREEN}loaded${RESET}` : `${DIM}idle${RESET}`}${m.pinned ? ` ${YELLOW}pin${RESET}` : ""}`,
          "tok/s": fmtEstTokPerSec(est),
          Headroom: `${est.headroomGB > 0 ? est.headroomGB : `${RED}${est.headroomGB}${RESET}`} GB`,
          Fit: fmtComfort(est.comfort),
        };
      }),
      ["Model", "Size", "Status", "tok/s", "Headroom", "Fit"],
    ),
  );

  // Show trending
  const alreadyDownloaded = new Set(currentModels.map((m) => m.id));

  console.log(`\n${BOLD}Trending MLX models${RESET}  ${DIM}(top 20, estimates for ${totalRAM} GB)${RESET}`);
  console.log(
    Bun.inspect.table(
      trending.slice(0, 20).map((m) => {
        const est = estimateModel(m.size, m.repo_id, totalRAM);
        const dl = m.downloads > 1000 ? `${(m.downloads / 1000).toFixed(1)}K` : String(m.downloads);
        const has = alreadyDownloaded.has(m.repo_id) ? ` ${GREEN}✓${RESET}` : "";
        return {
          Repo: m.repo_id,
          Size: m.size_formatted,
          Type: est.type === "moe" ? `${YELLOW}MoE${RESET}` : `dense`,
          "tok/s": fmtEstTokPerSec(est),
          Headroom: `${est.headroomGB > 0 ? est.headroomGB : `${RED}${est.headroomGB}${RESET}`} GB`,
          Fit: fmtComfort(est.comfort),
          DL: dl + has,
        };
      }),
      ["Repo", "Size", "Type", "tok/s", "Headroom", "Fit", "DL"],
    ),
  );

  // ── Recommended picks (quality-ranked) ──
  // Use AA benchmarks + OR open-weight data to rank models by quality.
  // Supplement trending with HF searches for known open-weight families.
  const isNotJunk = (repo: string) => !/tts|asr|voice|speech|privacy.?filter|embed|rerank/i.test(repo);
  const seriousFromTrending = trending
    .filter((m) => m.size >= 5_000_000_000 && isNotJunk(m.repo_id))
    .map((m) => ({ ...m, est: estimateModel(m.size, m.repo_id, totalRAM) }))
    .filter((m) => m.est.headroomGB >= 10 && m.est.comfort !== "overflow");

  // Load OR and AA data early for family discovery and benchmark matching
  let orModels: ORModel[] = [];
  try {
    orModels = await fetchORModels();
  } catch {
    // OR not available
  }
  let aaModels: AAModel[] = [];
  try {
    const aaKey = getAAKey();
    aaModels = await fetchAAModels(aaKey);
  } catch {
    // AA not available
  }
  const aaLookup = buildAALookup(aaModels);
  const orHfToId = new Map<string, string>();
  for (const m of orModels) {
    if (m.hugging_face_id) {
      orHfToId.set(m.hugging_face_id.toLowerCase(), m.id);
    }
  }

  // Candidate pool is built after deduplication (below)

  // Search HF for open-weight model families (derived from OR models with HF IDs)
  // Extract unique model family names from HuggingFace IDs, deduplicate by org/name.
  const seenFamilies = new Set<string>();
  const searchFamilies: string[] = [];
  for (const m of orModels) {
    if (!m.hugging_face_id) continue;
    const hfName = m.hugging_face_id.split("/").pop() ?? "";
    const base = hfName.replace(/-(instruct|it|chat|base|v\d+|\d+b|a\d+b|fp\d+|bf\d+|gptq|awq|mlx).*$/i, "");
    if (base && !seenFamilies.has(base.toLowerCase())) {
      seenFamilies.add(base.toLowerCase());
      searchFamilies.push(base);
    }
  }

  if (!modeQuiet) {
    const cachedCount = searchFamilies.filter((f) => readCache(`hf-search-${f.toLowerCase()}`)).length;
    const freshCount = searchFamilies.length - cachedCount;
    process.stderr.write(
      `${DIM}Searching HF for ${searchFamilies.length} families (${cachedCount} cached, ${freshCount} fresh)...${RESET}\n`,
    );
  }
  const searchPromises = searchFamilies.map(async (family) => {
    const cacheKey = `hf-search-${family.toLowerCase()}`;
    const cached = readCache<{
      models: Array<{
        repo_id: string;
        size: number;
        size_formatted: string;
        downloads: number;
        likes: number;
        trending_score: number;
        params_formatted: string;
      }>;
    }>(cacheKey);
    if (cached) return cached.models;
    try {
      const res = await fetch(
        `${omlxBase}/hf/search?q=${encodeURIComponent(family)}&sort=downloads&limit=20&mlx_only=true`,
      );
      const data = (await res.json()) as {
        models: Array<{
          repo_id: string;
          size: number;
          size_formatted: string;
          downloads: number;
          likes: number;
          trending_score: number;
          params_formatted: string;
        }>;
      };
      const models = data.models ?? [];
      writeCache(cacheKey, { models });
      return models;
    } catch {
      return [];
    }
  });
  const searchResults = await Promise.all(searchPromises);
  // Deduplicate by model identity: extract base model name ignoring org, quant, and variant tags.
  const familyBest = new Map<
    string,
    {
      repo_id: string;
      size: number;
      size_formatted: string;
      downloads: number;
      est: ModelEstimate;
    }
  >();

  // Extract a canonical model identity key from a repo ID.
  // Strip org, quant suffixes, variant tags, and format indicators.
  // e.g. "mlx-community/Qwen3.6-27B-4bit" -> "qwen3.6-27b"
  //      "OrchardPair/Qwen3.6-27B-OptiQ-4bit" -> "qwen3.6-27b"
  //      "dealignai/Gemma-4-31B-JANG_4M-CRACK" -> "gemma-4-31b-jang_4m-crack" (fine-tune identity preserved)
  const modelIdentity = (repo: string): string => {
    // Drop org prefix
    const name = (repo.includes("/") ? repo.split("/").pop() : repo) ?? repo;
    return (
      name
        // Strip quant/format suffixes
        .replace(
          /[-_.](4bit|8bit|6bit|5bit|4\.5bit|3bit|2bit|2\.6bit|nvfp4|mxfp4|mxfp8|bf16|fp16|fp32|q[2-8](_[a-z]+)?|ud-mlx|ud-q[68]_xl|mlx-tuned|oq\d?|dwq|qat)$/i,
          "",
        )
        .replace(/[-_.](mlx|mixed_\d+_\d+|mlx-\d+bit)$/i, "")
        // Strip trailing quant indicators embedded in name
        .replace(/[-_](\d+)\s*(bit|b\s*$)/i, "")
        .toLowerCase()
    );
  };

  const addIfBest = (
    m: { repo_id: string; size: number; size_formatted: string; downloads: number },
    est: ModelEstimate,
  ) => {
    if (m.size < 1_000_000_000 || !isNotJunk(m.repo_id)) return;
    if (est.headroomGB < 10 || est.comfort === "overflow") return;
    const key = modelIdentity(m.repo_id);
    const existing = familyBest.get(key);
    const alreadyHas = alreadyDownloaded.has(m.repo_id);
    const existingAlreadyHas = existing ? alreadyDownloaded.has(existing.repo_id) : false;
    if (
      !existing ||
      (alreadyHas && !existingAlreadyHas) ||
      (alreadyHas === existingAlreadyHas && m.downloads > existing.downloads)
    ) {
      familyBest.set(key, {
        repo_id: m.repo_id,
        size: m.size,
        size_formatted: m.size_formatted,
        downloads: m.downloads,
        est,
      });
    }
  };

  for (const m of seriousFromTrending) {
    addIfBest(m, m.est);
  }
  for (const models of searchResults) {
    for (const m of models) {
      if (!m.repo_id) continue;
      const est = estimateModel(m.size, m.repo_id, totalRAM);
      addIfBest(m, est);
    }
  }

  // Build final candidate list from deduplicated family bests
  const candidateRepos = new Map([...familyBest.entries()].map(([, v]) => [v.repo_id, v]));

  // Match each candidate to AA benchmarks
  interface RankedModel {
    repo_id: string;
    size: number;
    size_formatted: string;
    downloads: number;
    est: ModelEstimate;
    aaCoding: number | null;
    aaIntel: number | null;
    aaQualityScore: number;
  }

  const ranked: RankedModel[] = [];
  for (const m of candidateRepos.values()) {
    let aaCoding: number | null = null;
    let aaIntel: number | null = null;

    // Try matching repo -> OR (via HF ID) -> AA
    const repoLower = m.repo_id.toLowerCase();
    for (const [hfId, orId] of orHfToId) {
      const hfName = hfId.split("/").pop() ?? "";
      if (repoLower.includes(hfName.replace(/-/g, "")) || repoLower.includes(hfName)) {
        const orModel = orModels.find((o) => o.id === orId);
        if (orModel) {
          const aa = joinORWithAA(orModel, aaLookup);
          if (aa?.evaluations) {
            aaCoding = aa.evaluations.artificial_analysis_coding_index ?? null;
            aaIntel = aa.evaluations.artificial_analysis_intelligence_index ?? null;
          }
        }
        break;
      }
    }

    // Fallback: direct slug match from AA
    if (aaCoding === null) {
      for (const [, aa] of aaLookup) {
        const aaSlug = aa.slug.toLowerCase();
        const repoFamily = repoLower.split("/").pop()?.split("-").slice(0, 3).join("-") ?? "";
        if (aaSlug.includes(repoFamily) || repoLower.includes(aaSlug)) {
          aaCoding = aa.evaluations?.artificial_analysis_coding_index ?? null;
          aaIntel = aa.evaluations?.artificial_analysis_intelligence_index ?? null;
          break;
        }
      }
    }

    // Quality score: AA coding index if available, else heuristic from size
    let aaQualityScore: number;
    if (aaCoding !== null) {
      aaQualityScore = aaCoding;
    } else if (m.est.type === "moe") {
      aaQualityScore = 20;
    } else {
      const sizeGB = m.size / 1e9;
      if (sizeGB > 20) aaQualityScore = 30;
      else if (sizeGB > 14) aaQualityScore = 25;
      else if (sizeGB > 8) aaQualityScore = 18;
      else aaQualityScore = 10;
    }

    ranked.push({
      repo_id: m.repo_id,
      size: m.size,
      size_formatted: m.size_formatted,
      downloads: m.downloads,
      est: m.est,
      aaCoding,
      aaIntel,
      aaQualityScore,
    });
  }

  // Separate dense and MoE, sort by quality score
  const dense = ranked.filter((m) => m.est.type === "dense").sort((a, b) => b.aaQualityScore - a.aaQualityScore);
  const moe = ranked.filter((m) => m.est.type === "moe").sort((a, b) => b.aaQualityScore - a.aaQualityScore);

  const fmtRanked = (m: RankedModel) => {
    const has = alreadyDownloaded.has(m.repo_id) ? ` ${GREEN}(yours)${RESET}` : "";
    const coding =
      m.aaCoding != null ? fmtScore(m.aaCoding, 5) : `${DIM}~${m.aaQualityScore.toFixed(0).padStart(4)}${RESET}`;
    return {
      Repo: m.repo_id + has,
      Size: m.size_formatted,
      Coding: coding,
      "tok/s": fmtEstTokPerSec(m.est),
      Headroom: `${m.est.headroomGB} GB`,
      DL: m.downloads > 1000 ? `${(m.downloads / 1000).toFixed(1)}K` : String(m.downloads),
    };
  };

  const MAX_ROWS = verbose ? 100 : 25;

  if (dense.length > 0) {
    const rows = dense.slice(0, MAX_ROWS);
    console.log(
      `\n${BOLD}Dense (quality)${RESET}  ${DIM}(all params active, sorted by coding benchmark, top ${rows.length})${RESET}`,
    );
    console.log(Bun.inspect.table(rows.map(fmtRanked), ["Repo", "Size", "Coding", "tok/s", "Headroom", "DL"]));
  }

  if (moe.length > 0) {
    const rows = moe.slice(0, MAX_ROWS);
    console.log(
      `\n${BOLD}MoE (speed)${RESET}  ${DIM}(sparse active params, sorted by coding benchmark, top ${rows.length})${RESET}`,
    );
    console.log(Bun.inspect.table(rows.map(fmtRanked), ["Repo", "Size", "Coding", "tok/s", "Headroom", "DL"]));
  }
}

// ── Model query mode ──

interface ModelQueryResult {
  repo_id: string;
  found: boolean;
  size?: number;
  size_formatted?: string;
  params?: number;
  params_formatted?: string;
  downloads?: number;
  est?: ModelEstimate;
  aaCoding?: number | null;
  aaIntel?: number | null;
  error?: string;
}

async function modelQuery(): Promise<void> {
  const omlxBase = "http://127.0.0.1:8124/admin/api";

  // Check oMLX is running
  try {
    await fetch(`${omlxBase.replace("/admin/api", "")}/health`);
  } catch {
    console.error(`${RED}oMLX not running at localhost:8124${RESET}`);
    process.exit(1);
  }

  if (modeModels.length === 0) {
    console.error(`${RED}No models specified. Use --model <repo_id> (repeatable).${RESET}`);
    process.exit(1);
  }

  const totalRAM = getSystemRAMGB();
  const results: ModelQueryResult[] = [];

  // Fetch AA data for benchmark matching (once)
  let aaModels: AAModel[] = [];
  let aaLookup = buildAALookup(aaModels);
  const orHfToId = new Map<string, string>();
  let orModels: ORModel[] = [];
  try {
    const aaKey = getAAKey();
    aaModels = await fetchAAModels(aaKey);
    aaLookup = buildAALookup(aaModels);
    orModels = await fetchORModels();
    for (const m of orModels) {
      if (m.hugging_face_id) {
        orHfToId.set(m.hugging_face_id.toLowerCase(), m.id);
      }
    }
  } catch {
    // AA/OR unavailable — will show no benchmarks
  }

  // Fetch model info for each repo
  const fetchPromises = modeModels.map(async (repo) => {
    const result: ModelQueryResult = { repo_id: repo, found: false };
    try {
      const res = await fetch(`${omlxBase}/hf/model-info?repo_id=${encodeURIComponent(repo)}`);
      const data = (await res.json()) as {
        repo_id: string;
        size: number;
        size_formatted: string;
        params: number;
        params_formatted: string;
        downloads: number;
      };
      if (res.ok && data.repo_id) {
        result.found = true;
        result.size = data.size;
        result.size_formatted = data.size_formatted;
        result.params = data.params;
        result.params_formatted = data.params_formatted;
        result.downloads = data.downloads;
        result.est = estimateModel(data.size, data.repo_id, totalRAM);

        // Try to match AA benchmarks
        const repoLower = data.repo_id.toLowerCase();
        for (const [hfId, orId] of orHfToId) {
          const hfName = hfId.split("/").pop() ?? "";
          if (repoLower.includes(hfName.replace(/-/g, "")) || repoLower.includes(hfName)) {
            const orModel = orModels.find((o) => o.id === orId);
            if (orModel) {
              const aa = joinORWithAA(orModel, aaLookup);
              if (aa?.evaluations) {
                result.aaCoding = aa.evaluations.artificial_analysis_coding_index ?? null;
                result.aaIntel = aa.evaluations.artificial_analysis_intelligence_index ?? null;
              }
            }
            break;
          }
        }
        // Fallback: direct slug match
        if (result.aaCoding == null) {
          for (const [, aa] of aaLookup) {
            const aaSlug = aa.slug.toLowerCase();
            const repoFamily = repoLower.split("/").pop()?.split("-").slice(0, 3).join("-") ?? "";
            if (aaSlug.includes(repoFamily) || repoLower.includes(aaSlug)) {
              result.aaCoding = aa.evaluations?.artificial_analysis_coding_index ?? null;
              result.aaIntel = aa.evaluations?.artificial_analysis_intelligence_index ?? null;
              break;
            }
          }
        }
      } else {
        result.error = (data as { detail?: string }).detail || "Model not found";
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : "Unknown error";
    }
    return result;
  });

  const resolved = await Promise.all(fetchPromises);
  results.push(...resolved);

  if (modeJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Unified row type
  type TableRow = {
    Model: string;
    Size: string;
    Params: string;
    "tok/s": string;
    Headroom: string;
    Fit: string;
    Coding: string;
    DL: string;
  };

  const allRows: TableRow[] = results.map((r): TableRow => {
    if (!r.found) {
      return {
        Model: `${RED}${r.repo_id}${RESET} (not found)`,
        Size: "--",
        Params: "--",
        "tok/s": "--",
        Headroom: "--",
        Fit: "--",
        Coding: "--",
        DL: "--",
      };
    }
    if (!r.est || !r.size_formatted || !r.params_formatted) {
      return {
        Model: r.repo_id,
        Size: "--",
        Params: "--",
        "tok/s": "--",
        Headroom: "--",
        Fit: "--",
        Coding: "--",
        DL: "--",
      };
    }
    const est = r.est;
    const coding = r.aaCoding != null ? fmtScore(r.aaCoding) : `${DIM}--${RESET}`;
    return {
      Model: r.repo_id,
      Size: r.size_formatted,
      Params: r.params_formatted,
      "tok/s": fmtEstTokPerSec(est),
      Headroom: `${est.headroomGB > 0 ? est.headroomGB : `${RED}${est.headroomGB}${RESET}`} GB`,
      Fit: fmtComfort(est.comfort),
      Coding: coding,
      DL:
        r.downloads != null ? (r.downloads > 1000 ? `${(r.downloads / 1000).toFixed(1)}K` : String(r.downloads)) : "--",
    };
  });

  console.log(`\n${BOLD}Model estimates for ${totalRAM} GB system${RESET}  ${DIM}(${results.length} models)${RESET}`);
  const cols = allRows[0] ? Object.keys(allRows[0]) : [];
  console.log(Bun.inspect.table(allRows, cols));

  // Summary: highlight problems
  const problems = results.filter(
    (r): r is ModelQueryResult & { est: ModelEstimate } => !r.found || (r.est != null && r.est.comfort === "overflow"),
  );
  if (problems.length > 0) {
    console.log(`\n${RED}Issues:${RESET}`);
    for (const r of problems) {
      if (!r.found) {
        console.log(`  ${RED}${r.repo_id}${RESET}: ${r.error}`);
      } else if (r.est?.comfort === "overflow") {
        console.log(`  ${RED}${r.repo_id}${RESET}: exceeds RAM (${r.size_formatted} on ${totalRAM} GB system)`);
      }
    }
  }

  // Highlight comfortable fits
  const comfortable = results.filter(
    (r): r is ModelQueryResult & { est: ModelEstimate } => r.found && r.est != null && r.est.comfort === "comfortable",
  );
  if (comfortable.length > 0) {
    console.log(`\n${GREEN}Comfortable fits (${comfortable.length}):${RESET}`);
    for (const r of comfortable) {
      console.log(`  ${CYAN}${r.repo_id}${RESET} (${r.size_formatted}, ~${r.est.tokPerSec} tok/s)`);
    }
  }
}

// ── Main ──

async function main(): Promise<void> {
  if (modeDrift) {
    await drift();
  } else if (modeModels.length > 0) {
    await modelQuery();
  } else if (modeLocal) {
    await local();
  } else {
    await discover();
  }
}

main().catch((e) => {
  console.error(`${RED}Error: ${e.message}${RESET}`);
  process.exit(1);
});
