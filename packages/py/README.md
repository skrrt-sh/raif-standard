# raif-format (Python)

Pure-Python implementation of **RAIF** — a token-efficient, repair-tolerant
interchange format for LLM input/output. Stdlib only, no runtime dependencies,
fully typed (PEP 561).

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

## License

Apache-2.0
