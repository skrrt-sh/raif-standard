# RAIF Standard Handoff Spec

## 1. Summary

**RAIF** means **Repairable AI Interchange Format**.

RAIF is a structured-output format designed for probabilistic generators such as LLMs and deterministic interpreters. Its purpose is to replace JSON as the model-facing output format for AI agents, tool calls, and structured data generation, while still compiling back to JSON, CBOR, Protobuf, or typed runtime objects.

Core flow:

```txt
LLM output → RAIF parser → repair/validation → canonical RAIF → JSON/tool args/runtime object
```

RAIF is not intended to replace JSON everywhere. It is intended to solve the specific problem of **LLMs producing fragile structured outputs**.

JSON was designed for deterministic programs. RAIF is designed for probabilistic writers.

---

## 2. Problem

Current structured output mostly relies on JSON, JSON Schema, or provider-native function calling.

JSON has several problems as an LLM output target:

- Quotes, braces, commas, and escaping create many failure points.
- One missing quote or brace can corrupt the whole object.
- Deep nesting increases hallucination and syntax drift risk.
- Long text fields containing JSON, Markdown, code, XML, or quotes are awkward.
- JSON is verbose for repeated tool-call schemas.
- Repair is heuristic because JSON carries little local redundancy.
- Provider-native structured output works well only when the provider/inference runtime supports it.

RAIF addresses this by making every field locally understandable and recoverable.

---

## 3. Design Goals

RAIF must be:

1. **LLM-friendly**  
   Low-entropy, repetitive, simple syntax.

2. **Token-efficient**  
   Especially in schema-position mode for known tool schemas.

3. **Repairable**  
   Local field failures should not destroy the full object.

4. **Schema-first**  
   The interpreter validates output against an external schema.

5. **No escaping by default**  
   Raw text fields should safely contain quotes, braces, Markdown, JSON, XML, and newlines.

6. **Deterministically parsable**  
   The parser must avoid ambiguous recovery whenever possible.

7. **Canonicalizable**  
   Loose generated RAIF should compile into strict canonical RAIF.

8. **Provider-independent**  
   It must work without first-party OpenAI/Anthropic/Gemini support.

9. **Compatible with constrained decoding**  
   RAIF should support grammar-level enforcement in open inference runtimes.

10. **Convertible to JSON**  
   Runtime infrastructure should consume ordinary JSON/typed objects after validation.

---

## 4. Key Concept: Two RAIF Modes

RAIF has two major layers.

### 4.1 RAIF-G: Generation Format

RAIF-G is optimized for LLM generation.

Example:

```txt
<raif>
!raif/0.1 s=email.send m=pos
1:s=client@example.com
2:s=Invoice ready
3:t<<<
Hey, the invoice is ready for review.
>>>
!end
</raif>
```

Properties:

- Easy for the model to emit.
- No checksums required.
- No explicit lengths required.
- Suitable for fine-tuning and prompt-level generation.
- Can be enforced by grammar-constrained decoding.

The model should usually output RAIF-G, not strict RAIF-R.

### 4.2 RAIF-R: Repairable Canonical Format

RAIF-R is optimized for storage, transport, audit, and deterministic recovery.

Example:

```txt
!raif/0.1 s=email.send m=pos id=7f2a h=41
1:s:17=client@example.com;91
2:s:12=Invoice ready;3c
3:t:38
Hey, the invoice is ready for review.
;a8
!end;d4
```

Properties:

- Includes field lengths.
- Includes field checksums.
- Includes object checksum.
- Canonical field order.
- Interpreter-generated, not model-generated.
- Used for durable transport and replay.

Recommended pipeline:

```txt
LLM emits RAIF-G
→ parser validates/repairs
→ canonicalizer emits RAIF-R
→ runtime converts to JSON/tool args
```

---

## 5. Core Syntax

### 5.1 RAIF-G Positional Field

```txt
<position>:<type>=<value>
```

Example:

```txt
1:s=client@example.com
2:i=5000
```

### 5.2 RAIF-G Multiline Text Field

```txt
<position>:t<<<
<raw text>
>>>
```

Example:

```txt
3:t<<<
This can contain "quotes", {braces}, commas,
Markdown, JSON, XML, and newlines.
>>>
```

### 5.3 RAIF-R Canonical Field

Single-line value:

```txt
<position>:<type>:<length>=<value>;<checksum>
```

Multiline value:

```txt
<position>:<type>:<length>
<raw value>
;<checksum>
```

Example:

```txt
1:s:17=client@example.com;91
3:t:38
Hey, the invoice is ready for review.
;a8
```

### 5.4 Header

RAIF-G:

```txt
!raif/0.1 s=<schema-id> m=<mode>
```

RAIF-R:

```txt
!raif/0.1 s=<schema-id> m=<mode> id=<short-id> h=<header-checksum>
```

### 5.5 End Marker

RAIF-G:

```txt
!end
```

RAIF-R:

```txt
!end;<object-checksum>
```

### 5.6 Optional Envelope Tags

Envelope tags help locate the structured block in messy model output:

```txt
<raif>
...
</raif>
```

Future fine-tuned models may use special tokens:

```txt
<|raif_start|>
...
<|raif_end|>
```

For MVP, plain textual tags are sufficient.

---

## 6. Type System

Keep the type system minimal.

| Code | Meaning |
|---|---|
| `s` | string |
| `t` | multiline text |
| `i` | integer |
| `n` | decimal number |
| `b` | boolean |
| `e` | enum |
| `u` | URI/URL |
| `d` | date/datetime |
| `x` | opaque ID |
| `z` | null |
| `l` | list |
| `o` | object |
| `r` | reference |

For the first MVP, implement:

```txt
s, t, i, n, b, e, z
```

Add complex types later.

---

## 7. RAIF Modes

### 7.1 Positional Mode: `m=pos`

Used when a schema is known.

Example:

```txt
<raif>
!raif/0.1 s=email.send m=pos
1:s=client@example.com
2:s=Invoice ready
3:t<<<
Hey, the invoice is ready.
>>>
!end
</raif>
```

Schema maps positions to fields:

```ts
{
  id: "email.send",
  mode: "pos",
  fields: [
    { pos: 1, key: "to", type: "s", required: true },
    { pos: 2, key: "subject", type: "s", required: true },
    { pos: 3, key: "body", type: "t", required: true }
  ]
}
```

Advantages:

- Low token count.
- Model cannot hallucinate field names.
- Excellent for tool calls and agents.

### 7.2 Named Mode: `m=named`

Used for debugging or schema-light cases.

Example:

```txt
<raif>
!raif/0.1 m=named
to:s=client@example.com
subject:s=Invoice ready
body:t<<<
Hey, the invoice is ready.
>>>
!end
</raif>
```

Advantages:

- Human-readable.
- Easier debugging.
- More verbose.

### 7.3 Path Mode: `m=path`

Used for arbitrary JSON round-trip conversion.

Example JSON:

```json
{
  "user": {
    "id": 123,
    "name": "Egor"
  },
  "tags": ["ai", "infra"]
}
```

RAIF path mode:

```txt
<raif>
!raif/0.1 m=path
user.id:i=123
user.name:s=Egor
tags[0]:s=ai
tags[1]:s=infra
!end
</raif>
```

Advantages:

- Deterministic JSON ↔ RAIF conversion.
- Good for building synthetic datasets.
- Avoids nested syntax.
- Each leaf is independently recoverable.

---

## 8. JSON Compatibility Strategy

RAIF should support deterministic conversion:

```txt
JSON → canonical JSON → RAIF-N/path → JSON
```

Canonical JSON rules:

- Sort object keys.
- Preserve array order.
- Normalize strings as UTF-8.
- Normalize numbers.
- Remove insignificant whitespace.
- Preserve `null`, `true`, `false`.

Path mode is the bridge for arbitrary JSON data.

Position mode is the optimized format for known schemas and agent tool calls.

Architecture:

```txt
RAIF path mode teaches the model the general language.
RAIF position mode gives agents the compact execution protocol.
```

---

## 9. Self-Healing Requirements

RAIF repair must be deterministic, bounded, and auditable.

### 9.1 Repairable Issues

The parser may repair:

- Markdown fences around output.
- Extra prose before/after RAIF block.
- Missing `<raif>` wrapper if RAIF header exists.
- Wrong separator in obvious cases.
- Field order changes.
- Missing final newline.
- Minor enum typo if unambiguous.
- Boolean normalization: `yes/no`, `1/0`, `true/false`.
- Number cleanup: commas/spaces when unambiguous.
- Wrong field length in RAIF-R if checksum resolves the boundary.
- Missing checksums in generated RAIF-G, by canonicalizing to RAIF-R.

### 9.2 Non-Repairable Issues

The parser must reject:

- Missing required field with no default.
- Ambiguous enum correction.
- Unknown schema ID.
- Unknown critical field.
- Invalid tool name.
- Multiple checksum-valid candidates.
- Object checksum mismatch in strict execution mode.
- Semantic content that would require guessing.

Critical rule:

```txt
Repair can correct representation errors, but must not invent missing semantic content.
```

Allowed:

```txt
hihg → high
```

only if enum candidates make it unambiguous.

Not allowed:

```txt
missing email → guessed email
```

---

## 10. Parser Pipeline

Recommended parser pipeline:

```txt
raw model output
→ extract RAIF block
→ normalize line endings
→ strip markdown fences/prose wrappers
→ parse header
→ parse fields
→ validate against schema
→ repair representation errors
→ repair deterministic semantic errors
→ canonicalize
→ compute lengths/checksums
→ emit RAIF-R
→ convert to JSON/tool args
```

Parser result:

```ts
type RaifParseResult<T> =
  | {
      ok: true;
      value: T;
      canonical: string;
      repairs: RaifRepair[];
      confidence: number;
    }
  | {
      ok: false;
      errors: RaifError[];
      partial?: Partial<T>;
      canonicalCandidate?: string;
    };
```

Repair record:

```ts
type RaifRepair = {
  field?: string;
  code:
    | "wrapper_stripped"
    | "separator_corrected"
    | "field_reordered"
    | "length_corrected"
    | "enum_corrected"
    | "boolean_normalized"
    | "checksum_inserted"
    | "markdown_stripped";
  before: string;
  after: string;
  confidence: number;
};
```

---

## 11. Checksums

Checksums are primarily interpreter-generated.

The model should not be expected to generate CRCs correctly.

Recommended behavior:

```txt
Model emits RAIF-G without checksums.
Interpreter computes RAIF-R lengths/checksums.
```

Initial checksum choices:

- Field checksum: CRC-8 or CRC-16.
- Object checksum: CRC-16 or xxHash32.
- Header checksum: optional in MVP.

Strict modes:

| Mode | Behavior |
|---|---|
| `loose` | Parse/repair RAIF-G, no checksum required |
| `canonical` | Emit RAIF-R with computed checksums |
| `strict` | Require RAIF-R checksum validity |
| `tool-call` | Reject risky repairs before execution |

---

## 12. Grammar-Level Support

Grammar-level support means the inference engine restricts invalid next tokens during generation.

This is different from tags such as:

```txt
<tool_call.start>
...
<tool_call.end>
```

Tags are an envelope. Grammar-constrained decoding is enforcement.

RAIF should support:

- Prompt-only generation.
- Fine-tuned generation.
- Grammar-constrained generation.
- Provider-native support later.

Targets:

```txt
llama.cpp GBNF
Outlines
Guidance / llguidance
XGrammar
vLLM structured outputs
SGLang structured outputs
```

Important caveat:

Exact length-prefix enforcement is difficult in ordinary context-free grammars. Therefore:

- RAIF-G is grammar-friendly and does not require lengths/checksums.
- RAIF-R is canonicalized after parsing.

This is the correct split.

---

## 13. Fine-Tuning Strategy

A small OSS model can be fine-tuned to prefer RAIF.

Recommended test models:

```txt
Qwen2.5-1.5B-Instruct
Qwen3-1.7B
Gemma 3 1B/4B
Llama 3.2 1B/3B
```

Training method:

```txt
LoRA / QLoRA supervised fine-tuning
```

Synthetic data source:

```txt
arbitrary JSON datasets → deterministic RAIF path conversion
```

Training pairs:

```txt
JSON → RAIF
RAIF → JSON
natural-language task + schema → RAIF-G
corrupted RAIF-G → canonical RAIF-G
```

Important distinction:

JSON → RAIF teaches syntax and round-trip stability.  
Natural-language → RAIF teaches action generation.

For the first experiment, JSON ↔ RAIF alone is acceptable.

---

## 14. Benchmark Requirements

Benchmark RAIF against:

```txt
JSON
compact JSON
OpenAI-style function-call JSON
TOON
YAML
XML/tool tags
CSV/TSV for flat data
TNetstrings
```

Metrics:

```txt
token count
valid parse rate
schema adherence
semantic accuracy
repair success rate
special-character robustness
truncation tolerance
latency
instruction overhead
wrong-field hallucination rate
```

Most important benchmark scenarios:

1. Short flat tool calls.
2. Long multiline text payloads.
3. Embedded JSON inside strings.
4. Embedded Markdown/code blocks.
5. Special characters and Unicode.
6. Arrays of objects.
7. Nested objects.
8. Corrupted outputs.
9. Truncated outputs.
10. Small local models.

Key hypothesis:

```txt
RAIF should outperform JSON on repairability and special-character robustness, and outperform TOON for model-generated tool-call payloads where self-healing matters.
```

---

## 15. Comparison with TOON

### 15.1 What TOON Solves

TOON is a token-oriented data serialization format designed primarily for LLM prompts. It is especially strong for compact representation of uniform arrays and tabular JSON-like data.

TOON is useful when:

- You feed structured data into an LLM.
- The data contains repeated keys.
- Arrays are uniform.
- Human readability still matters.
- Token reduction is the main goal.

### 15.2 TOON Weaknesses for RAIF Use Case

TOON is weaker when:

- The payload is deeply nested.
- Structures are irregular.
- Output must be self-healing.
- Field-local recovery matters.
- Special-character raw text is common.
- The target is tool execution, not prompt compression.
- You need deterministic repair logs.
- You need checksums and canonical recovery.

TOON is mainly an input/prompt compression format.

RAIF is an output/action protocol.

### 15.3 Comparison Table

| Feature | JSON | TOON | RAIF |
|---|---:|---:|---:|
| General ecosystem support | Excellent | Low | Low initially |
| LLM prompt compactness | Medium | High | Medium/high |
| Tool-call output compactness | Medium | Medium | High in pos mode |
| Special-character safety | Weak | Medium | Strong |
| No escaping by default | No | Partial | Yes for text |
| Self-healing design | No | No | Yes |
| Field-local recovery | Weak | Weak/medium | Strong |
| Checksums | No | No | Yes in RAIF-R |
| Schema-position mode | No | No | Yes |
| Arbitrary JSON bridge | Native | Yes-ish | Yes via path mode |
| Grammar-constrained support | Yes | Possible | Planned |
| Best use case | APIs | LLM input compression | Agent/tool output |

### 15.4 Positioning

Do not position RAIF as “TOON but better.”

Use this distinction:

```txt
TOON compresses structured data for LLM input.
RAIF makes structured LLM output repairable and executable.
```

---

## 16. Proposed Package Structure

TypeScript packages:

```txt
@raif/core
@raif/schema
@raif/zod
@raif/json
@raif/repair
@raif/grammar
@raif/bench
```

### 16.1 `@raif/core`

- RAIF-G parser.
- RAIF-R parser.
- Canonicalizer.
- Serializer.
- Type definitions.

### 16.2 `@raif/schema`

- Internal schema representation.
- Validation.
- Position mapping.
- Mode support.

### 16.3 `@raif/zod`

- Zod → RAIF schema.
- RAIF schema → Zod if possible.

### 16.4 `@raif/json`

- JSON → canonical JSON.
- Canonical JSON → RAIF path mode.
- RAIF path mode → JSON.

### 16.5 `@raif/repair`

- Repair strategies.
- Confidence scoring.
- Repair logs.
- Strictness policies.

### 16.6 `@raif/grammar`

- GBNF generator.
- Outlines adapter.
- llguidance adapter.
- XGrammar/vLLM adapter.

### 16.7 `@raif/bench`

- Benchmark dataset generation.
- JSON/TOON/YAML/RAIF comparisons.
- Special-character stress tests.
- Small-model evaluation.

---

## 17. Integration Roadmap

### Stage 0: Spec

Deliverables:

- RAIF-G syntax.
- RAIF-R syntax.
- Type system.
- Parser rules.
- Repair rules.
- Canonicalization rules.
- JSON round-trip rules.

### Stage 1: Core TypeScript Library

Deliverables:

- `parseRaifG`
- `parseRaifR`
- `canonicalizeRaif`
- `toJson`
- `fromJson`
- `repairRaif`
- basic schema validation

Success criterion:

```txt
JSON → RAIF path → JSON round-trip works deterministically.
```

### Stage 2: Zod/JSON Schema Bridge

Deliverables:

- Zod → RAIF schema.
- JSON Schema → RAIF schema.
- Position-mode schema compiler.

Success criterion:

```txt
Known tool schema compiles to compact RAIF positional mode.
```

### Stage 3: Benchmarks

Deliverables:

- Token-count benchmark.
- Parse-success benchmark.
- Corruption/repair benchmark.
- Special-character benchmark.
- JSON/TOON/YAML comparison.

Success criterion:

```txt
RAIF shows measurable advantage in repairability and special-character robustness.
```

### Stage 4: Grammar-Constrained Decoding

Deliverables:

- RAIF-G grammar.
- llama.cpp GBNF support.
- Outlines/llguidance/XGrammar adapters.

Success criterion:

```txt
Small OSS model emits syntactically valid RAIF-G under grammar constraints.
```

### Stage 5: Fine-Tuning Experiment

Deliverables:

- Synthetic JSON ↔ RAIF dataset generator.
- LoRA/QLoRA script.
- Small OSS model adapter.
- Evaluation report.

Success criterion:

```txt
Fine-tuned model emits RAIF-G with higher reliability or fewer tokens than JSON on target benchmarks.
```

### Stage 6: Agent Integration

Deliverables:

- MCP-style tool-call adapter.
- Agent runtime example.
- Tool execution safety modes.
- Repair audit logs.

Success criterion:

```txt
Agent can emit RAIF, parser validates/canonicalizes, runtime executes typed tool call.
```

### Stage 7: Standardization Proposal

Deliverables:

- Public spec.
- Reference implementation.
- Benchmarks.
- Examples.
- Compatibility matrix.

Success criterion:

```txt
RAIF is understandable and implementable by external agents/tooling.
```

---

## 18. Open Design Questions

1. Should RAIF-R use byte length or Unicode codepoint length?
   - Recommendation: byte length in UTF-8 for canonical transport.
   - RAIF-G does not need length.

2. Which checksum should be default?
   - Recommendation: CRC-8 for MVP fields, CRC-16/xxHash32 for objects.

3. Should multiline text use `<<< >>>`?
   - Good for model generation.
   - Must define escaping behavior if payload itself contains `>>>`.
   - Alternative: model emits RAIF-G text block, canonical RAIF-R uses length prefix, so delimiter collision is repairable.

4. Should nested objects exist natively?
   - Recommendation: avoid for MVP.
   - Use path mode for arbitrary JSON and position mode for schemas.

5. Should the model generate checksums?
   - Recommendation: no.
   - Interpreter generates checksums during canonicalization.

6. Should RAIF compete with provider-native structured outputs?
   - Not initially.
   - Initial wedge is open/local agent infrastructure and provider-independent repair.

---

## 19. Minimal MVP Definition

The smallest useful RAIF MVP:

```txt
RAIF-G:
- <raif> envelope
- !raif/0.1 header
- m=path and m=pos
- scalar fields: s, t, i, n, b, z
- multiline text blocks
- !end marker

RAIF-R:
- length-prefixed fields
- field checksums
- object checksum
- canonical field ordering

Library:
- JSON ↔ RAIF path round-trip
- Zod → RAIF pos schema
- RAIF-G parse/repair
- RAIF-R canonicalization
- JSON output
```

First demo:

```txt
Take arbitrary JSON
→ convert to RAIF path
→ convert back to JSON
→ prove equality
→ corrupt RAIF slightly
→ repair/canonicalize
→ prove equality again
```

Second demo:

```txt
Take tool schema
→ generate RAIF pos output
→ parse/canonicalize
→ execute typed mock tool call
```

---

## 20. Final Positioning

RAIF should be described as:

```txt
A repairable, schema-first structured-output protocol for probabilistic generators.
```

Longer version:

```txt
RAIF is a text-based interchange format for AI-generated structured outputs. It separates easy-to-generate model syntax from strict canonical transport syntax, allowing LLMs to emit simple low-entropy structures while interpreters repair, validate, canonicalize, and convert them into JSON or typed tool-call arguments.
```

Differentiator:

```txt
JSON assumes a deterministic writer.
RAIF assumes a probabilistic writer and a deterministic repair interpreter.
```

Core product thesis:

```txt
As agents become more autonomous, structured outputs need protocol-level repairability, not just stricter prompts.
```
