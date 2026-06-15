# RAIF token-cost benchmark

Multi-tokenizer RAIF-vs-JSON token cost comparison. Reproducible via `uv run bench.py`.

Dependencies are declared inline (PEP 723). `uv run` resolves them, with no venv
and no install step.

```sh
uv run bench.py                                  # cases.json + bundled stress holdout, all tokenizers
uv run bench.py --holdout holdout_realistic.jsonl # 10,677 real function-call payloads
uv run bench.py --no-holdout                      # curated cases only
uv run bench.py --markdown                        # emit the tables below
```

All inputs are committed (`cases.json`, `holdout.jsonl`, `holdout_realistic.jsonl`),
so every number in this README reproduces from a clean checkout, with no sibling
repo required.

RAIF and JSON round-trip losslessly (`decode(encode(x)) === x`), so this is a
pure serialization-cost comparison on identical data. No information is traded
for the smaller token count.

## TL;DR

Token savings vs minified JSON, by data shape and tokenizer:

- **Real function-call data (10,677 actual payloads):** −9% to −10% in aggregate
  (cl100k −9.2%, o200k −10.2%, Mistral −7.9%), median −11%, RAIF worse on only
  ~3%. The most realistic figure here (`holdout_realistic.jsonl`).
- **18-shape curated corpus:** −14% (cl100k), −12% to −16% on cl100k / o200k /
  Llama / Qwen, −5% on Mistral.
- **Real-world payloads:** −3% to −39%. Flat string-heavy records −3–5%, configs
  and feature-flag records −10–12%, arrays of objects that share keys (tables)
  −17–39%.
- **Repetitive / tabular data:** −25% to −37%, up to −74% on wide boolean grids.
- **Tokenizer-dependent:** cl100k/o200k and Llama tokenize JSON punctuation
  loosely (RAIF saves more). Mistral packs it tighter (−5–8%). All five reported below.

## How savings are measured

`bench.py` reports two percentages, because they answer different questions:

| metric | definition | use |
|---|---|---|
| **aggregate** | `(Σ json_tokens − Σ raif_tokens) / Σ json_tokens` | the billing-relevant figure: total tokens saved over a workload |
| **per-case** | mean/median of each payload's own savings | shows the spread, a tiny flat object counts as much as a 1000-token table |

The aggregate is token-weighted, so a few large payloads dominate the sum.
Results are reported per group rather than blended into one number.

## Results

### 1. Curated corpus (18 shapes)

One representative payload per RAIF shape (`cases.json`, group `corpus`): flat
records, nested objects, arrays of primitives, mixed-type arrays, and tables.

| tokenizer | models | aggregate | per-case median | best case |
|---|---|---:|---:|---:|
| `cl100k` | GPT-3.5 / GPT-4 | **−14.4%** | −12.0% | −50.0% |
| `o200k` | GPT-4o / 4.1 / o-series | **−15.9%** | −13.4% | −53.3% |
| `llama3` | Llama 3.x | **−14.4%** | −12.0% | −50.0% |
| `qwen2.5` | Qwen 2.5 | **−12.3%** | −11.3% | −50.0% |
| `mistral` | Mistral 7B v0.3 | **−5.5%** | −1.9% | −42.1% |

### 2. Real-world data patterns (12 cases, group `real_world`)

Payloads from common use cases: user records, configs, orders, analytics,
webhooks, product catalogs. Aggregate −23.7% on cl100k, per-case median −12.3%
(the aggregate is token-weighted, so the large tables pull it up).

| case | description | JSON tok | savings (cl100k) |
|---|---|---:|---:|
| `rw_crm_contact` | 17-field sales contact | 113 | −3.5% |
| `rw_analytics_event` | nested event + properties + context | 101 | −4.0% |
| `rw_user_record` | 12-field user profile | 90 | −4.4% |
| `rw_webhook_payload` | webhook with commits array | 125 | −9.6% |
| `rw_app_config` | 4-section app config, dense primitives | 104 | −11.5% |
| `rw_feature_flags` | 16-field permissions/flags record | 92 | −12.0% |
| `rw_order_document` | order with 4-item line-items array | 143 | −12.6% |
| `rw_api_list_response` | paginated list response (3 × 5 cols) | 87 | −17.2% |
| `rw_ab_test_results` | A/B variants table (3 × 6 cols) | 117 | −27.4% |
| `rw_daily_metrics` | 7-day analytics table (7 × 6 cols) | 277 | −29.2% |
| `rw_product_catalog` | product list (8 × 5 cols) | 211 | −32.7% |
| `rw_session_analytics` | session analytics (10 × 10 cols) | 530 | −39.4% |

### 3. Held-out eval corpus (2,500 payloads)

The held-out set the fine-tuned models were evaluated on, bundled as
`holdout.jsonl` (gold RAIF + shape, from the `raif-lora` eval split). It is
**equal-weighted across 5 chosen shapes** (500 each), two of them deliberate
stress shapes (`pathological_keys`, `flat_inline_object`): a stress mix, not a
natural frequency distribution.

| tokenizer | aggregate | per-case mean | per-case median |
|---|---:|---:|---:|
| `cl100k` | **−14.0%** | −5.5% | −4.3% |
| `o200k` | **−14.9%** | −6.6% | −6.3% |
| `llama3` | **−14.0%** | −5.5% | −4.3% |
| `qwen2.5` | **−12.1%** | −4.8% | −4.0% |
| `mistral` | **−7.8%** | +3.5% | +4.2% |

The aggregate is token-weighted, so the large tables carry it. The per-case
mean/median are dragged down by the two stress shapes. Per-shape breakdown is in
Section 5.

### 4. Where the 35–70% comes from (repetitive structures)

Per-case savings (cl100k) on the extreme groups in `cases.json`:

| case | shape | JSON tok | RAIF tok | savings |
|---|---|---:|---:|---:|
| `price_book_30x6` | 30 rows × 6 cols | 874 | 642 | **−27%** |
| `telemetry_40x9` | 40 rows × 9 wide-key cols | 1445 | 939 | **−35%** |
| `event_log_50x5` | 50 rows × 5 cols | 1354 | 862 | **−36%** |
| `large_table` (corpus) | tabular | 180 | 133 | **−26%** |
| `deep_nesting` (corpus) | nested object | 14 | 7 | **−50%** |
| `feature_matrix_50x10_bool` | 50 × 10 booleans | 3004 | 791 | **−74%** |

The mechanism is the same in every high-savings case: an **array of objects that
share keys**. JSON re-emits `"key":` and its quotes on every row. RAIF declares
the columns once (`items::a,b,c`) and writes only the values per row. The wider
the rows and the more of them, the larger the win, which is why structured agent
output (tool-call batches, event logs, telemetry, tables) benefits most, and a
single flat record benefits least.

### 5. Where RAIF is less efficient (and it's tokenizer-dependent)

RAIF is not smaller on every shape. Median per-payload savings on the holdout, by
shape and tokenizer (positive = RAIF cheaper, **negative = RAIF costs more**):

| shape (n=500 each) | cl100k | o200k | llama3 | qwen2.5 | mistral |
|---|---:|---:|---:|---:|---:|
| `large_table` (for contrast) | +23.2% | +23.4% | +23.2% | +19.3% | +19.0% |
| `multiline_body` | +7.4% | +8.3% | +7.4% | +7.1% | **−3.0%** |
| `deep_array_literal` | +3.1% | +8.4% | +3.1% | +3.1% | **−2.6%** |
| `flat_inline_object` | +0.0% | +0.0% | +0.0% | +0.0% | **−16.7%** |
| `pathological_keys` | **−5.9%** | **−6.5%** | **−5.9%** | **−5.7%** | **−11.1%** |

There is no single "how often is RAIF worse" number. It depends entirely on how
much of your data lands on these shapes, so it's a worst-case, not a rate. This
corpus over-weights the unfavorable shapes on purpose (40% of rows are
`pathological_keys` + `flat_inline_object`). Real payloads rarely carry keys with
literal `.`/`[`/`]`, so in practice the loss is rare. Two things trigger it:

- **Escaped keys, not the delimiters.** A bare `key=value` has no quotes, so it
  beats JSON's `"key":"value"`. That is RAIF's win (a normal field is −2 tokens).
  RAIF loses only when a key contains `.`/`[`/`]`, or a value looks like a literal,
  and must be wrapped: `<<<user.email>>>=` is 5 tokens vs `"user.email":` at 3.
  JSON's quotes merge into the neighboring text (`"user` and `":` are each one
  token). `<<<` and `>>>` stay separate, so when RAIF does escape, the escape
  costs more than the quote it stands in for. On Mistral the gap widens: `<<<` is
  2 tokens (`>>>` stays 1). Delimiter choice:
  [ADR 0001](../docs/adr/0001-text-block-nonce-delimiters.md).
- **Dotted paths.** A single-key object around a nested object becomes
  `wrapper.a=…`, `wrapper.b=…`, repeating the prefix on every field, and with
  enough fields that exceeds JSON's one `{…}`. This drives `flat_inline_object`.

Both losses are small (typically +1 token) and round-trip losslessly. Small
payloads have little absolute headroom either way. The median real-data win is
~2 tokens. Rule of thumb: RAIF wins on flat objects with named scalar fields
(`key=` drops JSON's quotes, its most common real-world win) and on deep nesting
or wide shared-key tables. It's a wash on arrays of primitives, and a small loss
on pathological keys, single-key wrappers, and numeric matrices (more so on
tokenizers that split `<<<`).

**Tokens aren't the whole story.** This benchmark counts tokens only. RAIF's
`decode`/`fix` also repairs common malformed model output from the wire
(leading-zero numbers become strings, repeated keys become array indices, nested
inline-objects become path form). Malformed JSON just fails to parse. So a few
extra tokens on these shapes buy error tolerance JSON lacks (not scored here). See
[ADR 0015](../docs/adr/0015-deterministic-decoder-repair-tier.md),
[ADR 0004](../docs/adr/0004-repair-fixes-syntax-not-values.md).

## Adding to the benchmark

By design, both axes extend with a one-line change:

- **A tokenizer:** add an entry to `TOKENIZERS` in `bench.py` (`tiktoken` id or
  any Hugging Face model id). It loads lazily. If a dependency or download is
  missing, that column is skipped, not fatal.
- **A test case:** add `{ "name", "group", "value" }` to `cases.json`. Use
  `corpus` (curated shapes), `real_world` (concrete use-case payloads),
  `repetitive` (large same-schema arrays), `degenerate` (extreme structures),
  or `floor` (break-even baseline).

## Relationship to the TypeScript bench

The **RAIF-vs-other-formats** comparison (TOON, YAML) lives in
[`../packages/js/bench/compare_formats.ts`](../packages/js/bench/compare_formats.ts)
because TOON only has a working encoder in JavaScript (the PyPI ports are stubs).
That bench covers cl100k / o200k. This Python bench owns the **multi-tokenizer**
RAIF-vs-JSON story, because the tokenizers (`tiktoken` + `transformers`) live in
Python. The RAIF encoder is identical across both (`raif.encode` in Python is
byte-for-byte the canonical TS `encode`, verified on the corpus).
