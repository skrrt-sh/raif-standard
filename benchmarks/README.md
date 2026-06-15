# RAIF token-cost benchmark

Multi-tokenizer RAIF-vs-JSON token cost comparison. Reproducible via `uv run bench.py`.

Dependencies are declared inline (PEP 723); `uv run` resolves them — no venv, no
install step.

```sh
uv run bench.py                # cases.json + bundled holdout.jsonl, every tokenizer it can load
uv run bench.py --no-holdout   # curated cases only (skip the 2,500-payload holdout)
uv run bench.py --markdown     # emit the tables below
```

Both inputs are committed (`cases.json`, `holdout.jsonl`), so every number in
this README reproduces from a clean checkout — no sibling repo required.

RAIF↔JSON is a **lossless** round-trip (`decode(encode(x)) === x`), so this is a
pure serialization-cost comparison on identical data — no information is traded
for the smaller token count.

## TL;DR

Token savings vs minified JSON, by data shape and tokenizer:

- **18-shape curated corpus:** −14% (cl100k); −12% to −16% on cl100k / o200k /
  Llama / Qwen, −5% on Mistral.
- **Real-world payloads:** −3% to −39%. Flat string-heavy records −3–5%; configs
  and feature-flag records −10–12%; arrays of objects that share keys (tables)
  −17–39%.
- **Repetitive / tabular data:** −25% to −37%, up to −74% on wide boolean grids.
- **Tokenizer-dependent:** cl100k/o200k and Llama tokenize JSON punctuation
  loosely (RAIF saves more); Mistral packs it tighter (−5–8%). All five reported below.

## How savings are measured

`bench.py` reports two percentages, because they answer different questions:

| metric | definition | use |
|---|---|---|
| **aggregate** | `(Σ json_tokens − Σ raif_tokens) / Σ json_tokens` | the billing-relevant figure: total tokens saved over a workload |
| **per-case** | mean/median of each payload's own savings | shows the spread; a tiny flat object counts as much as a 1000-token table |

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

### 3. Natural distribution (2,500 held-out payloads)

The held-out eval set the fine-tuned models emit, bundled as `holdout.jsonl`
(gold RAIF + shape, from the `raif-lora` eval split).

| tokenizer | aggregate | per-case mean | per-case median | % of payloads RAIF is *worse* |
|---|---:|---:|---:|---:|
| `cl100k` | **−14.0%** | −5.5% | −4.3% | 29% |
| `o200k` | **−14.9%** | −6.6% | −6.3% | 27% |
| `llama3` | **−14.0%** | −5.5% | −4.3% | 29% |
| `qwen2.5` | **−12.1%** | −4.8% | −4.0% | 29% |
| `mistral` | **−7.8%** | +3.5% | +4.2% | 72% |

The `%worse` column counts payloads where RAIF costs *strictly more* (29% on
cl100k); a further ~8% tie, so RAIF is worse-or-even on ~37% — small flat or
key-heavy objects with little to save. On Mistral the per-payload median is
positive (RAIF costs more on the typical small payload) while the aggregate is
negative (the large tabular payloads dominate the token-weighted total).

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
share keys**. JSON re-emits `"key":` and its quotes on every row; RAIF declares
the columns once (`items::a,b,c`) and writes only the values per row. The wider
the rows and the more of them, the larger the win — which is why structured agent
output (tool-call batches, event logs, telemetry, tables) benefits most, and a
single flat record benefits least.

## Adding to the benchmark

By design, both axes extend with a one-line change:

- **A tokenizer** → add an entry to `TOKENIZERS` in `bench.py` (`tiktoken` id or
  any Hugging Face model id). It loads lazily; if a dependency or download is
  missing, that column is skipped, not fatal.
- **A test case** → add `{ "name", "group", "value" }` to `cases.json`. Use
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
