#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "raif-format",   # canonical RAIF encoder/decoder (import: raif)
#   "tiktoken",      # OpenAI vocabularies: cl100k, o200k
#   "transformers",  # any open-model tokenizer: Llama, Qwen, Mistral, …
# ]
# ///
"""RAIF vs JSON token cost — across tokenizers, across payload shapes.

Multi-tokenizer half of the benchmark. The RAIF-vs-TOON/YAML *format* comparison
lives in the TypeScript bench (`packages/js/bench/compare_formats.ts`) because
TOON only has a working encoder in JS.

Why Python: the tokenizers are here. `tiktoken` covers the OpenAI vocabularies
(cl100k, o200k); `transformers.AutoTokenizer` covers essentially every open
model (Llama, Qwen, Mistral, Gemma, …) with a one-line `from_pretrained`. Adding
a tokenizer later = one entry in TOKENIZERS. Adding a test case = one entry in
cases.json. The RAIF encoder used here (`raif.encode` from the published
`raif-format` package) is byte-identical to the canonical TS encoder.

Two ways the percentage is reported, because they answer different questions:
  - aggregate  = (sum JSON tokens - sum RAIF tokens) / sum JSON tokens.
                 The real-world figure: total tokens saved over a workload.
                 This is the ~14% headline.
  - per-case   = the mean/median of each payload's individual savings.
                 Lower, because it weights a tiny flat object the same as a
                 1000-token table. Useful for seeing the spread, not for billing.

Dependencies are declared inline (PEP 723); `uv run` resolves them, no venv to
manage.

Usage:
    uv run bench.py                          # cases.json + bundled holdout, all tokenizers
    uv run bench.py --no-holdout             # curated cases only (skip the 2.5k holdout)
    uv run bench.py --holdout PATH.jsonl     # use a different RAIF .jsonl corpus
    uv run bench.py --markdown               # emit the README tables
"""
from __future__ import annotations

import argparse
import json
import statistics as st
from pathlib import Path

import raif

HERE = Path(__file__).resolve().parent


# ── Tokenizers ──────────────────────────────────────────────────────────────
# Add a tokenizer by adding one entry. `kind` selects the loader; everything is
# lazy + optional, so a missing dependency (or no network for an HF download)
# skips that column instead of failing the run.
TOKENIZERS: list[dict] = [
    {"label": "cl100k",   "kind": "tiktoken", "id": "cl100k_base", "note": "GPT-3.5 / GPT-4"},
    {"label": "o200k",    "kind": "tiktoken", "id": "o200k_base",  "note": "GPT-4o / 4.1 / o-series"},
    {"label": "llama3",   "kind": "hf", "id": "mlx-community/Llama-3.2-3B-Instruct-bf16", "note": "Llama 3.x"},
    {"label": "qwen2.5",  "kind": "hf", "id": "mlx-community/Qwen2.5-0.5B-Instruct-bf16", "note": "Qwen 2.5"},
    {"label": "mistral",  "kind": "hf", "id": "mistralai/Mistral-7B-Instruct-v0.3",      "note": "Mistral 7B v0.3"},
]


def load_tokenizers(selected: set[str] | None) -> list[tuple[str, str, callable]]:
    """Return [(label, note, encode_len)] for every tokenizer that loads.
    Skips (with a warning) any that need an uninstalled dep or a gated download."""
    out: list[tuple[str, str, callable]] = []
    for t in TOKENIZERS:
        if selected and t["label"] not in selected:
            continue
        try:
            if t["kind"] == "tiktoken":
                import tiktoken
                enc = tiktoken.get_encoding(t["id"])
                fn = lambda s, enc=enc: len(enc.encode(s))
            else:
                from transformers import AutoTokenizer
                tok = AutoTokenizer.from_pretrained(t["id"])
                # add_special_tokens=False: measure payload tokens only, not the
                # model's BOS/EOS wrapper (which is identical regardless of format
                # and would dilute the ratio). Keeps HF consistent with tiktoken,
                # whose .encode() adds no special tokens.
                fn = lambda s, tok=tok: len(tok.encode(s, add_special_tokens=False))
            fn("warmup")
            out.append((t["label"], t["note"], fn))
        except Exception as e:  # noqa: BLE001 — any load failure → skip the column
            print(f"  · skipping {t['label']} ({type(e).__name__}: {str(e)[:60]})")
    return out


# ── Measurement ─────────────────────────────────────────────────────────────
def minified_json(value) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def pairs_from_cases(path: Path) -> list[tuple[str, str, str, str]]:
    """[(name, group, json_str, raif_str)] from a cases.json (list of {name,group,value})."""
    cases = json.loads(path.read_text())
    seen: set[str] = set()
    for i, c in enumerate(cases):
        missing = {"name", "group", "value"} - c.keys()
        if missing:
            raise SystemExit(f"cases.json[{i}]: missing required key(s) {missing}")
        if c["name"] in seen:
            raise SystemExit(f"cases.json[{i}]: duplicate name {c['name']!r}")
        seen.add(c["name"])
    return [(c["name"], c["group"], minified_json(c["value"]), raif.encode(c["value"]))
            for c in cases]


def pairs_from_jsonl(path: Path) -> list[tuple[str, str, str, str]]:
    """[(name, group, json_str, raif_str)] from a RAIF training/eval .jsonl whose
    last message is the gold RAIF — the real distribution the model emits."""
    out = []
    dropped = 0
    for line in path.open():
        if not line.strip():
            continue
        ex = json.loads(line)
        gold = ex["messages"][-1]["content"]
        d = raif.decode(gold)
        if not d.get("ok"):
            dropped += 1  # gold RAIF that won't round-trip — excluded, but counted
            continue
        shape = ex.get("meta", {}).get("shape", "")
        out.append((shape or "?", shape, minified_json(d["value"]), gold))
    if dropped:
        print(f"  · WARNING: {dropped} holdout row(s) failed to decode and were "
              f"excluded ({len(out)} kept) — the denominator is smaller than the file")
    return out


def savings(pairs, encode_len) -> dict:
    """aggregate + per-case stats for one tokenizer over a list of (…, json, raif)."""
    tj = tr = 0
    per = []
    for *_meta, j, r in pairs:
        a, b = encode_len(j), encode_len(r)
        tj += a
        tr += b
        if a:
            per.append(100 * (a - b) / a)
    per.sort()
    return {
        "aggregate": 100 * (tj - tr) / tj if tj else 0.0,
        "mean": st.mean(per) if per else 0.0,
        "median": st.median(per) if per else 0.0,
        "max": max(per) if per else 0.0,
        "min": min(per) if per else 0.0,
        "neg_share": 100 * sum(p < 0 for p in per) / len(per) if per else 0.0,
    }


# ── Reporting ───────────────────────────────────────────────────────────────
def groups_of(pairs) -> list[str]:
    """Unique group labels in first-seen order."""
    seen: list[str] = []
    for _name, group, _j, _r in pairs:
        if group not in seen:
            seen.append(group)
    return seen


def print_corpus(pairs, toks) -> None:
    print(f"\n{'='*78}\nRAIF vs minified JSON — token savings (higher = RAIF cheaper)")
    print(f"corpus: {len(pairs)} cases across groups {groups_of(pairs)}")
    print("NOTE: the aggregate is token-weighted, so it is sensitive to corpus mix.")
    print("      A few huge payloads dominate it — that's why we report per group.")
    # per-group, per-tokenizer aggregate — never blend curated + extreme into one number
    for group in groups_of(pairs):
        gp = [p for p in pairs if p[1] == group]
        print(f"\n── group: {group}  ({len(gp)} cases) ──")
        print(f"{'tokenizer':10} {'aggregate':>10} {'mean':>7} {'median':>7} {'max':>7} {'%worse':>7}")
        for label, _note, fn in toks:
            s = savings(gp, fn)
            print(f"{label:10} {s['aggregate']:9.1f}% {s['mean']:6.1f}% "
                  f"{s['median']:6.1f}% {s['max']:6.1f}% {s['neg_share']:6.0f}%")
    # per-case detail on the first tokenizer (usually cl100k)
    if toks:
        label, _, fn = toks[0]
        print(f"\nper-case ({label}):")
        rows = []
        for name, group, j, r in pairs:
            a, b = fn(j), fn(r)
            rows.append((100 * (a - b) / a if a else 0, name, group, a, b))
        for pct, name, group, a, b in sorted(rows):
            print(f"  {pct:+6.1f}%  {name:30} {group:11} json={a:>5} raif={b:>5}")


def emit_markdown(pairs, toks, group: str = "corpus") -> None:
    """The headline cross-tokenizer table, on the balanced corpus only (not the
    extreme/degenerate cases, which would inflate a token-weighted aggregate)."""
    gp = [p for p in pairs if p[1] == group]
    print(f"\n<!-- markdown: group={group}, {len(gp)} cases -->")
    print("| tokenizer | models | aggregate | per-case median | best case |")
    print("|---|---|---:|---:|---:|")
    for label, note, fn in toks:
        s = savings(gp, fn)
        print(f"| `{label}` | {note} | **−{s['aggregate']:.1f}%** | −{s['median']:.1f}% | −{s['max']:.1f}% |")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cases", default=str(HERE / "cases.json"))
    ap.add_argument("--holdout", default=str(HERE / "holdout.jsonl"),
                    help="RAIF .jsonl, gold RAIF in last message (default: bundled holdout.jsonl)")
    ap.add_argument("--no-holdout", action="store_true", help="skip the holdout run")
    ap.add_argument("--tokenizers", help="comma-separated subset of labels")
    ap.add_argument("--markdown", action="store_true", help="emit README tables")
    args = ap.parse_args()

    selected = set(args.tokenizers.split(",")) if args.tokenizers else None
    print("loading tokenizers…")
    toks = load_tokenizers(selected)
    if not toks:
        raise SystemExit("no tokenizers available; `pip install tiktoken transformers`")

    pairs = pairs_from_cases(Path(args.cases))
    print_corpus(pairs, toks)
    if args.markdown:
        emit_markdown(pairs, toks, "corpus")
        emit_markdown(pairs, toks, "real_world")

    if args.holdout and not args.no_holdout:
        hp = pairs_from_jsonl(Path(args.holdout))
        print(f"\n{'='*78}\nHOLDOUT (natural distribution): {len(hp)} payloads")
        print(f"{'tokenizer':10} {'aggregate':>10} {'mean':>7} {'median':>7} {'max':>7} {'%worse':>7}")
        for label, _, fn in toks:
            s = savings(hp, fn)
            print(f"{label:10} {s['aggregate']:9.1f}% {s['mean']:6.1f}% "
                  f"{s['median']:6.1f}% {s['max']:6.1f}% {s['neg_share']:6.0f}%")
        # per-shape median per tokenizer — surfaces where RAIF loses and how that
        # varies by tokenizer (pairs_from_jsonl tags each row's group with its shape).
        print("\nholdout per-shape median savings (negative = RAIF costs more):")
        print(f"{'shape':22}" + "".join(f"{lbl:>9}" for lbl, _, _ in toks))
        for shape in groups_of(hp):
            sp = [p for p in hp if p[1] == shape]
            cells = "".join(f"{savings(sp, fn)['median']:+8.1f}%" for _lbl, _n, fn in toks)
            print(f"{shape:22}{cells}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
