# RAIF Handoff — for the next agent (or future you)

## What is RAIF

**RAIF** (Repairable AI Interchange Format) is a wire format for a single JSON object emitted by an LLM, designed to replace JSON as the model-facing output for tool calls and structured generation. It round-trips deterministically to JSON, recovers locally from syntax errors (one bad leaf doesn't destroy the document), and beats JSON on tokens across most realistic shapes.

JSON assumes a deterministic writer. RAIF assumes a probabilistic writer (the model) and a deterministic interpreter.

## Where everything lives

```
raif-standard/
├── HANDOFF.md                          ← you are here
├── CONTEXT.md                          ← glossary; read this first
├── docs/
│   ├── raif_standard_handoff.md        ← v0.1 (the original handoff that started this work)
│   ├── raif_v0.2_spec.md               ← v0.2 spec (historical)
│   ├── raif_v0.3_spec.md               ← v0.3 spec (the current spec)
│   └── adr/
│       ├── 0001 — text-block delimiters (`<<<` / `>>>`, with per-block nonce when needed)
│       ├── 0002 — sentinels (SUPERSEDED by 0009)
│       ├── 0003 — schema versioning out of scope
│       ├── 0004 — repair fixes syntax not values
│       ├── 0005 — minimal default emission form
│       ├── 0006 — value semantics inherit from JSON
│       ├── 0007 — value-wrap rules are minimal
│       ├── 0008 — table mode for homogeneous arrays
│       ├── 0009 — null and empty containers use JSON literals
│       ├── 0010 — inline-object form for heterogeneous arrays / flat nested objects
│       ├── 0011 — multiline nonce is optional, used only on demand
│       ├── 0012 — encoder picks the cheapest emission per array / nested object
│       ├── 0013 — multi-line array literal `prefix=[\n…\n]` for shared-prefix savings
│       ├── 0014 — four-function API surface (encode/decode/fix/validate)
│       ├── 0015 — deterministic decoder repair tier (TIER 2 A/B/C/D)
│       ├── 0016 — schema-as-parity design principle (optional schema parameter)
│       └── 0017 — fine-tune integration philosophy (LoRA + GBNF, 3B target)
└── prototype/
    ├── README.md                       ← run commands, per-run NOTES
    ├── src/raif.ts                     ← encoder + decoder (the keepers; pure functions)
    ├── src/corpus.ts                   ← 18 representative JSON shapes
    ├── src/bench.ts                    ← batch benchmark
    ├── src/raif.test.ts                ← 60 property tests
    ├── src/check.ts                    ← round-trip smoke test
    └── src/tui.ts                      ← interactive browser
```

## How we got here (one paragraph)

User brought a v0.1 spec written as a handoff doc and asked for a grilling session. Nine rounds of grilling produced six ADRs that sharpened the design: nonce-bounded delimiters (0001), bare-sentinels (0002, later reversed), schema versioning declared out of scope (0003), repair scoped to syntax only (0004), default emission stripped of ceremony (0005), value semantics aligned with JSON (0006). A v0.2 spec was written. We then built a TypeScript prototype (encoder + decoder + tokenizer-driven benchmark) and discovered two empirical problems: `␞` (U+241E) tokenizes as 3 tokens in cl100k_base, not 1; and path mode is structurally bad for arrays of repeated records. Three follow-up ADRs (0007, 0008, 0009) fixed both. The benchmark moved from **+24%** (RAIF loses) to **-8%** (RAIF wins) across the prototype corpus. A subsequent v0.3 pass added an inline-object leaf form for heterogeneous arrays and flat nested objects (ADR-0010), made the multiline nonce optional (ADR-0011), and taught the encoder to pick the cheapest emission per array / nested object (ADR-0012). Then ADR-0013 added a multi-line array literal `prefix=[\n…\n]` as a fourth array-emission candidate, sharing the array prefix once across all rows. The benchmark moved from **-8%** (v0.2) → **-13%** (v0.2 corpus, v0.3 encoder) → **-14%** (v0.2 corpus + ADR-0013) → **-13%** (18-case corpus including two new array-literal-friendly cases). The biggest cumulative swing was `heterogeneous_array` from +63% → +9% (inline-object) → -9% (array literal). The repair pass was extended to strip `<raif>`/`</raif>` mode markers, coerce stray `:` separators, and recover mismatched multiline nonces.

## Current state of the spec

**v0.4.2 — schema-typed decode + generation profile (2026-06-13, [ADR-0019](./docs/adr/0019-schema-typed-decode-and-generation-profile.md))**

| Area | What landed |
|---|---|
| Schema-typed decode | All four API functions take an optional schema (plan §3.2 syntax, `<schema>` tags accepted). Types come from the schema: `placeholder=null` under `placeholder:s` is the string "null" — the wrap-when-literal fidelity killer is gone by construction. `n`/`b` must parse or error (never coerced); `field:s?` is nullable/omittable; required/unknown fields validated; unwrapped pathological keys recover via declared flat fields. Verified 1,534/1,534: every schema block in the regenerated training data parses, and schema-typed decode of every completion reproduces the exact source JSON. |
| Generation profile | `encode(obj, { profile: "generation", markers?: true })`: deterministic mode precedence (no cheapest-pick — a model can't replicate a byte-cost optimizer), scalars-first/blocks-last ordering, optional `<raif>`/`</raif>` framing with `decodeLenient(...).truncated`. Measured: **−12.2% tokens vs JSON** and **47.3% leaf recovery under truncation at equal token budgets vs 40.8% for JSON+jsonrepair** — both headline claims now hold on the same emission form (canonical was −14.4% / 43.0%). |
| Wiring | Dataset completions now use the generation profile (canonical stays the `fix` output); heterogeneous-array schemas mark partial union fields `?`. GBNF accepts both profiles + marker framing (lint 58/58). Marker stripping is edge-anchored whole-line only (was a global rewrite — another silent value-corruption vector, plus a stateful `/g`-regex detection bug, both fixed). Tests 121 → **153**; new format benchmarks: `bun compare` (RAIF/TOON/YAML/JSON, two tokenizers), `bun truncation`. |

**Next step unchanged:** warm LoRA re-run on the regenerated data (now generation-profile completions), then consider re-baselining eval to also report schema-typed fidelity for schema-bearing examples.

**v0.4.1 hardening (2026-06-13)** — a full audit (encoder/decoder, data pipeline, GBNF) found and fixed four classes of silent data corruption plus a set of contract violations. [ADR-0018](./docs/adr/0018-round-trip-hardening.md) captures the semantic changes; the v0.3 spec carries an amendments note. Highlights:

| Area | What changed |
|---|---|
| Encoder wrap rules | Closed against whole-line hazards (opener tails `…=<<<` / `…=[`, `{` and mid-`<<<` in cells). `decode∘encode` identity now holds under a 500-seed adversarial fuzz test (5,000 locally). |
| Repair tier | Brace-flattening is block-aware — it can no longer rewrite multiline value bytes (was an active ADR-0004 violation). Truncated documents (unterminated `<<<` block / `[` literal at EOF) now repair instead of hard-erroring — this was the #1 observed LoRA parse failure. Ambiguity still refuses. |
| Canonical form | `key:s=value` tag form is canonical for protected strings (bench −13% → **−14%**; −14.4% on the Llama-3.2 tokenizer, measured). True UTF-8 byte-order sort. Deterministic content-derived nonces — `validate(encode(x))` and byte-idempotent `fix` now hold. |
| New API | `decodeLenient` — per-leaf recovery promised by spec §3.1/§11: returns partial value + named per-leaf errors, never throws. Enables "re-ask only the broken field" agent flows. |
| Security | `__proto__` paths can no longer pollute prototypes (own-property decode semantics). |
| TIER 2-D | Superseded: `null` table cells decode as JSON null (restores v0.3 compatibility); encoder may emit null cells. |
| Tests | 91 → **121** (regression slices per audit finding + seeded property test). `bun check` 18/18, `bun test` 121/121, tsc clean. |
| Data pipeline | `dataset.ts` rebuilt: 50/50 translate/instruct task mix with every leaf value present in the prompt (fidelity was structurally unlearnable before — 41 completions per repeated prompt), stratified eval split, the plan §3.4 five held-out shapes routed to `eval_holdout.jsonl`, schema `s?` syntax aligned with the plan, value pools expanded ~10×. `eval_smoke.py` now evaluates valid+holdout (was: training data), batches decoding, fixes the denominator. `check_data.py` asserts containment/leakage/stratification — all green on regenerated data. |
| GBNF | Rewritten (was: rejected every multiline value, every bare `<`, every embedded-`>>>` wrap, most key shapes). `grammars/grammar_lint.ts` (built-in GBNF interpreter) verifies all 18 corpus encodings + negatives: 39/39. |

**Next step (blocked on charger/time, not on code):** re-run the warm LoRA (`configs/llama-3-3b-sft-warm.yaml`) on the regenerated data; fidelity should move off 0% materially. Then the full acceptance run per `docs/fine_tune_plan.md` §5.

**v0.4 (post-Track-1) summary** — ADRs 0014–0017 captured the design; `prototype/src/raif.ts` implements it.

| Pillar | Status |
|---|---|
| Public API | **Four functions:** `encode` / `decode` / `fix` / `validate`. ADR-0014. `fix` is the pure RAIF→canonical RAIF entry point; `decode` composes `fix → parse → toJson`; `validate` is a read-only canonicality check. |
| JSON round-trip | **Validated** across 18 corpus shapes. Deterministic for in-scope inputs (single JSON object, no top-level arrays/primitives). 18/18 round-trip, 18/18 idempotent. |
| Token efficiency | **-13% overall vs minified JSON (18-case corpus); -14% on the original v0.2 12-case corpus.** Unchanged from v0.3. Wins on all common shapes; only residual loss is `pathological_keys` (+7%). |
| Self-healing — TIER 1 (surface) | Markdown fences, line endings, mode markers (`<raif>` / `<|raif_start|>` and their closers), stray `:` → `=` separator coercion, mismatched-nonce recovery for multiline closers, multi-line JSON braces flattening (TIER 1A), off-by-one delimiter recovery (TIER 1B). Refuses to repair when multiple repairs are equally plausible. |
| Self-healing — TIER 2 (structure, v0.4) | ADR-0015. **A** leading-zero number → string (formal invariant; already v0.3 behavior). **B** repeated-key auto-indexing. **C** nested inline-object flattening via brace-depth-aware comma split. **D** sparse table mode (decoder-accept). Empirical: on the 216 v0.3 OpenRouter outputs, +10 parses / +1 fidelity with zero regressions. C is the workhorse (21 firings); B and D fire occasionally. |
| Model correctness | **6-model OpenRouter sweep re-run with v0.4** — `gpt-oss-20b` 100% parse / 89% fidelity (was 100/83), `claude-haiku-4.5` 97/72 (was 94/72), `gemma-3-4b` 75/47 (was 64/42). 7B class still at 42-44% fidelity. Residual is the schema-class ambiguity (pathological keys, bare-literal strings) which is fine-tune territory per [ADR-0017](./docs/adr/0017-fine-tune-integration-philosophy.md). Track 2 markers explicitly skipped — fine-tune is the chosen vehicle. |

## Prototype run commands

```sh
cd prototype
mise install              # bun 1.3.13
bun install               # gpt-tokenizer + types
bun check                 # 14/14 round-trip
bun test                  # 34/34 property tests
bun bench                 # token comparison vs JSON
bun tui                   # interactive single-case browser
```

## What's open

### Findings from LLM harness — run 1 (`gemma3:4b`, 3 trials × 18 shapes)

The translation harness (`bun harness`, see `prototype/src/harness.ts`) asks a local Ollama model to re-emit each corpus shape as both RAIF and JSON, then scores parse + fidelity + token count. First headline numbers:

| metric | RAIF | JSON |
|---|---:|---:|
| parse rate | 72% | 94% |
| fidelity rate (parsed AND matches expected) | 44% | 83% |
| repair pass used | 0% | n/a |
| mean output tokens | 43 | 47 |
| Δ tokens vs JSON | **−9%** | — |

**The token-efficiency claim holds on actual model output.** −9% averaged across 18 corpus shapes, matching the encoder-side bench's −13% (the small gap is the model adding small inefficiencies like extra whitespace or sub-optimal mode choices).

**The model-fluency claim does NOT hold at 4B params.** Models reliably know JSON; they only know RAIF from 3 in-prompt examples. Failure-mode taxonomy:

1. **Multi-line JSON braces instead of path mode** — `deep_nesting`, `deep_array_literal`. Model emits `a={\n  b={\n  c=…\n  }\n}` (JSON-flavored) instead of `a.b.c=…`. Parse fail.
2. **Repeated key without index** — `heterogeneous_array`. Model writes `mixed={…}\nmixed={…}\nmixed={…}` (same key three times) instead of `mixed[0]=…`. Parse fail (path collision).
3. **Nested inline-objects** — `json_heavy`. Model nests `data={user={…},posts=[\n…\n]}` on one line; the spec only allows flat inline-objects. Parse fail.
4. **Wrong number of cells in table row** — `wide_heterogeneous_array`. Model used table mode for a heterogeneous array; row widths don't match the header.
5. **Pathological keys not wrapped** — `pathological_keys`. Model writes `user.email=…` instead of `<<<user.email>>>=…`; decoder reads it as `user.email` nested path → fidelity fail.
6. **Wrap-when-literal forgotten** — `numeric_string_ambiguity`, `literal_strings`. Model writes `placeholder=null` for the string `"null"` instead of `<<<null>>>`. Fidelity fail.
7. **Multiline delimiter typo** — `multiline_body`. Model writes `body=<<\n…\n>>>` (two `<`, three `>`) instead of `<<<…>>>`. Off-by-one corrupts the whole body.
8. **Whitespace munging / escape literals** — Model emits literal `\n` characters where actual newlines were expected, or rewrites unicode quotes. Hits both formats.

**Repair pass triggered 0% of trials.** The implemented repairs (markdown fences, mode markers, separator coercion, mismatched-nonce recovery) target *surface* errors. The observed failures are *grammar* errors that the model invented confidently — exactly the class the repair pass intentionally doesn't fix (ADR-0004). To unlock repair, we'd need to lift several of these into the bounded-repair tier (e.g. "multi-line JSON braces → path mode normalization"), which is non-trivial and changes the repair pass's posture.

**Partial 31B signal.** A second run on `gemma4:31b` was interrupted at trial 10/28 (load + per-call latency was prohibitive for this session — ≈ 70 s per call, no incremental save at the time, so a full run would have taken an hour). Before it was killed, three shapes had clean signal:

| shape | 4B RAIF | 31B RAIF |
|---|---|---|
| `deep_nesting` | 0% parse | **2/2 ✓ (parse + fidelity)** |
| `multiline_body` | 100% parse, 0% fidelity | **2/2 ✓ (parse + fidelity)** |
| `pathological_keys` | 100% parse, 0% fidelity | 2/2 △ (parse OK, fidelity still fails) |

Two of three jumped to clean ✓ at 31B. The pathological-keys failure persists at scale — strongly suggests it needs an explicit anti-example in the prompt ("for keys with `.` `[` `]`, wrap with `<<<…>>>`"), not more parameters. Incremental save is now in the harness (each trial persists to disk on completion) so subsequent long runs survive kills/crashes.

**Not yet tested.** Full 31B sweep, `qwen3-coder-next` (79B coder model, plausibly the strongest local option), prompts with more examples or anti-examples, fine-tuning. The harness exists and the data path is reproducible.

### Findings — multi-model OpenRouter sweep (run 2)

The harness was extended with an OpenRouter provider (`--provider openrouter`, key via `OPENROUTER_API_KEY` env) so cheap models could be tested in parallel. 6 models × 18 shapes × 2 formats × 2 trials = **432 trials in roughly 4 minutes**, total cost a few cents. The TIER 1A + 1B repairs (multi-line braces → path mode flattening, off-by-one delimiter recovery) were live during this run.

| model | RAIF parse | RAIF fidelity | JSON parse | JSON fidelity | RAIF tok | JSON tok | Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| meta-llama/llama-3.1-8b-instruct | 75% | 42% | 86% | 67% | 46 | 49 | −6% |
| google/gemma-3-4b-it | 64%¹ | 42%¹ | 81% | 81% | 29 | 35 | −17% |
| qwen/qwen-2.5-7b-instruct | 89% | 44% | 81% | 72% | 42 | 50 | −16% |
| mistralai/mistral-nemo | 83% | 53% | 94% | 94% | 44 | 49 | −10% |
| openai/gpt-oss-20b | **100%** | **83%** | 100% | 100% | 40 | 48 | −17% |
| anthropic/claude-haiku-4.5 | 94% | 72% | 100% | 100% | 46 | 48 | −4% |

¹ Inflated by 8 upstream 429 rate-limits, not RAIF failures.

**Headlines:**

1. **Token win holds across every model**: −4% to −17%. The encoder-side bench number (−13%) is reproduced on actual model output. The whole *thesis on tokens* stands.
2. **Reliability scales sharply with model**. `gpt-oss-20b` hit 100% parse / 83% fidelity for RAIF (essentially matching JSON) and emits ~17% fewer tokens. At 20B params RAIF is fluent enough to recommend by default. Below 8B it's marginal.
3. **TIER 1A + 1B repairs fired only once** in 432 trials (one `multiline_braces_flattened`). The repairs are sound and unit-tested, but the error distribution at this scale is dominated by *other* failure modes — pathological-key un-wrapping, literal-wrap forgotten, mid-stream truncation, value mutation (smart-quote substitution, array reordering) — that ADR-0004 explicitly refuses to repair without schema context. The repairs that we built are valuable for a specific small-model fingerprint (local `gemma3:4b` exhibited them); they don't help much at the OpenRouter-cheap-models scale.
4. **RAIF actually beats JSON on 3 shapes**: `deep_nesting`, `array_of_objects`, `text_with_specials`. The mechanism is interesting: small models *reorder JSON keys/array elements* between input and output, breaking byte fidelity. RAIF's canonical sort hides this — not a format advantage so much as a happy accident, but worth noting.
5. **Hardest shapes** (where RAIF loses on 5+ models): `pathological_keys` (0/12 fidelity — model never wraps `.`-keys), `numeric_string_ambiguity` (3/12 — model never wraps literal-looking strings), `deep_array_literal` (1/12), `heterogeneous_array` (2/12). All four are TIER 2 in the repair taxonomy — fundamentally ambiguous without schema.

**Implications for the spec:**

- The repair pass design is validated by the harness — TIER 1 repairs are correct, just rarely needed at this scale. TIER 2 repairs would need an ADR-0004 amendment to allow schema-aware value repair.
- The "fluency at 20B+ params" finding suggests RAIF could ship today for any model class that can run `gpt-oss-20b` or stronger, and would benefit from a fine-tune for the 1B–8B range. The few-shot prompt is *barely* sufficient at 8B.
- The format-comparison numbers (parse/fidelity rates) are now reproducible: anyone can rerun `bun harness --provider openrouter --models …` and get an updated table without re-implementing the harness.

### Likely-next work (in priority order)

1. **Stronger prompts before declaring the fluency claim falsified.** The current prompt has 3 examples and 14 lines of spec. Try: (a) one example per shape category that fails most often (deep_nesting, heterogeneous_array, pathological_keys, multiline); (b) explicit "DO NOT" anti-examples for the JSON-braces-instead-of-path failure mode; (c) bigger model (`gemma4:31b` or `qwen3-coder-next`) as the baseline. If a frontier-coder model still fails most shapes, the fluency claim probably needs a fine-tune, not better prompts.
2. **Run the benchmark across more tokenizers.** We probed cl100k_base only. Gemma's tokenizer, Llama 3's tokenizer, and Qwen's tokenizer all differ in how they handle `<<<` and the multi-byte UTF-8 path-syntax chars. Use `transformers.AutoTokenizer` from Python or HF's JS SDK. If a tokenizer makes `<<<` cost 3 tokens, the delimiter decision needs re-visiting.
3. **Repair-robustness corpus.** The repair pass landed (mode markers, separator coercion, mismatched-nonce recovery, refusal on ambiguous repairs). Next: build a corpus of *broken* RAIF (truncated stream, jumbled leaves, partial markdown wrappers, model-style escape errors) and measure repair recovery rate. The current test suite only proves the happy-path behavior of each repair. Specific gap: an unterminated array literal (ADR-0013) currently throws hard; a synthesized-`]` repair at the next top-level-looking line would be tractable and bounded.
4. **Implement RAIF-R canonical form** (spec Section 9) — per-leaf checksums and object-level checksum for the audit tier. Only needed if someone wants to use RAIF for durable archives, which is a secondary use case.

### Known limitations / open trade-offs

- **`pathological_keys` loses by +7%.** Small object where every key needs `<<<>>>` wrapping. Newline-per-leaf overhead dominates. Inline-object form doesn't help at 3 keys; would need a root-level inline form (which we deliberately rejected — root must stay path-addressable for per-leaf recovery).
- **`heterogeneous_array` and friends now win** (-9% / -8%) after ADR-0013 (multi-line array literal). The structural gap to JSON's per-row `,` cost is closed by sharing the array prefix once.
- **Tokenizer sensitivity.** The delimiter choice (`<<<` / `>>>`) is optimal for cl100k_base. Other tokenizers may merge differently. If RAIF gets pushed into a tokenizer that costs `<<<` as 3+ tokens, the math changes.
- **Schema validation surface.** Spec Section 7 mentions schema validation but the prototype has none. Worth deciding: Zod? JSON Schema? Custom?
- **Grammar-constrained decoding.** Spec Section 12 promises GBNF support. Not implemented. Would unlock stronger reliability claims for fine-tuned and constrained generation paths.

### Bigger questions we haven't grilled

- **Should RAIF emit objects with key order preserved (source order), or always sort?** Currently sorts UTF-8 byte order. Sorting breaks one specific class of consumers who care about JSON key insertion order (rare but real).
- **Does the encoder need streaming?** For large objects (≫1MB), the current "build full string" approach OOMs. Open question whether RAIF cares about this scale.
- **The "wins on every case" goal isn't fully met.** `heterogeneous_array` and `pathological_keys` still lose. Decide: accept these as known limitations, or design more aggressive fallbacks.

## How to pick this up

If you're a new agent reading this cold:

1. Read `CONTEXT.md` for vocabulary.
2. Read `docs/raif_v0.3_spec.md` end to end (~430 lines). `raif_v0.2_spec.md` is kept for historical reference but is superseded.
3. Skim `docs/adr/0001` through `0013` for the *why* behind each design decision. ADRs 0010–0013 are the v0.3 changes (inline-object form, optional multiline nonce, cheapest-mode pick, multi-line array literal).
4. Run `cd prototype && bun check && bun test && bun bench` to see the current state in numbers.
5. If your task involves the encoder/decoder, the only file you need to touch is `prototype/src/raif.ts`. Add corpus cases to `corpus.ts` and tests to `raif.test.ts`. Every change must keep `bun check && bun test` green.
6. If your task changes wire-format semantics, write a new ADR (next number: 0014) and update the spec to match. Don't edit existing ADRs except for typos or to add a "superseded by" pointer.

## Out-of-scope reminders

The temptation to extend RAIF into adjacent territory is real. ADR-0003 already pushed back on schema versioning. Other things RAIF should NOT try to be:

- A general-purpose data interchange format. RAIF only handles **single JSON objects** for **LLM-generated output**. Not arrays at root, not primitives at root, not streams of objects, not binary data.
- A compression format. The token wins come from removing JSON's per-field ceremony, not from compressing values. Don't add value-level compression.
- A schema language. The spec references "schemas" but defers their structure to consumers (Zod, JSON Schema, etc.).
- TOON. TOON is for LLM *input* compression. RAIF is for LLM *output* repairability and round-tripping. They solve different problems.

## Contact-of-record

Conversation that produced this: between the user and Claude Code (Opus 4.7) over a single session on 2026-05-16. All ADRs and the v0.2 spec were written within that session. No external collaborators yet.
