// LLM harness — translation task. For each corpus shape, ask an LLM to
// re-emit the JSON as both RAIF and JSON, then score parse rate, fidelity,
// repair usage, and output token count.
//
// Usage:
//   bun harness                                # local Ollama, default model
//   bun harness --provider openrouter --models meta-llama/llama-3.1-8b-instruct,google/gemma-2-9b-it
//   bun harness --trials 5
//   bun harness --shapes short_tool_call,nested_object
//
// Env:
//   OPENROUTER_API_KEY=…   (required for --provider openrouter)
//
// Storage: every run writes raw outputs to harness_runs/<timestamp>.json so
// the same outputs can be re-scored later (e.g. after a repair-pass change)
// without re-querying the model. The API key is NEVER written to disk.

import { encode as bpeEncode } from "gpt-tokenizer";
import { decode, type JSONObject } from "../src/raif.ts";
import { corpus } from "./corpus.ts";
import { deepEqual } from "./json_equal.ts";
import { buildPrompt } from "./harness_prompts.ts";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

// ─── CLI args ─────────────────────────────────────────────────────────

type Provider = "ollama" | "openrouter";

interface Args {
  provider: Provider;
  trials: number;
  models: string[];                // one or more model ids
  url: string;                     // base URL (ollama only)
  shapes: string[] | null;         // null = all
  concurrency: number;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    provider: "ollama",
    trials: 3,
    models: ["qwen2.5:1.5b"],
    url: "http://localhost:11434",
    shapes: null,
    concurrency: 3,
    outDir: "harness_runs",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (k === "--provider" && v) {
      if (v !== "ollama" && v !== "openrouter") {
        console.error(`✗ --provider must be 'ollama' or 'openrouter', got '${v}'`);
        process.exit(1);
      }
      a.provider = v;
      i++;
    } else if (k === "--trials" && v) { a.trials = parseInt(v, 10); i++; }
    else if ((k === "--model" || k === "--models") && v) {
      a.models = v.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (k === "--url" && v) { a.url = v; i++; }
    else if (k === "--shapes" && v) { a.shapes = v.split(",").map((s) => s.trim()); i++; }
    else if (k === "--concurrency" && v) { a.concurrency = parseInt(v, 10); i++; }
    else if (k === "--out" && v) { a.outDir = v; i++; }
  }
  // Sensible default model for OpenRouter when none specified.
  if (a.provider === "openrouter" && a.models.length === 1 && a.models[0] === "qwen2.5:1.5b") {
    a.models = ["meta-llama/llama-3.1-8b-instruct"];
  }
  return a;
}

// ─── Provider clients ─────────────────────────────────────────────────

interface OllamaResponse {
  response: string;
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

async function ollamaGenerate(args: Args, model: string, prompt: string): Promise<string> {
  const res = await fetch(`${args.url}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0.2,
        num_predict: 2048,
        // Stop at the next "INPUT:" sentinel so the model can't loop into
        // another example we didn't ask for.
        stop: ["\nINPUT:", "\n\nINPUT:"],
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ollama ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as OllamaResponse;
  return data.response;
}

interface OpenAICompletionResponse {
  choices: Array<{ message: { content: string | null } }>;
}

async function openRouterGenerate(args: Args, model: string, prompt: string, apiKey: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      // Optional but encouraged by OpenRouter.
      "HTTP-Referer": "https://github.com/raif-standard",
      "X-Title": "raif-harness",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 2048,
      stop: ["\nINPUT:", "\n\nINPUT:"],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`openrouter ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as OpenAICompletionResponse;
  return data.choices[0]?.message.content ?? "";
}

async function generate(args: Args, model: string, prompt: string, apiKey: string | null): Promise<string> {
  if (args.provider === "ollama") return ollamaGenerate(args, model, prompt);
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  return openRouterGenerate(args, model, prompt, apiKey);
}

async function probeProvider(args: Args): Promise<string | null> {
  if (args.provider === "ollama") {
    try {
      const tags = await fetch(`${args.url}/api/tags`);
      if (!tags.ok) throw new Error(`/api/tags returned ${tags.status}`);
      const list = (await tags.json()) as { models: { name: string }[] };
      const names = list.models.map((m) => m.name);
      for (const model of args.models) {
        const hasModel = names.some((n) => n === model || n.startsWith(`${model}:`));
        if (!hasModel) {
          console.error(`✗ model '${model}' not found on ${args.url}.`);
          console.error(`  Available: ${names.join(", ") || "(none)"}`);
          console.error(`  Pull with: ollama pull ${model}`);
          process.exit(1);
        }
      }
      console.log(`✓ ollama up at ${args.url}, ${args.models.length} model(s) ready: ${args.models.join(", ")}`);
      return null;
    } catch (e) {
      console.error(`✗ cannot reach ollama at ${args.url}: ${(e as Error).message}`);
      console.error(`  Start with: ollama serve`);
      process.exit(1);
    }
  }
  // openrouter
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(`✗ OPENROUTER_API_KEY env var is required for --provider openrouter`);
    process.exit(1);
  }
  // Sanity-check by listing the models endpoint and confirming each requested
  // model exists. OpenRouter returns hundreds of models; we just check membership.
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`/api/v1/models returned ${res.status}`);
    const data = (await res.json()) as { data: Array<{ id: string }> };
    const known = new Set(data.data.map((m) => m.id));
    const missing = args.models.filter((m) => !known.has(m));
    if (missing.length > 0) {
      console.error(`✗ openrouter models not found: ${missing.join(", ")}`);
      console.error(`  (${known.size} models known to openrouter; check the slug)`);
      process.exit(1);
    }
    console.log(`✓ openrouter reachable, ${args.models.length} model(s) verified: ${args.models.join(", ")}`);
    return apiKey;
  } catch (e) {
    console.error(`✗ openrouter probe failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────

type Format = "raif" | "json";

interface TrialResult {
  model: string;
  shape: string;
  format: Format;
  trial: number;
  rawOutput: string;
  parseOk: boolean;
  parseError?: string;
  fidelityOk: boolean;
  repairsApplied: number;
  repairKinds: string[];
  outputTokens: number;
  durationMs: number;
}

function stripMarkdownFences(s: string): string {
  const m = s.match(/^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1]! : s;
}

type ScoreFields = Omit<TrialResult, "model" | "shape" | "format" | "trial" | "rawOutput" | "durationMs">;

function scoreRaif(raw: string, expected: JSONObject): ScoreFields {
  const tokenized = bpeEncode(raw).length;
  // decode() runs the full repair pass: markdown fences, line endings,
  // mode markers, multi-line braces flattening (TIER 1A), separator coercion,
  // mismatched-nonce recovery, delimiter-count repair (TIER 1B).
  const r = decode(raw);
  const repairKinds = r.repairs.map((rp) => rp.kind);
  if (!r.ok) {
    return { parseOk: false, parseError: r.error, fidelityOk: false, repairsApplied: r.repairs.length, repairKinds, outputTokens: tokenized };
  }
  return {
    parseOk: true,
    fidelityOk: deepEqual(r.value, expected),
    repairsApplied: r.repairs.length,
    repairKinds,
    outputTokens: tokenized,
  };
}

function scoreJson(raw: string, expected: JSONObject): ScoreFields {
  const tokenized = bpeEncode(raw).length;
  // Symmetric "permissive" parse: strip a markdown fence if the model wrapped
  // its output in one. No other repair — JSON has no canonical repair pass.
  const candidates = [raw.trim(), stripMarkdownFences(raw).trim()];
  let lastErr = "parse failed";
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { parseOk: false, parseError: "top-level is not an object", fidelityOk: false, repairsApplied: 0, repairKinds: [], outputTokens: tokenized };
      }
      return { parseOk: true, fidelityOk: deepEqual(parsed, expected), repairsApplied: 0, repairKinds: [], outputTokens: tokenized };
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  return { parseOk: false, parseError: lastErr.slice(0, 120), fidelityOk: false, repairsApplied: 0, repairKinds: [], outputTokens: tokenized };
}

// ─── Runner ───────────────────────────────────────────────────────────

async function runTrial(
  args: Args,
  apiKey: string | null,
  model: string,
  shape: { name: string; json: JSONObject },
  format: Format,
  trial: number,
): Promise<TrialResult> {
  const prompt = buildPrompt(format, shape.json);
  const t0 = Date.now();
  const text = await generate(args, model, prompt, apiKey);
  const durationMs = Date.now() - t0;
  const scored = format === "raif" ? scoreRaif(text, shape.json) : scoreJson(text, shape.json);
  return { model, shape: shape.name, format, trial, rawOutput: text, durationMs, ...scored };
}

async function runAll(args: Args, apiKey: string | null, partialPath: string): Promise<TrialResult[]> {
  const targets = args.shapes
    ? corpus.filter((c) => args.shapes!.includes(c.name))
    : corpus;
  if (targets.length === 0) {
    console.error(`✗ no corpus shapes matched: ${args.shapes?.join(",")}`);
    process.exit(1);
  }
  const queue: Array<{ model: string; shape: typeof corpus[number]; format: Format; trial: number }> = [];
  for (const model of args.models) {
    for (const shape of targets) {
      for (const format of ["raif", "json"] as Format[]) {
        for (let t = 0; t < args.trials; t++) {
          queue.push({ model, shape, format, trial: t });
        }
      }
    }
  }
  console.log(
    `running ${queue.length} trials (${args.models.length} model(s) × ${targets.length} shapes × 2 formats × ${args.trials} trials) @ concurrency=${args.concurrency}`,
  );
  console.log(`incremental save: ${partialPath}`);

  const results: TrialResult[] = [];
  let inflight = 0;
  let nextIdx = 0;
  let completed = 0;
  await new Promise<void>((resolve) => {
    const tick = () => {
      while (inflight < args.concurrency && nextIdx < queue.length) {
        const item = queue[nextIdx++]!;
        inflight++;
        runTrial(args, apiKey, item.model, item.shape, item.format, item.trial)
          .then((r) => {
            results.push(r);
            const mark = r.fidelityOk ? "✓" : (r.parseOk ? "△" : "✗");
            completed++;
            const tag = r.repairsApplied > 0 ? ` [r=${r.repairsApplied}]` : "";
            process.stdout.write(`  ${mark} [${completed}/${queue.length}] ${shortModel(r.model)} ${r.shape} ${r.format} t${r.trial}${tag}\n`);
          })
          .catch((e) => {
            results.push({
              model: item.model, shape: item.shape.name, format: item.format, trial: item.trial,
              rawOutput: "", parseOk: false, parseError: (e as Error).message,
              fidelityOk: false, repairsApplied: 0, repairKinds: [], outputTokens: 0, durationMs: 0,
            });
            completed++;
            process.stdout.write(`  ✗ [${completed}/${queue.length}] ${shortModel(item.model)} ${item.shape.name} ${item.format} t${item.trial} (network)\n`);
          })
          .finally(() => {
            // Persist after every trial so a kill / crash never loses data.
            try {
              writeFileSync(
                partialPath,
                JSON.stringify({ args, runAt: new Date().toISOString(), partial: completed < queue.length, results }, null, 2),
              );
            } catch (e) {
              // Don't lose the whole run over one failed checkpoint write, but
              // surface it — a silent swallow hides a full disk / bad outDir.
              console.error(
                `[harness] failed to write partial results to ${partialPath}: ${(e as Error).message}`,
              );
            }
            inflight--;
            if (completed === queue.length) resolve();
            else tick();
          });
      }
    };
    tick();
  });
  // Sort to a deterministic order: model → shape (corpus order) → format → trial.
  const modelIndex = new Map(args.models.map((m, i) => [m, i]));
  const shapeIndex = new Map(targets.map((c, i) => [c.name, i]));
  results.sort((a, b) => {
    const mi = (modelIndex.get(a.model) ?? 0) - (modelIndex.get(b.model) ?? 0);
    if (mi !== 0) return mi;
    const si = (shapeIndex.get(a.shape) ?? 0) - (shapeIndex.get(b.shape) ?? 0);
    if (si !== 0) return si;
    if (a.format !== b.format) return a.format === "raif" ? -1 : 1;
    return a.trial - b.trial;
  });
  return results;
}

function shortModel(m: string): string {
  // For multi-model output, keep the last path segment so log lines stay readable.
  const slash = m.lastIndexOf("/");
  return slash >= 0 ? m.slice(slash + 1) : m;
}

// ─── Reporting ────────────────────────────────────────────────────────

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function fmtDelta(raif: number, json: number): string {
  if (json === 0) return "—";
  const d = ((raif - json) / json) * 100;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(0)}%`;
}

interface ModelSummary {
  model: string;
  raif: { parse: number; fid: number; repair: number; tok: number };
  json: { parse: number; fid: number; tok: number };
}

function summarize(results: TrialResult[], model: string): ModelSummary {
  const raif = results.filter((r) => r.model === model && r.format === "raif");
  const json = results.filter((r) => r.model === model && r.format === "json");
  const meanTokens = (rs: TrialResult[]) =>
    rs.length === 0 ? 0 : Math.round(rs.reduce((s, r) => s + r.outputTokens, 0) / rs.length);
  const rate = (rs: TrialResult[], pred: (r: TrialResult) => boolean) =>
    rs.length === 0 ? 0 : rs.filter(pred).length / rs.length;
  return {
    model,
    raif: {
      parse: rate(raif, (r) => r.parseOk),
      fid: rate(raif, (r) => r.fidelityOk),
      repair: rate(raif, (r) => r.repairsApplied > 0),
      tok: meanTokens(raif),
    },
    json: {
      parse: rate(json, (r) => r.parseOk),
      fid: rate(json, (r) => r.fidelityOk),
      tok: meanTokens(json),
    },
  };
}

function printPerModelTable(args: Args, results: TrialResult[]): void {
  const headers = ["model", "RAIF parse", "RAIF fid", "repair%", "JSON parse", "JSON fid", "RAIF tok", "JSON tok", "Δ tok"];
  const widths = [36, 11, 9, 8, 11, 9, 9, 9, 7];
  const sep = "─".repeat(widths.reduce((a, b) => a + b + 3, -3));
  console.log("");
  console.log(`provider=${args.provider}  trials=${args.trials}  shapes=${args.shapes?.length ?? corpus.length}  models=${args.models.length}`);
  console.log("");
  console.log(headers.map((h, i) => h.padEnd(widths[i]!)).join(" │ "));
  console.log(sep);
  for (const model of args.models) {
    const s = summarize(results, model);
    const cols = [
      shortModel(model).padEnd(widths[0]!),
      fmtPct(s.raif.parse).padStart(widths[1]!),
      fmtPct(s.raif.fid).padStart(widths[2]!),
      fmtPct(s.raif.repair).padStart(widths[3]!),
      fmtPct(s.json.parse).padStart(widths[4]!),
      fmtPct(s.json.fid).padStart(widths[5]!),
      String(s.raif.tok).padStart(widths[6]!),
      String(s.json.tok).padStart(widths[7]!),
      fmtDelta(s.raif.tok, s.json.tok).padStart(widths[8]!),
    ];
    console.log(cols.join(" │ "));
  }
  console.log("");
}

function printRepairKindCounts(results: TrialResult[]): void {
  const counts = new Map<string, number>();
  for (const r of results) {
    for (const k of r.repairKinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (counts.size === 0) {
    console.log("repair pass usage: 0 across all trials");
    return;
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log("repair pass usage by kind:");
  for (const [kind, n] of entries) {
    console.log(`  ${n.toString().padStart(4)}  ${kind}`);
  }
  console.log("");
}

function printFailureSamples(results: TrialResult[]): void {
  const failures = results.filter((r) => !r.fidelityOk);
  if (failures.length === 0) return;
  console.log(`failure samples (${failures.length} of ${results.length}):`);
  for (const f of failures.slice(0, 8)) {
    const label = f.parseOk ? "fidelity mismatch" : `parse fail: ${f.parseError ?? "?"}`;
    console.log(`  ${shortModel(f.model)} ${f.shape} ${f.format} t${f.trial} — ${label}`);
    const snippet = f.rawOutput.replace(/\n/g, "⏎").slice(0, 140);
    console.log(`    └─ ${snippet}${f.rawOutput.length > 140 ? "…" : ""}`);
  }
  console.log("");
}

function printReport(args: Args, results: TrialResult[]): void {
  printPerModelTable(args, results);
  printRepairKindCounts(results);
  printFailureSamples(results);
}

function makeRunPath(args: Args): string {
  if (!existsSync(args.outDir)) mkdirSync(args.outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const slug =
    args.models.length === 1
      ? args.models[0]!.replace(/[:/]/g, "-")
      : `${args.provider}_${args.models.length}models`;
  return `${args.outDir}/${ts}_${slug}.json`;
}

// ─── Entry ────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const apiKey = await probeProvider(args);
const runPath = makeRunPath(args);
const results = await runAll(args, apiKey, runPath);
printReport(args, results);
// Final rewrite removes the `partial: true` marker. The API key is NOT
// persisted — only the args object (no secrets).
writeFileSync(runPath, JSON.stringify({ args, runAt: new Date().toISOString(), partial: false, results }, null, 2));
console.log(`raw results saved to ${runPath}`);
