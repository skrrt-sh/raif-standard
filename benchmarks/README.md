# RAIF token-cost benchmark

How many fewer tokens does RAIF cost than the equivalent JSON, and does that hold
across model tokenizers? This folder is the reproducible answer.

Dependencies are declared inline (PEP 723); `uv run` resolves them — no venv, no
install step.

```sh
uv run bench.py                              # cases.json, every tokenizer it can load
uv run bench.py --holdout ../path/eval.jsonl # also a natural-distribution corpus
uv run bench.py --markdown                   # emit the tables below
```

RAIF↔JSON is a **lossless** round-trip (`decode(encode(x)) === x`), so this is a
pure serialization-cost comparison on identical data — no information is traded
for the smaller token count.

## TL;DR

- **~14% fewer tokens on a balanced corpus** — the blended, real-world figure.
  Robust across tokenizers (−12% to −16% on cl100k / o200k / Llama / Qwen).
- **The 14% is a token-weighted aggregate** (total tokens saved over a workload).
  Per *payload* the median is lower (~12%), because tiny objects have little to
  save and weight the same as a big one — but tokens are billed in aggregate.
- **25–37% on tabular / repetitive data**, and up to **~70%** on degenerate
  wide-and-repetitive structures. This is where the savings concentrate: JSON
  repeats every key on every row; RAIF writes the keys once.
- **Tokenizer matters.** OpenAI (cl100k/o200k) and Llama tokenize JSON
  punctuation inefficiently, so RAIF wins most there. Mistral's tokenizer packs
  JSON much better, so the win shrinks to ~5–8%. We report all of them.

## Where the number comes from

`bench.py` reports two percentages, because they answer different questions:

| metric | definition | use |
|---|---|---|
| **aggregate** | `(Σ json_tokens − Σ raif_tokens) / Σ json_tokens` | the billing-relevant figure: total tokens saved over a workload |
| **per-case** | mean/median of each payload's own savings | shows the spread; a tiny flat object counts as much as a 1000-token table |

The aggregate is **sensitive to corpus mix** — a few large payloads dominate a
token-weighted sum. So we never blend a curated corpus with extreme cases into
one headline; results are reported **per group**.

## Results

### 1. Balanced corpus (18 shapes) — the headline

One representative payload per RAIF shape (`cases.json`, group `corpus`). This is
the number quoted in the root README.

| tokenizer | models | aggregate | per-case median | best case |
|---|---|---:|---:|---:|
| `cl100k` | GPT-3.5 / GPT-4 | **−14.4%** | −12.0% | −50.0% |
| `o200k` | GPT-4o / 4.1 / o-series | **−15.9%** | −13.4% | −53.3% |
| `llama3` | Llama 3.x | **−14.1%** | −11.5% | −46.7% |
| `qwen2.5` | Qwen 2.5 | **−12.3%** | −11.3% | −50.0% |
| `mistral` | Mistral 7B v0.3 | **−5.4%** | −1.8% | −40.0% |

### 2. Natural distribution (2,500 held-out payloads)

The real shape mix the fine-tuned models emit (`--holdout` over the `raif-lora`
eval set). The aggregate matches the curated corpus — ~14% is not a
cherry-picked corpus artifact.

| tokenizer | aggregate | per-case mean | per-case median | % of payloads RAIF is *worse* |
|---|---:|---:|---:|---:|
| `cl100k` | **−14.0%** | −5.5% | −4.3% | 29% |
| `o200k` | **−14.9%** | −6.6% | −6.3% | 27% |
| `llama3` | **−13.9%** | −5.5% | −4.2% | 29% |
| `qwen2.5` | **−12.1%** | −4.8% | −4.0% | 29% |
| `mistral` | **−7.7%** | +3.3% | +4.2% | 72% |

Note the honest tail: on ~29% of individual payloads (small/flat objects, and
key-heavy ones) RAIF ties or costs slightly *more* — but those payloads are tiny,
so the aggregate stays firmly negative. On Mistral's tokenizer the per-payload
median actually flips positive; RAIF still wins in aggregate because the large
tabular payloads dominate the total.

### 3. Where the 35–70% comes from (repetitive structures)

Per-case savings (cl100k) on the extreme groups in `cases.json`:

| case | shape | JSON tok | RAIF tok | savings |
|---|---|---:|---:|---:|
| `price_book_30x6` | 30 rows × 6 cols | 874 | 642 | **−26%** |
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
- **A test case** → add `{ "name", "group", "value" }` to `cases.json`. Group it
  with `corpus` (balanced), `repetitive`, `degenerate`, or `floor` so it lands in
  the right table.

## Relationship to the TypeScript bench

The **RAIF-vs-other-formats** comparison (TOON, YAML) lives in
[`../packages/js/bench/compare_formats.ts`](../packages/js/bench/compare_formats.ts)
because TOON only has a working encoder in JavaScript (the PyPI ports are stubs).
That bench covers cl100k / o200k. This Python bench owns the **multi-tokenizer**
RAIF-vs-JSON story, because the tokenizers (`tiktoken` + `transformers`) live in
Python. The RAIF encoder is identical across both (`raif.encode` in Python is
byte-for-byte the canonical TS `encode`, verified on the corpus).
