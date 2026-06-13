# RAIF — Repairable AI Interchange Format

A wire format for the single JSON object an LLM emits for a tool call or
structured output. RAIF is designed for a **probabilistic writer** (the model)
and a **deterministic interpreter**: it round-trips losslessly to JSON, repairs
local syntax errors so one bad leaf doesn't destroy the document, and costs
fewer tokens than JSON across most realistic shapes.

> JSON assumes a deterministic writer. RAIF assumes the writer is a model and
> the reader is a parser that can repair, validate, and canonicalize.

## Why

LLMs emit malformed JSON often enough that production tool-calling needs a
recovery story. RAIF's answer is a format whose grammar is cheap for a model to
produce and whose interpreter can deterministically fix surface damage
(truncation, fence wrappers, separator slips) without ever inventing values.

| Property | Status (v0.4.2) |
|---|---|
| JSON round-trip | Lossless across 18 corpus shapes; deterministic for single JSON objects |
| Token efficiency | **−12% to −14% vs minified JSON** (encoder bench + real model output) |
| Self-healing | Surface (TIER 1) + bounded structural (TIER 2) repairs; refuses ambiguous repairs |
| Truncation recovery | 47% leaf recovery at equal token budget vs 41% for JSON+jsonrepair |
| API | Four pure functions: `encode` / `decode` / `fix` / `validate` |

## Repository layout

```
raif-standard/
├── CONTEXT.md          ← glossary; read this first
├── HANDOFF.md          ← full state, findings, and open questions
├── docs/
│   ├── raif_v0.3_spec.md       ← current spec
│   ├── fine_tune_plan.md       ← the v0.5 LoRA plan (see the raif-lora repo)
│   └── adr/0001…0019           ← architecture decision records
└── prototype/
    └── src/raif.ts             ← encoder + decoder (pure functions; the keepers)
```

The LoRA fine-tune workstream lives in a sibling repo, **raif-lora**, and
expects to be checked out next to this one (`../raif-standard/prototype` is its
canonical decoder for eval).

## Quick start

```sh
cd prototype
bun install
bun check        # round-trip smoke test across the corpus
bun test         # property tests
bun bench        # token comparison vs JSON
bun compare      # RAIF / TOON / YAML / JSON across two tokenizers
```

## Status

v0.4.2 — schema-typed decode + a deterministic generation profile (see
[ADR-0019](./docs/adr/0019-schema-typed-decode-and-generation-profile.md)). The
spec is implemented in `prototype/src/raif.ts`; the design history is in the
ADRs. Start with `CONTEXT.md`, then `HANDOFF.md`.
