// Real-JSON ingester: glaiveai/glaive-function-calling-v2 (Apache-2.0) → RAIF SFT.
//
// RAIF's scope is "the single JSON object an LLM emits for a tool call", so the
// on-distribution real signal is exactly the `arguments` object of each
// function call in this dataset. We pull rows from HF's datasets-server (the
// dataset is UNGATED — no token), extract every `<functioncall> {...}`
// arguments object, keep only the ones that round-trip LOSSLESSLY through the
// canonical encoder/decoder, dedupe, and render each through the SAME
// `renderExample` path the synthetic generator uses — so a real example is
// byte-identical in form to a synthetic one (same <schema>, openers, profile).
//
// This AUGMENTS the synthetic set; it does not replace it. The synthetic shapes
// still carry the hard mechanisms (multiline blocks, pathological keys, nested
// arrays) and the held-out generalization probe — real function-call args are
// mostly flat scalars and underrepresent those.
//
// Usage (from prototype/):
//   bun run src/ingest_glaive.ts --pages 40 --out-train ../../raif-lora/data/real_train.jsonl \
//                                --out-valid ../../raif-lora/data/real_valid.jsonl
//   bun run src/ingest_glaive.ts --cache /tmp/glaive_args.jsonl --no-fetch   # reuse pulled args
//
// Determinism: every arguments object is seeded from a hash of its canonical
// JSON, so the same inputs always render the same examples.

import { encode, decode, type JSONObject, type JSONValue } from "./raif.ts";
import { renderExample, makeRng, hashString, writeJsonl, type Example } from "./dataset.ts";

const DATASET = "glaiveai/glaive-function-calling-v2";
const SOURCE_TAG = "glaive-fc-v2";
const SERVER = "https://datasets-server.huggingface.co/rows";
const PAGE = 100; // datasets-server max length per request

interface Args {
  pages: number;
  concurrency: number;
  cache: string | null;     // raw extracted-args JSONL (one object per line)
  noFetch: boolean;
  file: string | null;      // local JSON-array file ({system,chat}[]) — CDN download, no rate limit
  outTrain: string;
  outValid: string;
  validN: number;
  schemaFrac: number;
  minLeaves: number;
  max: number;          // cap on kept examples (0 = no cap) — controls the real:synthetic ratio
  seed: number;
}

const DEFAULTS: Args = {
  pages: 40,
  concurrency: 6,
  cache: null,
  noFetch: false,
  file: null,
  outTrain: "../raif-lora/data/real_train.jsonl",
  outValid: "../raif-lora/data/real_valid.jsonl",
  validN: 5,
  schemaFrac: 0.7,
  minLeaves: 1,
  max: 2285,   // ≈ 60/40 real:synthetic against the 1520-example synthetic train
  seed: 0,
};

function parseArgs(argv: string[]): Args {
  const a: Args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!, v = argv[i + 1];
    if (k === "--pages" && v) { a.pages = parseInt(v, 10); i++; }
    else if (k === "--concurrency" && v) { a.concurrency = parseInt(v, 10); i++; }
    else if (k === "--cache" && v) { a.cache = v; i++; }
    else if (k === "--no-fetch") { a.noFetch = true; }
    else if (k === "--file" && v) { a.file = v; i++; }
    else if (k === "--out-train" && v) { a.outTrain = v; i++; }
    else if (k === "--out-valid" && v) { a.outValid = v; i++; }
    else if (k === "--valid-n" && v) { a.validN = parseInt(v, 10); i++; }
    else if (k === "--schema-frac" && v) { a.schemaFrac = parseFloat(v); i++; }
    else if (k === "--min-leaves" && v) { a.minLeaves = parseInt(v, 10); i++; }
    else if (k === "--max" && v) { a.max = parseInt(v, 10); i++; }
    else if (k === "--seed" && v) { a.seed = parseInt(v, 10); i++; }
    else if (k === "--help" || k === "-h") {
      console.log("bun run src/ingest_glaive.ts [--pages N] [--concurrency N] "
        + "[--cache PATH] [--no-fetch] [--out-train PATH] [--out-valid PATH] "
        + "[--valid-n N] [--schema-frac F] [--min-leaves N] [--seed N]");
      process.exit(0);
    }
  }
  return a;
}

// ─── Canonical form for dedup + round-trip equality ──────────────────────────
function canon(v: JSONValue): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as JSONObject;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k]!)}`).join(",")}}`;
}

function countLeaves(v: JSONValue): number {
  if (v === null || typeof v !== "object") return 1;
  if (Array.isArray(v)) return v.length === 0 ? 1 : v.reduce((s: number, e) => s + countLeaves(e), 0);
  const o = v as JSONObject;
  const ks = Object.keys(o);
  return ks.length === 0 ? 1 : ks.reduce((s: number, k) => s + countLeaves(o[k]!), 0);
}

// ─── Extract each function call's `arguments` object from a chat transcript ──
// Glaive form:  ASSISTANT: <functioncall> {"name": "f", "arguments": '{"k": v}'} <|endoftext|>
// The arguments value is a SINGLE-QUOTED JSON string — parse the inner JSON.
function extractArgObjects(chat: string): JSONObject[] {
  const out: JSONObject[] = [];
  const callRe = /<functioncall>\s*([\s\S]*?)(?:<\|endoftext\|>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(chat)) !== null) {
    const blob = m[1]!.trim();
    // arguments wrapped in single quotes (the common Glaive form), greedy to the
    // last `'}` so apostrophes inside values don't truncate the capture.
    let argsText: string | null = null;
    const sq = blob.match(/"arguments"\s*:\s*'([\s\S]*)'\s*\}\s*$/);
    if (sq) argsText = sq[1]!;
    else {
      // fallback: arguments as an inline object — re-serialize the whole blob.
      const dq = blob.match(/"arguments"\s*:\s*(\{[\s\S]*\})\s*\}\s*$/);
      if (dq) argsText = dq[1]!;
    }
    if (argsText === null) continue;
    try {
      const obj = JSON.parse(argsText);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj as JSONObject);
    } catch { /* malformed — skip */ }
  }
  return out;
}

async function fetchPage(offset: number): Promise<string[]> {
  const url = `${SERVER}?dataset=${encodeURIComponent(DATASET)}&config=default`
    + `&split=train&offset=${offset}&length=${PAGE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${offset} -> HTTP ${res.status}`);
  const body = await res.json() as { rows: { row: { chat: string } }[] };
  return body.rows.map((r) => r.row.chat ?? "");
}

async function pulled(args: Args): Promise<JSONObject[]> {
  // Preferred path: a full local copy of the dataset JSON array (download it
  // once from the LFS CDN — no datasets-server rate limit). Each element is
  // {system, chat}; we pull arg objects out of every chat transcript.
  if (args.file) {
    const rows = JSON.parse(await Bun.file(args.file).text()) as { chat?: string }[];
    const objs: JSONObject[] = [];
    for (const row of rows) if (row.chat) objs.push(...extractArgObjects(row.chat));
    console.log(`  parsed ${rows.length} rows from ${args.file} → ${objs.length} raw args`);
    return objs;
  }
  // Reuse a cache of raw arg objects if asked — avoids re-hitting the API.
  if (args.cache && args.noFetch) {
    const text = await Bun.file(args.cache).text();
    return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  const offsets = Array.from({ length: args.pages }, (_, i) => i * PAGE);
  const objs: JSONObject[] = [];
  let errors = 0;
  for (let i = 0; i < offsets.length; i += args.concurrency) {
    const batch = offsets.slice(i, i + args.concurrency);
    const chatsPerPage = await Promise.all(batch.map((o) => fetchPage(o).catch((e) => {
      errors++;
      return [] as string[];
    })));
    for (const chats of chatsPerPage)
      for (const chat of chats) objs.push(...extractArgObjects(chat));
    process.stderr.write(`\r  fetched ${Math.min(i + args.concurrency, offsets.length)}/${offsets.length} pages, ${objs.length} raw args (${errors} page errors)`);
    // Gentle throttle so the datasets-server doesn't rate-limit a long pull.
    await new Promise((res) => setTimeout(res, 150));
  }
  process.stderr.write("\n");
  if (errors > offsets.length / 2)
    console.error(`  ! ${errors}/${offsets.length} pages failed — likely rate-limited; retry with lower --concurrency or fewer --pages`);
  // Never clobber a good cache with an empty/failed pull.
  if (args.cache && objs.length > 0) {
    await Bun.write(args.cache, objs.map((o) => JSON.stringify(o)).join("\n") + "\n");
    console.log(`  cached ${objs.length} raw args to ${args.cache}`);
  }
  return objs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Ingesting ${DATASET} (Apache-2.0) — pages=${args.pages}`);

  const raw = await pulled(args);

  // Dedupe by canonical JSON (real data repeats common args heavily).
  const seen = new Set<string>();
  const unique: JSONObject[] = [];
  let dropEmpty = 0, dropSmall = 0, dropDup = 0;
  for (const obj of raw) {
    if (Object.keys(obj).length === 0) { dropEmpty++; continue; }
    if (countLeaves(obj) < args.minLeaves) { dropSmall++; continue; }
    const c = canon(obj);
    if (seen.has(c)) { dropDup++; continue; }
    seen.add(c);
    unique.push(obj);
  }
  // Deterministic shuffle so a --max cap takes a DIVERSE sample, not the file head.
  const sr = makeRng(args.seed + 1);
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(sr() * (i + 1));
    [unique[i], unique[j]] = [unique[j]!, unique[i]!];
  }
  // The whole correctness story: keep ONLY objects the canonical codec round-trips
  // byte-for-byte. Stop once the cap is hit (no need to verify all ~tens-of-thousands).
  const cap = args.max > 0 ? args.max : unique.length;
  const kept: JSONObject[] = [];
  let dropRoundTrip = 0;
  for (const obj of unique) {
    if (kept.length >= cap) break;
    const c = canon(obj);
    let ok = false;
    try {
      const dec = decode(encode(obj, { profile: "generation" }));
      ok = dec.ok && canon(dec.value as JSONValue) === c;
    } catch { ok = false; }
    if (ok) kept.push(obj); else dropRoundTrip++;
  }

  console.log(`raw args: ${raw.length}  →  unique ${unique.length}  →  kept ${kept.length}  `
    + `(dropped: empty ${dropEmpty}, tiny ${dropSmall}, dup ${dropDup}, no-round-trip ${dropRoundTrip}; cap ${cap})`);

  // Render via the shared synthetic path so form is identical. Seed per object
  // from its canonical hash → fully deterministic.
  const examples: Example[] = kept.map((obj) => {
    const seed = args.seed + hashString(canon(obj));
    const r = makeRng(seed);
    return renderExample(obj, r, args.schemaFrac, {
      shape: "real_glaive", variation_seed: seed, mode: "normal",
      source_dataset: SOURCE_TAG,
    });
  });

  // Split: a small, stable valid slice (matches synthetic per-shape valid count
  // so check_data's stratification stays balanced); the rest is train.
  const validN = Math.min(args.validN, examples.length);
  const valid = examples.slice(0, validN);
  const train = examples.slice(validN);
  writeJsonl(args.outTrain, train);
  writeJsonl(args.outValid, valid);
  console.log(`✓ wrote ${train.length} real train → ${args.outTrain}`);
  console.log(`✓ wrote ${valid.length} real valid → ${args.outValid}`);

  const tasks = new Map<string, number>();
  for (const e of examples) tasks.set(e.meta.task, (tasks.get(e.meta.task) ?? 0) + 1);
  console.log(`per task: ${[...tasks].map(([t, n]) => `${t}=${n}`).join(", ")}`);
}

main();
