# RAIF — Repairable AI Interchange Format

![spec](https://img.shields.io/badge/spec-v0.4.2-blue)
![tests](https://img.shields.io/badge/tests-153%20passing-brightgreen)
![runtime](https://img.shields.io/badge/Bun-TypeScript-black)
![tokens](https://img.shields.io/badge/tokens-14%25%20fewer%20vs%20JSON-success)

A wire format for the JSON object an LLM emits for a tool call. It round-trips
losslessly to JSON, **repairs its own syntax errors**, and costs **~14% fewer
tokens** than JSON. JSON assumes a deterministic writer; RAIF assumes the writer
is a model and the reader is an interpreter that can repair, validate, and
canonicalize.

```ts
import { encode, decode } from "raif";

encode({ user: { name: "Ada", email: "ada@x.io" }, active: true });
// active=true
// user={email=ada@x.io,name=Ada}

decode(raif).value;   // → the exact JSON object back
```

## Features

| | |
|---|---|
| **Self-healing decode** | Auto-fixes markdown fences, mode markers, and slipped `:`→`=` separators; reports every repair; refuses ambiguous ones. Never rewrites values. |
| **Truncation recovery** | `decodeLenient` returns the intact leaves of a cut-off stream + a per-leaf error list. **47%** leaf recovery vs 41% for JSON+jsonrepair. |
| **Fewer tokens** | −12% to −14% vs minified JSON, on both the encoder bench and real model output (cl100k + Llama-3.2 tokenizers). |
| **Lossless round-trip** | `decode(encode(x)) === x`, canonical UTF-8 sort, idempotent — proven under a 5,000-seed fuzz test. |
| **Schema-typed decode** | Optional schema pins types: `"null"` under a string field stays the string `"null"`. The literal-string fidelity trap is gone by construction. |

```ts
decode("```\nactive=true\nuser.name: Ada\n```");
// ok: true, repairs: [markdown_stripped, separator_coerced]

decodeLenient("<raif>\ncity=Oslo\nlat");   // stream cut off
// { value: { city: "Oslo" }, truncated: true, errors: [{ line: 2, … }] }
```

## API

```ts
encode(obj, opts?)            // JSON object → RAIF
decode(raif, schema?)         // → { ok, value, repairs }   (repairs, then parses)
decodeLenient(raif, schema?)  // → { value, errors, truncated, repairs }   (never throws)
fix(raif, schema?)            // → canonical RAIF
validate(raif, schema?)       // read-only canonicality check
```

## Quick start

```sh
cd prototype && bun install
bun check        # round-trip across the corpus
bun test         # 153 property tests
bun bench        # token comparison vs JSON
```

## Scope

Single JSON objects, LLM output only. Not a general interchange format, not
compression, not a schema language, not an LLM-*input* format (that's TOON).

## Layout

```
docs/raif_v0.3_spec.md   spec        docs/adr/0001…0019   design decisions
prototype/src/raif.ts    encoder + decoder (pure, dependency-light)
CONTEXT.md   glossary (read first)   HANDOFF.md   full state + findings
```

The Llama-3.2-3B fine-tune lives in the sibling repo
[**raif-lora**](https://github.com/skrrt-sh/raif-lora).
