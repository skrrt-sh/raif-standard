# Schema-as-parity: the design principle for ambiguity resolution

Some v0.3 wire forms are **fundamentally ambiguous without out-of-band information**. The bytes alone do not determine the correct decode. Three running examples:

```
placeholder=null       # null literal, or string "null" the model forgot to wrap?
user.email=foo         # nested {user:{email:"foo"}}, or flat key "user.email"?
version_tag=true       # boolean true, or string "true"?
```

Each of these has two valid grammatical interpretations. No amount of byte-level analysis (parser cleverness, Reed-Solomon parity, statistical priors over the input distribution) can distinguish them — they are *information-theoretically* indistinguishable.

There are exactly three responses to information-theoretic ambiguity:

1. **Reject** — return a validation error, ask the caller to disambiguate.
2. **Default** — pick one interpretation by convention; the other interpretation requires an explicit marker (which the model must remember to emit).
3. **Consult parity** — use out-of-band information to break the tie.

v0.3 chose option 2 (default-to-literal, wrap to opt out). The wrap rule is sound; the failure mode is that the *model forgets to wrap*. Track 1 ([ADR-0015](./0015-deterministic-decoder-repair-tier.md)) covers everything decidable from bytes alone, but it cannot help with the residual ambiguous cases above — they are not deterministically decidable.

For the residual, RAIF v0.4+ adopts option 3 as the design principle for advanced callers, called **schema-as-parity**.

## Decision

When the caller supplies a schema, the decoder may use it as the parity that resolves ambiguous wire forms. The schema is **never required** — RAIF remains a general-purpose JSON-compatible standard that decodes without one. Schema-aware repair is strictly additive: it only ever recovers more inputs, never rejects inputs that schema-free decode would accept.

The principle:

> The schema is the parity. In schema-free mode, the decoder applies only deterministic repairs whose correct interpretation is decidable from bytes alone (TIER 1 + TIER 2). In schema-aware mode, the decoder may additionally repair forms that are ambiguous from bytes alone when the schema names exactly one valid interpretation.

This keeps the "general-purpose standard" framing intact while letting schema-aware callers (which includes essentially all tool-call sites) recover more of the model's mistakes deterministically.

## What the schema disambiguates

Concrete examples of schema-aware repairs that are forbidden schema-free:

| wire | schema says | schema-free decode | schema-aware repair |
|---|---|---|---|
| `placeholder=null` | `placeholder` is string | null literal | string `"null"` |
| `version_tag=true` | `version_tag` is string | boolean true | string `"true"` |
| `user.email=foo` | `user.email` is a leaf key (no nested `user`) | `{user:{email:"foo"}}` | `{"user.email":"foo"}` |
| `count=42` | `count` is string | number 42 | string `"42"` |
| `flag=1` | `flag` is boolean | number 1 | boolean true |
| `items=[1,2,3]` (string-typed) | `items` is string | parse-fails or array | string `"[1,2,3]"` |

The decoder *never invents bytes*: each repair maps the literal value bytes to the schema-declared type via a deterministic coercion table. If the bytes can't be coerced to the schema's declared type by the table, the schema-aware repair refuses and the validation error surfaces.

## What it does NOT do

- **Does not relax syntax errors.** A truly malformed leaf (`mixe===d=foo`) is still a parse error; the schema can't help.
- **Does not invent missing required fields.** A schema-required field absent from the wire is a validation error, not a repair candidate. The decoder will not fabricate values.
- **Does not type-coerce silently for valid-on-both-sides decodes.** If the wire says `count=42` and the schema says `count` is a number, no repair fires — the decode is already correct.
- **Does not depend on a particular schema format.** The internal representation is a typed shape (a `Schema` object); adapters from JSON Schema, Zod, TypeScript types, and a RAIF-native schema declaration will be added incrementally. v0.4 specifies the principle and the internal type; the public adapters land in v0.5 alongside fine-tune work ([ADR-0017](./0017-fine-tune-integration-philosophy.md)).

## API shape

The `fix` and `decode` functions ([ADR-0014](./0014-four-function-api-fix-as-canonicalizing-repair.md)) gain an optional schema parameter:

```ts
fix(raif: string, schema?: Schema): FixResult
decode(raif: string, schema?: Schema): DecodeResult
```

`Schema` is an internal type for v0.4 (not exposed via a public adapter yet). When omitted, both functions operate schema-free (current behavior). When supplied, they apply schema-aware repairs in addition to TIER 1 + TIER 2.

`validate` does **not** take a schema. Validation is about wire-format canonicality, not schema conformance — the two are orthogonal concerns, and a separate `validateAgainstSchema(raif, schema)` (deferred to v0.5) covers the conformance check explicitly.

## Why on-wire ECC was rejected

The alternative — embedding Reed-Solomon-style parity bytes in the wire so the document recovers without a schema — was considered and rejected. Reasons:

1. **It doesn't help with the failures we actually see.** The observed model failures (`placeholder=null` for string null, un-wrapped pathological keys, table-row width mismatch) are *grammar-class* errors, not bit-level corruption. Reed-Solomon corrects bit errors; the bytes here are valid bytes carrying a valid-looking but wrong grammar choice. No parity scheme over the byte sequence can distinguish "model meant null literal" from "model meant string 'null'" because the bytes are identical.
2. **Token cost is too high.** A typical RAIF document is 30–60 tokens. Reed-Solomon parity sized to recover a meaningful fraction of byte loss is 5–25% overhead. That burns directly into the −13% token win that justifies RAIF's existence.
3. **It would lock RAIF to specific runtimes.** ECC at this scale requires runtime support; adding it would constrain RAIF's "works as a string anywhere" property.

If a future use case demands on-wire ECC (e.g., RAIF as a durable archive format with no schema availability and no retry option), it can be added as a layered RAIF-R extension (next to the existing optional CRC-8 audit hash) — opt-in, not the default.

## Consequences

- The `fix` / `decode` signatures gain an optional `schema?: Schema` parameter. v0.3 callers are unaffected (schema-free is the default).
- The implementation grows a `schemaRepair.ts` phase that runs after TIER 2. The phase is a no-op when no schema is supplied.
- v0.5 spec adds a `§14 Schema declaration` section defining the RAIF-native schema syntax for use in prompts and as an internal canonical form for the `Schema` type.
- TIER 1 + TIER 2 + schema-as-parity together cover essentially every observed failure mode in the OpenRouter sweep. The residual after all three is real model errors (e.g., the model emits a value that is wrong by both the wire grammar AND the schema), which is the regime fine-tuning addresses ([ADR-0017](./0017-fine-tune-integration-philosophy.md)).
- The `validate` function stays a wire-format-canonicality check, decoupled from schema conformance. A separate `validateAgainstSchema(raif, schema)` is on the v0.5 backlog.

## Considered alternatives

- **Mandatory schema (RAIF requires a schema to decode).** Rejected — breaks the "general-purpose JSON-compatible standard" framing. Schema-free decode must always work.
- **On-wire ECC (Reed-Solomon over leaves).** Rejected — token-expensive, doesn't address the grammar-class failures we actually see.
- **Per-leaf type sigil that the model must emit on every leaf** (`placeholder:s=null` always, never bare `placeholder=null`). Rejected — heavier wire (loses some of the token win), harder for small models to follow (degrades parse rate further on 1B–8B), and even with the sigil the model can forget to emit it (same root failure mode as today's wrap rule).
- **Tighter encoder defaults — encoder always wraps potentially-ambiguous values; model is trained to match.** Partially in v0.3 already; the gap is that the *model forgets*. Encoder strictness alone doesn't help when the model doesn't follow it. Combined with fine-tuning (ADR-0017) this becomes the v0.5+ model-training strategy.
