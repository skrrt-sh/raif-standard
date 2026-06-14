# raif-format (Python)

Pure-Python implementation of **RAIF** — a token-efficient, repair-tolerant layer
for the JSON language models produce: structured outputs, strict objects, JSON
mode, tool arguments. Stdlib only, no runtime dependencies, fully typed (PEP 561).
Tool calls are one use case, not the point.

This package mirrors the canonical TypeScript reference byte-for-byte; parity is
pinned by a shared conformance corpus.

- Spec & monorepo: <https://github.com/skrrt-sh/raif-standard>
- JavaScript/TypeScript package: `raif-format` on npm

## Install

```sh
pip install raif-format        # or: uv add raif-format
```

Installs the `raif-format` distribution; the import package is `raif`.

## Usage

```python
from raif import encode, decode, decode_lenient, fix, validate, parse_schema

# JSON object -> canonical RAIF (byte-identical to the TS encoder)
encode({"to": "a@b.com", "subject": "hi"})
# 'subject=hi\nto=a@b.com'

# Generation profile (what models are trained to emit)
encode({"items": [{"id": 1}, {"id": 2}]}, {"profile": "generation"})

# RAIF -> JSON (with repair reporting)
decode("a=1\nb=hi")
# {'ok': True, 'value': {'a': 1, 'b': 'hi'}, 'repairs': []}

# Per-leaf recovery — never raises, surfaces truncation
decode_lenient("<raif>\ncity=Oslo\nlat")
# {'value': {'city': 'Oslo'}, 'errors': [...], 'repairs': [...], 'truncated': True}

# Canonicalize (decode -> re-encode); idempotent
fix("```\na=1\n```")
# {'ok': True, 'canonical': 'a=1', 'repairs': [...]}

# Read-only canonicality check
validate("a=1")
# {'ok': True}

# Optional schema-typed decode
schema = parse_schema("priority:n\nnote:s?")
decode("priority=2\nnote=hi", schema)
```

## API

| Function | Returns |
| --- | --- |
| `encode(obj, opts=None)` | `str` (canonical RAIF) |
| `decode(text, schema=None)` | `{"ok", "value"\|"error", "repairs"}` |
| `decode_lenient(text, schema=None)` | `{"value", "errors", "repairs", "truncated"}` |
| `fix(text, schema=None)` | `{"ok", "canonical"\|"error", "repairs"}` |
| `validate(text, schema=None)` | `{"ok"}` or `{"ok": False, "errors"}` |
| `parse_schema(decl)` | `RaifSchema` |

`opts` is `{"profile": "canonical" | "generation", "markers": bool}`.

## The RAIF ecosystem

`raif-format` is the Python codec (installs as `raif-format`, imports as `raif`);
everything else builds on the same format.

- **Spec, ADRs & conformance corpus:** [`raif-standard`](https://github.com/skrrt-sh/raif-standard)
- **JavaScript/TypeScript package, same name:** [`raif-format` on npm](https://www.npmjs.com/package/raif-format)
- **Models that emit RAIF natively** — LoRA fine-tunes that make small/local models output RAIF instead of JSON. Decode their output with this package: `decode(model_output)["value"]`.
  - [`skrrt-sh/raif-llama-3.2-3b-lora`](https://huggingface.co/skrrt-sh/raif-llama-3.2-3b-lora) — clears the v0.5 gate (100% parse / 95% fidelity)
  - [`skrrt-sh/raif-qwen3-4b-lora`](https://huggingface.co/skrrt-sh/raif-qwen3-4b-lora) — agent-grade, runs on ~14 GB VRAM
  - [`skrrt-sh/raif-qwen2.5-0.5b-lora`](https://huggingface.co/skrrt-sh/raif-qwen2.5-0.5b-lora) — a 6×-smaller-base study
  - Training & eval recipe: [`raif-lora`](https://github.com/skrrt-sh/raif-lora)

## License

Apache-2.0
