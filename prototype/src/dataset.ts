// Synthetic dataset generator for the v0.5 fine-tune workstream.
// Reads `corpus.ts` for shape templates, applies seeded random variation,
// emits chat-template (request, response) pairs in JSONL form for SFT.
//
// Every example is one of two tasks (≈50/50 mix):
//   - "translate": the user turn contains the exact source JSON (minified)
//     with an instruction to emit it as RAIF — fidelity fully determined.
//   - "instruct": the user turn is a natural-language request that embeds
//     EVERY leaf value of the target object (plus a <schema> block), so the
//     completion is recoverable from the prompt alone.
//
// Usage:
//   bun dataset                                              # default: 50 variations each, write data/train.jsonl
//   bun dataset --variations 500 --out data/train.jsonl
//   bun dataset --variations 100 --shapes pathological_keys,heterogeneous_array --out data/adversarial.jsonl --holdout-shapes none
//   bun dataset --variations 500 --eval-frac 0.05 --out-train data/train.jsonl --out-eval data/eval.jsonl
//   bun dataset --variations 20 --schema-frac 1.0            # always include <schema> block
//
// Held-out shapes (plan §3.4): shapes listed in --holdout-shapes (default:
// multiline_body, pathological_keys, large_table, deep_array_literal,
// flat_inline_object) are written ONLY to --out-holdout (eval_holdout.jsonl),
// never to the train or eval files. Pass `--holdout-shapes none` to disable.
//
// Eval split (--eval-frac in split mode) is stratified per shape: each
// non-held-out shape contributes ceil(evalFrac × n) examples, picked
// round-robin across its variation range.
//
// Determinism: every run with the same flags produces byte-identical output.
// Seed defaults to 0; pass --seed N to shift the whole sequence.
//
// What it writes (per line):
//   {"messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}],
//    "meta":{"shape":"...","variation_seed":N,"has_schema":bool,"mode":"...",
//            "task":"translate"|"instruct","source":{...exact source JSON...}}}
//
// `meta` is unused by SFT trainers that consume only `messages`; it's kept
// inline for eval/debugging (`source` lets checkers verify prompt↔completion
// fidelity without running the decoder).

import { encode, type JSONObject, type JSONValue } from "./raif.ts";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// ─── CLI args ────────────────────────────────────────────────────────────

interface Args {
  variations: number;
  shapes: string[] | null;
  outPath: string | null;     // single-file mode
  outTrainPath: string | null; // split mode
  outEvalPath: string | null;
  outHoldoutPath: string;      // held-out-shape examples land here, never in train
  holdoutShapes: string[];     // shapes withheld from training entirely (plan §3.4)
  evalFrac: number;
  schemaFrac: number;          // probability that a translate example carries a <schema> block
  seed: number;
  adversarialFrac: number;     // probability that a hard-shape example uses adversarial mode
}

// Plan §3.4 — shapes withheld from training to measure generalization.
//
// Held-out balance (added in the v0.5 dataset overhaul): a held-out shape must
// only test a HARDER/DIFFERENT surface of a mechanism the model has already
// seen in training — never be the SOLE carrier of a wire-format mechanism, or
// the holdout degenerates into "the model never learned this at all" instead
// of measuring generalization. Two mechanisms used to be sole-carried by a
// held-out shape; each now has an in-training carrier with a different shape:
//   multiline `<<<…>>>` block   held: multiline_body      → train: record_with_note
//   `<<<key>>>` key wrapping     held: pathological_keys    → train: dotted_paths
//   bracket array under nesting  held: deep_array_literal   → train: nested_event_log
//   homogeneous table form       held: large_table          → train: array_of_objects, large_table's bracket form is shared
//   flat nested object           held: flat_inline_object   → train: nested_object (same path form under "generation")
export const DEFAULT_HOLDOUT_SHAPES = [
  "multiline_body",
  "pathological_keys",
  "large_table",
  "deep_array_literal",
  "flat_inline_object",
] as const;

const DEFAULTS: Args = {
  variations: 50,
  shapes: null,
  outPath: "data/train.jsonl",
  outTrainPath: null,
  outEvalPath: null,
  outHoldoutPath: "data/eval_holdout.jsonl",
  holdoutShapes: [...DEFAULT_HOLDOUT_SHAPES],
  evalFrac: 0.0,
  schemaFrac: 0.7,
  seed: 0,
  adversarialFrac: 0.5,
};

function parseArgs(argv: string[]): Args {
  const a: Args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (k === "--variations" && v) { a.variations = parseInt(v, 10); i++; }
    else if (k === "--shapes" && v) { a.shapes = v.split(",").map((s) => s.trim()); i++; }
    else if (k === "--out" && v) { a.outPath = v; i++; }
    else if (k === "--out-train" && v) { a.outTrainPath = v; i++; }
    else if (k === "--out-eval" && v) { a.outEvalPath = v; i++; }
    else if (k === "--out-holdout" && v) { a.outHoldoutPath = v; i++; }
    else if (k === "--holdout-shapes" && v) {
      a.holdoutShapes = v === "none" ? [] : v.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    }
    else if (k === "--eval-frac" && v) { a.evalFrac = parseFloat(v); i++; }
    else if (k === "--schema-frac" && v) { a.schemaFrac = parseFloat(v); i++; }
    else if (k === "--seed" && v) { a.seed = parseInt(v, 10); i++; }
    else if (k === "--adversarial-frac" && v) { a.adversarialFrac = parseFloat(v); i++; }
    else if (k === "--help" || k === "-h") { printHelp(); process.exit(0); }
  }
  if ((a.outTrainPath || a.outEvalPath) && a.outPath === DEFAULTS.outPath) {
    a.outPath = null;  // split mode overrides single-file default
  }
  // Fractions are probabilities — reject out-of-range values instead of letting
  // `chance(r, frac)` silently saturate (e.g. --schema-frac 2 → always true).
  for (const [name, val] of [
    ["eval-frac", a.evalFrac],
    ["schema-frac", a.schemaFrac],
    ["adversarial-frac", a.adversarialFrac],
  ] as const) {
    if (!Number.isFinite(val) || val < 0 || val > 1) {
      console.error(`error: --${name} must be a number in [0, 1], got ${val}`);
      process.exit(1);
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`bun dataset [options]
  --variations N         Variations per shape (default ${DEFAULTS.variations})
  --shapes a,b,c         Only generate these corpus shapes (default: all)
  --out PATH             Single-file output (default ${DEFAULTS.outPath})
  --out-train / --out-eval PATH   Split mode (use both together)
  --out-holdout PATH     Where held-out-shape examples go (default ${DEFAULTS.outHoldoutPath})
  --holdout-shapes a,b   Shapes withheld from train/eval entirely, or 'none'
                         (default: ${DEFAULT_HOLDOUT_SHAPES.join(",")})
  --eval-frac F          Per-shape fraction held out for eval in split mode, stratified (default 0)
  --schema-frac F        Probability a translate example carries a <schema> block (default ${DEFAULTS.schemaFrac}; instruct examples always do)
  --adversarial-frac F   Probability a hard-shape example uses adversarial mode (default ${DEFAULTS.adversarialFrac})
  --seed N               Seed shift for the whole run (default 0)`);
}

// ─── Seeded RNG (Mulberry32) ─────────────────────────────────────────────

export function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)]!;
}

function pickN<T>(r: () => number, arr: readonly T[], n: number): T[] {
  // Sample without replacement.
  const pool = [...arr];
  const out: T[] = [];
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) {
    const idx = Math.floor(r() * pool.length);
    out.push(pool[idx]!);
    pool.splice(idx, 1);
  }
  return out;
}

function intIn(r: () => number, lo: number, hi: number): number {
  return Math.floor(r() * (hi - lo + 1)) + lo;
}

function chance(r: () => number, p: number): boolean {
  return r() < p;
}

// ─── Pools ───────────────────────────────────────────────────────────────

const FIELD_NAMES = [
  // identity / addressing
  "to", "from", "cc", "bcc", "recipient", "sender", "user", "owner", "author",
  "actor", "subject_id", "target", "source", "destination",
  // status / state
  "status", "state", "phase", "stage", "kind", "type", "category", "tier", "level",
  "active", "enabled", "verified", "approved", "published", "deleted", "archived",
  "completed", "failed", "pending", "ready",
  // identifiers
  "id", "uuid", "key", "code", "slug", "handle", "token", "session_id",
  "request_id", "trace_id", "correlation_id", "transaction_id", "order_id",
  "user_id", "account_id", "tenant_id", "project_id", "team_id",
  // content
  "title", "name", "label", "description", "summary", "body", "content", "text",
  "message", "note", "comment", "remark", "caption", "headline",
  // counts / measures
  "count", "total", "sum", "size", "length", "qty", "amount", "price",
  "score", "rank", "weight", "ratio", "rate", "limit", "offset", "depth",
  // time
  "created_at", "updated_at", "deleted_at", "scheduled_at", "expires_at",
  "started_at", "finished_at", "timestamp", "date", "time", "duration",
  // grouping
  "tags", "labels", "categories", "items", "rows", "records", "entries",
  "events", "actions", "logs", "messages", "results", "data", "payload",
  // meta
  "metadata", "meta", "extra", "config", "options", "settings", "params",
  "context", "info", "details", "attributes", "properties",
  // contact
  "email", "phone", "address", "url", "link", "href", "endpoint",
  // money / commerce
  "currency", "price_usd", "subtotal", "tax", "discount", "shipping",
  "invoice_number", "purchase_order", "stripe_id",
  // tech
  "host", "port", "protocol", "method", "path", "query", "headers", "cookies",
  "version", "branch", "commit", "build", "release", "environment",
  // people-ish
  "first_name", "last_name", "username", "display_name", "avatar", "role",
  // generic
  "value", "field", "result", "output", "input", "response", "request",
] as const;

// Value pools are generated combinatorially from small word lists so the
// pool sizes scale to 500+ variations/shape without hand-writing thousands
// of literals. All generation below is deterministic (no RNG at module load).

const PLAIN_WORDS = [
  "ok", "ready", "pending", "active", "inactive", "draft", "published", "archived",
  "high", "low", "medium", "urgent", "normal", "critical", "minor", "major",
  "billing", "shipping", "support", "ops", "engineering", "design", "marketing",
  "admin", "viewer", "editor", "owner", "guest", "member", "moderator",
  "pricing", "checkout", "signup", "login", "logout", "settings", "profile",
  "dashboard", "reports", "analytics", "users", "teams", "projects",
  "click", "view", "submit", "scroll", "hover", "swipe", "tap",
  "north", "south", "east", "west", "up", "down", "left", "right",
  "blue", "red", "green", "yellow", "purple", "orange",
  "monday", "tuesday", "wednesday", "thursday", "friday",
  "api", "web", "mobile", "desktop", "embed",
] as const;

const ADJECTIVES = [
  "amber", "bold", "calm", "crisp", "dusty", "eager", "fancy", "gentle",
  "hazel", "ivory", "jolly", "keen", "lively", "mellow", "noble", "olive",
  "plain", "quiet", "rustic", "silver", "tidy", "upbeat", "vivid", "witty",
] as const;

const NOUNS = [
  "falcon", "harbor", "ledger", "meadow", "beacon", "canyon", "drift",
  "ember", "forge", "glacier", "hollow", "inlet", "kernel", "lantern",
  "marble", "nectar", "orchid", "pylon", "quartz", "ridge", "summit",
  "thicket", "valley", "willow",
] as const;

// ~70 plain words + 24×24 adjective-noun combos = 646 short strings.
const SHORT_STRINGS: readonly string[] = [
  ...PLAIN_WORDS,
  ...ADJECTIVES.flatMap((a) => NOUNS.map((n) => `${a}-${n}`)),
];

const FIRST_NAMES = [
  "alice", "bob", "carol", "dave", "eve", "egor", "alex", "sam", "jordan",
  "maria", "ivan", "nina", "oscar", "priya", "quinn", "ravi", "sofia",
  "tomas", "uma", "viktor", "wendy", "yusuf", "zoe", "lena", "marco",
  "noah", "olga", "pavel", "rosa", "stefan",
] as const;

const LAST_NAMES = [
  "reyes", "kim", "novak", "silva", "haas", "okafor", "lindqvist", "tanaka",
  "moreau", "petrov", "garcia", "walsh", "ferrara", "nguyen", "kowalski",
] as const;

// 30 bare first names + 30×15 first.last combos = 480 names.
const NAMES: readonly string[] = [
  ...FIRST_NAMES,
  ...FIRST_NAMES.flatMap((f) => LAST_NAMES.map((l) => `${f}.${l}`)),
];

const SENT_SUBJECTS = [
  "the invoice", "the report", "your order", "the deployment", "the migration",
  "the backup", "the meeting", "your account", "the request", "the cache",
  "the build", "the export", "the booking", "the rollout", "the audit",
] as const;

const SENT_PREDICATES = [
  "is ready for review", "has been updated", "completed successfully",
  "was queued for processing", "requires no further action",
  "has been archived", "is now available", "was approved by the team",
  "failed and will be retried", "is scheduled for tonight",
  "was flagged for follow-up", "has been confirmed",
] as const;

// 15×12 = 180 sentence fragments.
const SENTENCE_FRAGMENTS: readonly string[] =
  SENT_SUBJECTS.flatMap((s) => SENT_PREDICATES.map((p) => `${s} ${p}`));

const DOMAIN_WORDS = [
  "example", "acme", "globex", "initech", "umbrella", "hooli", "stark",
  "wayne", "wonka", "cyberdyne", "aperture", "tyrell", "northwind", "contoso",
] as const;

const TLDS = ["com", "io", "co", "org", "dev", "net"] as const;

// 14×6 = 84 email domains.
const EMAIL_DOMAINS: readonly string[] =
  DOMAIN_WORDS.flatMap((w) => TLDS.map((t) => `${w}.${t}`));

function makeEmail(r: () => number, name?: string): string {
  const n = name ?? pick(r, NAMES);
  const d = pick(r, EMAIL_DOMAINS);
  return `${n}@${d}`;
}

function makeUrl(r: () => number): string {
  const proto = pick(r, ["https", "http"]);
  const host = `${pick(r, SHORT_STRINGS)}.${pick(r, ["com", "io", "dev", "org"])}`;
  const path = pick(r, ["/api/v1/users", "/login", "/dashboard", "/healthz", "/", "/checkout", "/items"]);
  return `${proto}://${host}${path}`;
}

function makeShortString(r: () => number): string {
  return pick(r, SHORT_STRINGS);
}

function makeSentence(r: () => number): string {
  return pick(r, SENTENCE_FRAGMENTS);
}

function makeLongText(r: () => number, lines: number): string {
  const parts: string[] = [];
  for (let i = 0; i < lines; i++) {
    if (chance(r, 0.2)) parts.push("");  // blank line for paragraph break
    else parts.push(`${pick(r, SENTENCE_FRAGMENTS)}.`);
  }
  return parts.join("\n");
}

// ─── Per-shape variators ─────────────────────────────────────────────────

export type Mode = "normal" | "adversarial";
type Variator = (r: () => number, mode: Mode) => { json: JSONObject; description: string };

function pickFieldNames(r: () => number, n: number): string[] {
  return pickN(r, FIELD_NAMES, n);
}

const variators: Record<string, Variator> = {
  short_tool_call: (r) => {
    const [toF, subjectF, bodyF] = pickFieldNames(r, 3);
    return {
      json: {
        [toF!]: makeEmail(r),
        [subjectF!]: makeSentence(r),
        [bodyF!]: makeSentence(r),
      },
      description: "Compose a tool call with the given fields.",
    };
  },

  scalars_mixed: (r) => {
    const names = pickFieldNames(r, intIn(r, 4, 8));
    const json: JSONObject = {};
    for (const n of names) {
      const t = pick(r, ["s", "n", "b", "null", "neg", "float", "big"]);
      if (t === "s") json[n] = makeShortString(r);
      else if (t === "n") json[n] = intIn(r, 1, 1000);
      else if (t === "b") json[n] = chance(r, 0.5);
      else if (t === "null") json[n] = null;
      else if (t === "neg") json[n] = -intIn(r, 1, 1000);
      else if (t === "float") json[n] = Math.round(r() * 10000) / 100;
      else if (t === "big") json[n] = intIn(r, 1_000_000, 999_999_999_999);
    }
    return { json, description: "Compose an object mixing primitive types." };
  },

  nested_object: (r) => {
    const [parent, idF, nameF, emailF, trackF] = pickFieldNames(r, 5);
    return {
      json: {
        [parent!]: {
          [idF!]: intIn(r, 1, 9999),
          [nameF!]: makeShortString(r),
          [emailF!]: makeEmail(r),
        },
        [trackF!]: `${makeShortString(r)}-${intIn(r, 100, 999)}`,
      },
      description: "Compose a 2-level nested object plus a sibling field.",
    };
  },

  array_of_objects: (r) => {
    const [arrF, idF, nameF, qtyF] = pickFieldNames(r, 4);
    const n = intIn(r, 2, 8);
    const rows: JSONObject[] = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        [idF!]: i + 1,
        [nameF!]: makeShortString(r),
        [qtyF!]: intIn(r, 1, 100),
      });
    }
    return { json: { [arrF!]: rows }, description: "Compose an array of homogeneous objects." };
  },

  text_with_specials: (r) => {
    const [titleF, queryF, slugF] = pickFieldNames(r, 3);
    return {
      json: {
        [titleF!]: `has "quotes" and {braces}`,
        [queryF!]: `a=${intIn(r, 1, 9)},b=${intIn(r, 1, 9)}`,
        [slugF!]: pick(r, ["my name", "long-slug-here", "hello world"]),
      },
      description: "Compose an object whose string values contain quotes, braces, commas, equals signs.",
    };
  },

  multiline_body: (r, mode) => {
    const [toF, subjF, bodyF] = pickFieldNames(r, 3);
    const lines = mode === "adversarial" ? intIn(r, 5, 20) : intIn(r, 2, 8);
    let body = makeLongText(r, lines);
    if (mode === "adversarial" && chance(r, 0.3)) {
      // Insert a literal `>>>` content line — forces nonce-bounded form.
      body = body + "\n>>>\nfollowed by more text";
    }
    return {
      json: {
        [toF!]: makeEmail(r),
        [subjF!]: makeSentence(r),
        [bodyF!]: body,
      },
      description: "Compose a message with a multiline body field.",
    };
  },

  null_and_empties: (r) => {
    const [nullF, emptyArrF, emptyObjF, tagsF] = pickFieldNames(r, 4);
    const json: JSONObject = {
      [nullF!]: null,
      [emptyArrF!]: [],
      [emptyObjF!]: {},
      [tagsF!]: pickN(r, SHORT_STRINGS, intIn(r, 1, 4)),
    };
    return { json, description: "Compose an object with null and empty container values." };
  },

  pathological_keys: (r, mode) => {
    // Keys containing `.`, `[`, `]` — must wrap with <<<>>>.
    const n = mode === "adversarial" ? intIn(r, 3, 6) : 2;
    const json: JSONObject = {};
    for (let i = 0; i < n; i++) {
      const k = pick(r, [
        "user.email", "items[0]", "data.user.id", "tags[]", "meta.has_more",
        "config[default]", "stats.p50.latency",
      ]);
      json[k] = pick(r, [makeShortString(r), makeEmail(r), intIn(r, 1, 100)]) as JSONValue;
    }
    // Mix in normal keys
    const normalCount = intIn(r, 1, 3);
    for (const k of pickFieldNames(r, normalCount)) {
      json[k] = makeShortString(r);
    }
    return { json, description: "Compose an object whose keys contain `.`, `[`, or `]` characters." };
  },

  numeric_string_ambiguity: (r, mode) => {
    // Strings that LOOK like JSON literals.
    const candidates = mode === "adversarial"
      ? ["02134", "true", "false", "null", "42", "3.14", "-7", "0", "[]", "{}"]
      : ["02134", "true", "null", "42"];
    const stringCount = intIn(r, 2, 4);
    const json: JSONObject = {};
    for (let i = 0; i < stringCount; i++) {
      const [k] = pickFieldNames(r, 1);
      json[k!] = pick(r, candidates);
    }
    // Mix in real literals
    const [numF, boolF, nullF] = pickFieldNames(r, 3);
    json[numF!] = intIn(r, 1, 100);
    json[boolF!] = chance(r, 0.5);
    json[nullF!] = null;
    return { json, description: "Compose an object where some string values look like JSON literals." };
  },

  deep_nesting: (r) => {
    const depth = intIn(r, 3, 6);
    const names = pickFieldNames(r, depth);
    const leaf: JSONValue = pick(r, [
      makeShortString(r), intIn(r, 1, 100), chance(r, 0.5),
    ]);
    let node: JSONValue = leaf;
    for (let i = depth - 1; i >= 0; i--) {
      node = { [names[i]!]: node };
    }
    return { json: node as JSONObject, description: `Compose a ${depth}-level nested object.` };
  },

  json_heavy: (r) => {
    const [statusF, codeF, reqF, dataF] = pickFieldNames(r, 4);
    const [userF, postsF, metaF] = pickFieldNames(r, 3);
    const [idF, handleF, verifiedF] = pickFieldNames(r, 3);
    const [titleF, likesF] = pickFieldNames(r, 2);
    const [cursorF, moreF] = pickFieldNames(r, 2);
    return {
      json: {
        [statusF!]: pick(r, ["ok", "success", "ready"]),
        [codeF!]: 200,
        [reqF!]: `req_${pick(r, SHORT_STRINGS)}_${intIn(r, 100, 9999)}`,
        [dataF!]: {
          [userF!]: {
            [idF!]: intIn(r, 1, 999),
            [handleF!]: makeShortString(r),
            [verifiedF!]: true,
          },
          [postsF!]: [
            { [idF!]: 1, [titleF!]: makeSentence(r), [likesF!]: intIn(r, 0, 100) },
            { [idF!]: 2, [titleF!]: makeSentence(r), [likesF!]: intIn(r, 0, 100) },
          ],
          [metaF!]: { [cursorF!]: null, [moreF!]: false },
        },
      },
      description: "Compose a realistic API-response object.",
    };
  },

  large_table: (r) => {
    const n = intIn(r, 5, 20);
    const [arrF, idF, customerF, totalF, paidF] = pickFieldNames(r, 5);
    const rows: JSONObject[] = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        [idF!]: i + 1,
        [customerF!]: makeShortString(r),
        [totalF!]: Math.round(r() * 100000) / 100,
        [paidF!]: chance(r, 0.7),
      });
    }
    return { json: { [arrF!]: rows }, description: `Compose a ${n}-row homogeneous table.` };
  },

  heterogeneous_array: (r, mode) => {
    const n = mode === "adversarial" ? intIn(r, 4, 8) : intIn(r, 2, 5);
    const [arrF, kindF, nameF, membersF, roleF] = pickFieldNames(r, 5);
    const rows: JSONObject[] = [];
    for (let i = 0; i < n; i++) {
      const kind = pick(r, ["user", "group", "service"]);
      const row: JSONObject = { [kindF!]: kind };
      if (kind === "user") {
        row[nameF!] = makeShortString(r);
        if (chance(r, 0.4)) row[roleF!] = pick(r, ["admin", "viewer", "owner"]);
      } else if (kind === "group") {
        row[membersF!] = intIn(r, 2, 50);
      } else {
        row[nameF!] = makeShortString(r);
        row[membersF!] = intIn(r, 1, 100);
      }
      rows.push(row);
    }
    return { json: { [arrF!]: rows }, description: "Compose a heterogeneous array of objects with varying key sets." };
  },

  literal_strings: (r) => {
    const json: JSONObject = {};
    const [f1, f2, f3, f4, f5, f6] = pickFieldNames(r, 6);
    json[f1!] = "[]";
    json[f2!] = "{}";
    json[f3!] = `${pick(r, SHORT_STRINGS)},${pick(r, SHORT_STRINGS)},${pick(r, SHORT_STRINGS)}`;
    json[f4!] = "{not an object}";
    json[f5!] = "[not an array]";
    json[f6!] = `${pick(r, SHORT_STRINGS)}:${pick(r, SHORT_STRINGS)}`;
    return { json, description: "Compose an object whose string values are literal-looking forms." };
  },

  wide_heterogeneous_array: (r, mode) => {
    const n = mode === "adversarial" ? intIn(r, 6, 12) : intIn(r, 4, 7);
    const [arrF, typeF, targetF, pageF, atF, formF, valueF, refererF] = pickFieldNames(r, 8);
    const rows: JSONObject[] = [];
    let ts = intIn(r, 1_000_000_000, 2_000_000_000);
    for (let i = 0; i < n; i++) {
      const kind = pick(r, ["click", "view", "submit"]);
      const row: JSONObject = { [typeF!]: kind, [atF!]: ts };
      if (kind === "click") row[targetF!] = pick(r, ["button#submit", "a.cta", "div.banner"]);
      else if (kind === "view") {
        row[pageF!] = pick(r, ["/pricing", "/thanks", "/about"]);
        if (chance(r, 0.5)) row[refererF!] = "/home";
      } else {
        row[formF!] = pick(r, ["checkout", "signup", "contact"]);
        row[valueF!] = intIn(r, 1, 9999);
      }
      rows.push(row);
      ts += intIn(r, 1, 60);
    }
    return { json: { [arrF!]: rows }, description: "Compose a wide heterogeneous event-log array." };
  },

  flat_inline_object: (r) => {
    const [outerF] = pickFieldNames(r, 1);
    const inner: JSONObject = {};
    const fieldCount = intIn(r, 4, 8);
    for (const f of pickFieldNames(r, fieldCount)) {
      inner[f] = pick(r, [
        makeShortString(r), intIn(r, 1, 9999), chance(r, 0.5),
      ]) as JSONValue;
    }
    return { json: { [outerF!]: inner }, description: "Compose an object with one wide, flat nested object value." };
  },

  deep_array_literal: (r, mode) => {
    const [outerF, midF, innerF] = pickFieldNames(r, 3);
    const [typeF, targetF, pageF, depthF] = pickFieldNames(r, 4);
    const n = mode === "adversarial" ? intIn(r, 5, 12) : intIn(r, 3, 7);
    const rows: JSONObject[] = [];
    for (let i = 0; i < n; i++) {
      const k = pick(r, ["click", "view", "scroll"]);
      const row: JSONObject = { [typeF!]: k };
      if (k === "click") row[targetF!] = pick(r, ["button#submit", "a.cta"]);
      else if (k === "view") row[pageF!] = pick(r, ["/pricing", "/thanks"]);
      else row[depthF!] = intIn(r, 1, 100);
      rows.push(row);
    }
    return {
      json: { [outerF!]: { [midF!]: { [innerF!]: rows } } },
      description: "Compose a deeply-nested object containing an array of small heterogeneous records.",
    };
  },

  long_primitive_array: (r) => {
    const [tsF] = pickFieldNames(r, 1);
    const n = intIn(r, 6, 20);
    let ts = intIn(r, 1_000_000_000, 2_000_000_000);
    const arr: number[] = [];
    for (let i = 0; i < n; i++) {
      arr.push(ts);
      ts += intIn(r, 1, 60);
    }
    return { json: { [tsF!]: arr }, description: `Compose an object with a ${n}-element timestamp array.` };
  },

  // ── In-training mechanism carriers (see "Held-out balance" in the header) ──
  // Each of these teaches a wire-format MECHANISM that is otherwise present
  // ONLY in a held-out shape, so the model would never learn it. They use a
  // DIFFERENT surface shape than their held-out counterpart, so the holdout
  // stays a genuine generalization test rather than a "never saw the
  // mechanism" failure.

  // Carrier for the multiline `<<<…>>>` block (held-out twin: multiline_body).
  // A record with extra scalar fields around a multiline note, so the model
  // learns "value has newlines / schema says `t` → emit a block" in-distribution.
  record_with_note: (r, mode) => {
    const [authorF, titleF, noteF, countF, openF] = pickFieldNames(r, 5);
    const lines = mode === "adversarial" ? intIn(r, 4, 10) : intIn(r, 2, 5);
    let note = makeLongText(r, lines);
    if (mode === "adversarial" && chance(r, 0.4)) {
      // A content line that literally equals `>>>` forces the nonce-bounded
      // form (ADR-0011) — the model must learn that branch too.
      note = `${note}\n>>>\nplus a trailing remark`;
    }
    return {
      json: {
        [authorF!]: makeEmail(r),
        [titleF!]: makeSentence(r),
        [noteF!]: note,
        [countF!]: intIn(r, 1, 999),
        [openF!]: chance(r, 0.5),
      },
      description: "Compose a record that includes a multi-line note field.",
    };
  },

  // Carrier for the `<<<key>>>` wrapping of path-significant keys (held-out
  // twin: pathological_keys). Mixes ONE (or a few, adversarial) dotted/bracket
  // key with normal keys — the wrapping rule is count-independent, so this
  // generalizes to the heavier held-out case.
  dotted_paths: (r, mode) => {
    const n = mode === "adversarial" ? intIn(r, 2, 3) : 1;
    const wrapped = pickN(r, [
      "user.email", "items[0]", "data.id", "tags[]", "meta.more",
      "config.default", "a.b.c", "stats.p95",
    ], n);
    const json: JSONObject = {};
    for (const k of wrapped) {
      json[k] = pick(r, [makeShortString(r), makeEmail(r), intIn(r, 1, 100)]) as JSONValue;
    }
    for (const k of pickFieldNames(r, intIn(r, 2, 4))) {
      json[k] = pick(r, [makeShortString(r), intIn(r, 1, 999), chance(r, 0.5)]) as JSONValue;
    }
    return { json, description: "Compose an object mixing a dotted/bracketed key with normal keys." };
  },

  // Carrier for bracket-form arrays UNDER nesting (held-out twin:
  // deep_array_literal, which is 3 levels deep). 2-level nesting around a
  // heterogeneous array, so the model learns to keep emitting the inline
  // `[ {…} ]` form when an array sits below the top level — countering the
  // observed regression to invented `::` table syntax on unseen depths.
  nested_event_log: (r, mode) => {
    const [outerF, arrF] = pickFieldNames(r, 2);
    const [typeF, targetF, pageF, valueF] = pickFieldNames(r, 4);
    const n = mode === "adversarial" ? intIn(r, 5, 10) : intIn(r, 2, 5);
    const rows: JSONObject[] = [];
    for (let i = 0; i < n; i++) {
      const kind = pick(r, ["click", "view", "submit"]);
      const row: JSONObject = { [typeF!]: kind };
      if (kind === "click") row[targetF!] = pick(r, ["button#submit", "a.cta"]);
      else if (kind === "view") row[pageF!] = pick(r, ["/pricing", "/thanks"]);
      else row[valueF!] = intIn(r, 1, 999);
      rows.push(row);
    }
    return {
      json: { [outerF!]: { [arrF!]: rows } },
      description: "Compose a nested object containing a heterogeneous event array.",
    };
  },
};

const HARD_SHAPES = new Set([
  "pathological_keys", "numeric_string_ambiguity", "heterogeneous_array",
  "wide_heterogeneous_array", "deep_array_literal", "multiline_body",
  // In-training mechanism carriers — their adversarial mode is what teaches the
  // hard branch of each mechanism (nonce-bounded blocks, multi-wrapped keys,
  // deeper/wider nested arrays).
  "record_with_note", "dotted_paths", "nested_event_log",
]);

// ─── Schema declaration ──────────────────────────────────────────────────

// Plan §3.2 type codes: s/n/b/t (+ o for objects inside []). There is no
// standalone null code; a genuinely-null value declares the optional string
// form `s?` (base type not inferable, field may be absent), matching the
// plan's `field:type?` optional marker (e.g. `attachments[]:s?`).
function typeCode(v: JSONValue): string {
  if (v === null) return "s?";
  if (typeof v === "string") return v.includes("\n") ? "t" : "s";
  if (typeof v === "number") return "n";
  if (typeof v === "boolean") return "b";
  if (Array.isArray(v)) return "a";
  return "o";
}

// Wrap a key segment with <<<>>> if it contains path-significant chars.
const KEY_WRAP_TRIGGERS = /[.\[\]=:\n\r]/;
function keySegment(k: string): string {
  if (k.length === 0 || KEY_WRAP_TRIGGERS.test(k)) return `<<<${k}>>>`;
  return k;
}

// Declaration order matches the encoder's canonical leaf order: ASCII-sorted
// keys at each object level, walked depth-first (see `walk` in raif.ts).
// No global re-sort of the assembled paths.
function declareSchema(obj: JSONObject): string {
  const decls: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    walkSchema(obj[k]!, keySegment(k), decls);
  }
  return decls.join("\n");
}

function walkSchema(value: JSONValue, path: string, decls: string[]): void {
  if (value === null) {
    // Genuinely-null value: base type not inferable — optional string per plan §3.2.
    decls.push(`${path}:s?`);
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    decls.push(`${path}:${typeCode(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      // Empty array: element type not inferable — optional string elements.
      decls.push(`${path}[]:s?`);
      return;
    }
    const first = value[0]!;
    if (first !== null && typeof first === "object" && !Array.isArray(first)) {
      decls.push(`${path}[]:o`);
      // Walk the union of keys across all elements (sorted, matching the
      // encoder's canonical column/key order). A field absent from some
      // element, or null in any, is optional (`?`) — heterogeneous elements
      // carry subsets of the union, and a required mark would fail the
      // decoder's schema check (ADR-0019). Type comes from the first
      // non-null occurrence.
      const presence = new Map<string, { count: number; sample?: JSONValue; sawNull: boolean }>();
      let rows = 0;
      for (const el of value) {
        if (el === null || typeof el !== "object" || Array.isArray(el)) continue;
        rows++;
        for (const [k, v] of Object.entries(el as JSONObject)) {
          const p = presence.get(k) ?? { count: 0, sawNull: false };
          p.count++;
          if (v === null) p.sawNull = true;
          else if (p.sample === undefined) p.sample = v;
          presence.set(k, p);
        }
      }
      for (const k of [...presence.keys()].sort()) {
        const p = presence.get(k)!;
        const sub = `${path}[].${keySegment(k)}`;
        if (p.count === rows && !p.sawNull) {
          walkSchema(p.sample ?? null, sub, decls);
          continue;
        }
        const v = p.sample;
        if (v === undefined) decls.push(`${sub}:s?`);
        else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          decls.push(`${sub}:${typeCode(v)}?`);
        } else {
          decls.push(`${sub}:o?`); // object/array-valued optional field — open
        }
      }
      return;
    }
    // Primitive-element array: infer base type from the first non-null element.
    const firstNonNull = value.find((el) => el !== null);
    decls.push(`${path}[]:${firstNonNull === undefined ? "s?" : typeCode(firstNonNull)}`);
    return;
  }
  // Nested object
  const keys = Object.keys(value as JSONObject).sort();
  if (keys.length === 0) {
    decls.push(`${path}:o`);  // empty object — still occupies the field
    return;
  }
  for (const k of keys) {
    walkSchema((value as JSONObject)[k]!, `${path}.${keySegment(k)}`, decls);
  }
}

// ─── Prompt rendering ────────────────────────────────────────────────────
//
// Two task families. Both make the completion fully recoverable from the
// prompt — the model must never need to invent values.

type Task = "translate" | "instruct";

const TRANSLATE_OPENERS = [
  "Emit this object as RAIF:",
  "Convert this JSON to RAIF:",
  "Translate the following JSON object into RAIF:",
  "Re-encode this JSON as RAIF:",
  "Express the following object in RAIF:",
  "Rewrite this JSON payload as RAIF:",
  "Output the RAIF encoding of this JSON:",
  "Encode the JSON below in RAIF:",
  "Give me the RAIF form of this object:",
  "Serialize this JSON to RAIF:",
] as const;

const INSTRUCT_OPENERS = [
  "Create a record with the following values.",
  "I need an object with these exact fields.",
  "Please produce the following data.",
  "Generate an entry using these values.",
  "Build the object described below.",
  "Here is the data to capture.",
  "Record this information exactly as given.",
  "Assemble an object from these values.",
  "Compose an object holding exactly these values.",
  "Emit a RAIF object with the fields below.",
  "Capture the following as a single object.",
] as const;

// Each leaf is rendered with one of these templates; `p` is the dotted path,
// `v` the already-formatted value. Every template MUST include `v` verbatim.
const LEAF_TEMPLATES: ReadonlyArray<(p: string, v: string) => string> = [
  (p, v) => `Set ${p} to ${v}.`,
  (p, v) => `${p} should be ${v}.`,
  (p, v) => `Use ${v} for ${p}.`,
  (p, v) => `The value of ${p} is ${v}.`,
  (p, v) => `For ${p}, use ${v}.`,
  (p, v) => `Put ${v} in ${p}.`,
  (p, v) => `${p}: ${v}.`,
  (p, v) => `Assign ${v} to ${p}.`,
];

const EMPTY_LIST_TEMPLATES: ReadonlyArray<(p: string) => string> = [
  (p) => `${p} should be an empty list.`,
  (p) => `Leave ${p} as an empty array.`,
];

const EMPTY_OBJECT_TEMPLATES: ReadonlyArray<(p: string) => string> = [
  (p) => `${p} should be an empty object.`,
  (p) => `Leave ${p} as an empty object.`,
];

// Format a primitive for prompt embedding. Strings are JSON-quoted (so
// multiline/special-char values stay on one line and containment checks are
// exact); numbers/booleans/null use their canonical literal form.
function fmtValue(v: JSONValue): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

interface Leaf { path: string; value: JSONValue }  // primitive, [] or {}

// Collect leaves in the encoder's canonical order (sorted keys, depth-first).
function collectLeaves(value: JSONValue, path: string, out: Leaf[]): void {
  if (value === null || typeof value !== "object") {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) { out.push({ path, value }); return; }
    value.forEach((el, i) => collectLeaves(el, `${path}[${i}]`, out));
    return;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) { out.push({ path, value }); return; }
  for (const k of keys) {
    collectLeaves((value as JSONObject)[k]!, path === "" ? k : `${path}.${k}`, out);
  }
}

// Natural-language request that embeds EVERY leaf value of `json`.
function renderInstructRequest(r: () => number, json: JSONObject): string {
  const leaves: Leaf[] = [];
  collectLeaves(json, "", leaves);
  const parts: string[] = [];
  for (const leaf of leaves) {
    if (Array.isArray(leaf.value)) {
      parts.push(pick(r, EMPTY_LIST_TEMPLATES)(leaf.path));
    } else if (leaf.value !== null && typeof leaf.value === "object") {
      parts.push(pick(r, EMPTY_OBJECT_TEMPLATES)(leaf.path));
    } else {
      parts.push(pick(r, LEAF_TEMPLATES)(leaf.path, fmtValue(leaf.value)));
    }
  }
  const opener = pick(r, INSTRUCT_OPENERS);
  // Two presentation styles for phrasing variety.
  if (chance(r, 0.5)) {
    return `${opener}\n${parts.map((p) => `- ${p}`).join("\n")}`;
  }
  return `${opener} ${parts.join(" ")}`;
}

function renderTranslateRequest(r: () => number, json: JSONObject): string {
  return `${pick(r, TRANSLATE_OPENERS)}\n${JSON.stringify(json)}`;
}

// ─── Example construction ────────────────────────────────────────────────

export interface Example {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  meta: {
    shape: string;
    variation_seed: number;
    has_schema: boolean;
    mode: Mode;
    task: Task;
    source: JSONObject;
    source_dataset?: string;  // set for real-JSON examples (e.g. "glaive-fc-v2")
  };
}

// The JSON → Example tail, shared by the synthetic generator and the
// real-JSON ingester (`ingest_json.ts`). Given a concrete object, it picks the
// task, renders the request (with <schema> per the same rules), encodes the
// completion with the generation profile (ADR-0019: deterministic mode rules +
// truncation-optimal order — exactly what the model should emit; markers stay
// off per ADR-0017), and returns the full Example. Keeping this in ONE place is
// what guarantees real-data examples are byte-identical in form to synthetic
// ones — same schema block, same openers, same completion profile.
export function renderExample(
  json: JSONObject,
  r: () => number,
  schemaFrac: number,
  metaBase: { shape: string; variation_seed: number; mode: Mode; source_dataset?: string },
): Example {
  const raif = encode(json, { profile: "generation" });
  // ~50/50 task mix. Translate examples carry <schema> with prob schemaFrac;
  // instruct examples ALWAYS carry it (it is the field-name/type cue).
  const task: Task = chance(r, 0.5) ? "translate" : "instruct";
  let userContent: string;
  let includeSchema: boolean;
  if (task === "translate") {
    includeSchema = chance(r, schemaFrac);
    const req = renderTranslateRequest(r, json);
    userContent = includeSchema
      ? `${req}\n\n<schema>\n${declareSchema(json)}\n</schema>`
      : req;
  } else {
    includeSchema = true;
    userContent = `${renderInstructRequest(r, json)}\n\n<schema>\n${declareSchema(json)}\n</schema>`;
  }
  return {
    messages: [
      { role: "user", content: userContent },
      { role: "assistant", content: raif },
    ],
    meta: {
      shape: metaBase.shape,
      variation_seed: metaBase.variation_seed,
      has_schema: includeSchema,
      mode: metaBase.mode,
      task,
      source: json,
      ...(metaBase.source_dataset ? { source_dataset: metaBase.source_dataset } : {}),
    },
  };
}

function buildExample(shape: string, seed: number, args: Args): Example {
  const r = makeRng(seed);
  const variator = variators[shape];
  if (!variator) throw new Error(`no variator for shape: ${shape}`);
  const mode: Mode = HARD_SHAPES.has(shape) && chance(r, args.adversarialFrac)
    ? "adversarial" : "normal";
  const { json } = variator(r, mode);
  return renderExample(json, r, args.schemaFrac, { shape, variation_seed: seed, mode });
}

// ─── Driver ──────────────────────────────────────────────────────────────

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function writeJsonl(path: string, examples: Example[]): void {
  ensureDir(path);
  const lines = examples.map((e) => JSON.stringify(e));
  writeFileSync(path, lines.length > 0 ? lines.join("\n") + "\n" : "");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const shapes = args.shapes ?? Object.keys(variators);
  for (const s of shapes) {
    if (!variators[s]) {
      console.error(`✗ unknown shape: ${s}`);
      console.error(`  known: ${Object.keys(variators).join(", ")}`);
      process.exit(1);
    }
  }

  for (const s of args.holdoutShapes) {
    if (!variators[s]) {
      console.error(`✗ unknown holdout shape: ${s}`);
      console.error(`  known: ${Object.keys(variators).join(", ")}`);
      process.exit(1);
    }
  }
  const holdout = new Set(args.holdoutShapes);

  const byShapeExamples = new Map<string, Example[]>();
  for (const shape of shapes) {
    const exs: Example[] = [];
    for (let i = 0; i < args.variations; i++) {
      const seed = args.seed + (hashString(shape) ^ i);
      exs.push(buildExample(shape, seed, args));
    }
    byShapeExamples.set(shape, exs);
  }

  // Routing:
  //  - held-out shapes (plan §3.4) → holdoutSet ONLY; never train, never eval.
  //  - remaining shapes → stratified train/eval split: per shape, hold out
  //    ceil(evalFrac × n) examples picked round-robin across the variation
  //    range, so every shape is represented in valid.jsonl roughly evenly.
  const splitMode = Boolean(args.outTrainPath && args.outEvalPath);
  const trainSet: Example[] = [];
  const evalSet: Example[] = [];
  const holdoutSet: Example[] = [];
  for (const shape of shapes) {
    const exs = byShapeExamples.get(shape)!;
    if (holdout.has(shape)) {
      holdoutSet.push(...exs);
      continue;
    }
    if (splitMode && args.evalFrac > 0) {
      const n = exs.length;
      const evalCount = Math.min(n, Math.ceil(args.evalFrac * n));
      const evalIdx = new Set<number>();
      for (let j = 0; j < evalCount; j++) evalIdx.add(Math.floor((j * n) / evalCount));
      exs.forEach((e, i) => (evalIdx.has(i) ? evalSet : trainSet).push(e));
    } else {
      trainSet.push(...exs);
    }
  }

  // Output mode: split (train/eval) or single-file. Holdout examples are
  // written to their own file in either mode.
  if (splitMode) {
    writeJsonl(args.outTrainPath!, trainSet);
    writeJsonl(args.outEvalPath!, evalSet);
    console.log(`✓ wrote ${trainSet.length} train examples to ${args.outTrainPath}`);
    console.log(`✓ wrote ${evalSet.length} eval examples to ${args.outEvalPath}`);
  } else if (args.outPath) {
    writeJsonl(args.outPath, trainSet);
    console.log(`✓ wrote ${trainSet.length} examples to ${args.outPath}`);
  } else {
    console.error("✗ no output path specified; pass --out or --out-train + --out-eval");
    process.exit(1);
  }
  // Always write the holdout file in split mode (even when empty) so a rerun
  // with different --holdout-shapes can't leave a stale file behind.
  if (holdout.size > 0 || splitMode) {
    writeJsonl(args.outHoldoutPath, holdoutSet);
    console.log(`✓ wrote ${holdoutSet.length} held-out-shape examples to ${args.outHoldoutPath}`);
  }

  // Quick stats
  const shapeCounts = (exs: Example[]): string => {
    const m = new Map<string, number>();
    for (const e of exs) m.set(e.meta.shape, (m.get(e.meta.shape) ?? 0) + 1);
    return [...m.entries()].map(([s, n]) => `${s}=${n}`).join(", ") || "(none)";
  };
  const all = [...trainSet, ...evalSet, ...holdoutSet];
  const byMode = new Map<string, number>();
  const byTask = new Map<string, number>();
  let withSchema = 0;
  for (const e of all) {
    byMode.set(e.meta.mode, (byMode.get(e.meta.mode) ?? 0) + 1);
    byTask.set(e.meta.task, (byTask.get(e.meta.task) ?? 0) + 1);
    if (e.meta.has_schema) withSchema++;
  }
  console.log("");
  console.log(`train per shape:   ${shapeCounts(trainSet)}`);
  if (splitMode) console.log(`eval per shape:    ${shapeCounts(evalSet)}`);
  if (holdout.size > 0) console.log(`holdout per shape: ${shapeCounts(holdoutSet)}`);
  console.log(`per mode: ${[...byMode.entries()].map(([m, n]) => `${m}=${n}`).join(", ")}`);
  console.log(`per task: ${[...byTask.entries()].map(([t, n]) => `${t}=${n}`).join(", ")}`);
  console.log(`with <schema> block: ${withSchema}/${all.length} (${Math.round(withSchema / all.length * 100)}%)`);
}

export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

// Only run the synthetic generator when invoked directly (`bun run dataset.ts`),
// NOT when imported by ingest_json.ts — importing must not write any files.
if (import.meta.main) main();
