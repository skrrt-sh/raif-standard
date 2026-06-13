# RAIF Standard v0.3

> v0.3 supersedes v0.2 (`raif_v0.2_spec.md`). Changes are tracked in ADRs 0010 (inline-object form), 0011 (multiline nonce is optional), 0012 (encoder picks the cheapest emission), and 0013 (multi-line array literal). v0.2 is retained for historical reference; the running prototype implements v0.3.

> **Amendments in force ([ADR-0018](./adr/0018-round-trip-hardening.md), 2026-06-13)** — to be folded into the v0.5 spec:
>
> - Wrap rules are decided against the assembled line: values with a block-opener tail (`…=<<<hex`, `…=<{1,2}hex`, `…=[`) wrap; inline/table cells containing `{` or a non-leading `<<<` wrap.
> - The type-tag form `key:s=value` is **canonical** for protected single-line strings when tag-safe (§3.6's shorter-form rule, now implemented). `key=<<<value>>>` remains accepted input.
> - Canonical sort is true UTF-8 byte order (code-point comparison).
> - Multiline nonces are deterministic (content-derived); canonical RAIF is byte-identical run-to-run with no "modulo nonces" caveat.
> - `\r` in values is data and round-trips byte-exactly; only document-wide CRLF and trailing `\r` on structural lines are repaired. The multiline form is triggered by `\n` only.
> - A `null` table cell decodes to JSON null (supersedes ADR-0015 TIER 2-D "key absent"); the encoder may emit null cells.
> - An unterminated array literal or multiline block with no downstream closer-like line is closed at EOF as a recorded repair (supersedes §3.3's hard error); ambiguous closers still refuse.
> - Malformed indices (`a[01]`, `a[1]b`) and double-overflow numbers are errors, not coercions.
> - `decodeLenient` implements §3.1/§11 per-leaf recovery: bad leaves are skipped and reported; everything else decodes.
> - Decoding uses own-property semantics; `__proto__` keys cannot pollute prototypes.
>
> **Amendments in force ([ADR-0019](./adr/0019-schema-typed-decode-and-generation-profile.md), 2026-06-13):**
>
> - **Schema-typed decode**: all four API functions accept an optional schema (plan §3.2 declaration syntax). Types come from the schema, not value shape: bare `null` under `field:s` is the string `"null"`; `n`/`b` must parse or error; bare `null` under `field:s?` is JSON null; the schema wins over a conflicting wire tag; unwrapped pathological keys resolve to declared flat fields (repair `pathological_key_resolved`); required/unknown fields are validated.
> - **Generation profile**: `encode(obj, { profile: "generation" })` — deterministic mode precedence (table → array literal → path; nested objects always path) and truncation-optimal ordering (single-line leaves first, multiline blocks last). The cheapest-mode pick (ADR-0012) is scoped to the canonical profile. Optional `<raif>`/`</raif>` framing makes truncation detectable (`decodeLenient(...).truncated`); markers are recognized only as whole lines at document edges.

## 1. Summary

**RAIF** (Repairable AI Interchange Format) is a wire format for a **single JSON object** emitted by a probabilistic generator (LLM). It replaces JSON as the model-facing output for tool calls and structured generation while round-tripping deterministically to JSON.

Core flow:

```
LLM output  →  RAIF parser  →  repair / validation  →  canonical RAIF-R  →  JSON / tool args
```

RAIF was designed because JSON assumes a deterministic writer. RAIF assumes a probabilistic writer and a deterministic interpreter.

## 2. Scope

### In scope

- One JSON object per RAIF document.
- Deterministic JSON ↔ RAIF round-trip for any object containing strings, numbers, booleans, nulls, arrays of any of these, and nested objects.
- Self-healing parser that repairs **syntax** errors (markdown fences, mode markers, missing newlines, wrong separators, mismatched multiline nonces, leaf order).
- Token efficiency that beats JSON on most object shapes.

### Out of scope

- Top-level arrays (`[1,2,3]`), top-level primitives, multi-document streams, JSON Lines / NDJSON.
- Schema versioning, schema registries, schema evolution. Use protobuf or Avro for cross-time wire compatibility. (See [ADR-0003](./adr/0003-schema-versioning-is-out-of-scope.md).)
- Value-level repair: typo correction, locale normalization, fuzzy boolean matching. (See [ADR-0004](./adr/0004-repair-fixes-syntax-not-values.md).)
- Richer-than-JSON types: no separate int/float, no dates, no URIs. (See [ADR-0006](./adr/0006-value-semantics-inherit-from-json.md).)

---

## 3. Wire format

### 3.1 The leaf

A **leaf** is one line representing one scalar value, one null, one empty-container marker, or one inline-object row.

```
to=user@example.com
priority=2
notify=true
empty_list=[]
nothing=null
row[0]={kind=user,name=alice}
```

Each leaf is independently parseable. A corrupted leaf damages only itself; neighbors survive. The locality unit for inline-object leaves shifts from cell to row.

### 3.2 Default form

A RAIF document is a sequence of leaves separated by `\n`. No per-object header, no terminator marker.

```
to=user@example.com
subject=Invoice ready
body=Hello there
priority=2
notify=true
```

Decodes to:

```json
{
  "to": "user@example.com",
  "subject": "Invoice ready",
  "body": "Hello there",
  "priority": 2,
  "notify": true
}
```

### 3.3 Nesting (path syntax)

Nested objects use dot path:

```
user.id=123
user.name=Egor
user.email=e@example.com
```

Arrays use bracket index:

```
tags[0]=ai
tags[1]=infra
items[0].id=1
items[0].name=foo
items[1].id=2
items[1].name=bar
```

Mixed-type and heterogeneous arrays are supported — each leaf is independently typed:

```
mixed[0]=1
mixed[1]=foo
mixed[2]=true
```

#### Table mode for homogeneous arrays of objects ([ADR-0008](./adr/0008-table-mode-for-homogeneous-arrays.md))

When every element of an array is an object with the same flat key set, the encoder may emit a header + indexed rows instead of repeating the path prefix per leaf:

```
items::id,name,qty
items[0]=1,foo,2
items[1]=2,bar,5
items[2]=3,baz,1
```

The `::` after the array prefix declares the column list (sorted UTF-8 byte order). Each row is one leaf with cells separated by commas; cell wrapping follows [ADR-0007](./adr/0007-value-wrap-rules-are-minimal.md) with `,` added as a wrap trigger.

Encoder eligibility: array has ≥ 2 elements, every element is a flat object with identical keys, every cell is a primitive without newlines or `>>>`, column names are simple identifiers. Otherwise the encoder falls back to path mode or inline-object mode (whichever is shorter — see §3.4 and [ADR-0012](./adr/0012-encoder-picks-cheapest-array-mode.md)).

**Wire order:** any order. Parser reorders during canonicalization. Canonical RAIF-R order is: ascending array indices, then UTF-8 byte order of names within each scope.

**Sparse arrays:** REJECTED. If the source JSON has null elements, the encoder MUST emit them explicitly:

```
arr[0]=a
arr[1]=null
arr[2]=b
```

A document where array indices skip is a validation error.

**Path collision:** `a=1` and `a.b=2` cannot both exist. Validation error.

#### Inline-object mode for non-empty objects ([ADR-0010](./adr/0010-inline-object-form.md))

A non-empty object whose values are all primitives may be emitted as a single inline leaf:

```
data.user={handle=egor,id=7,verified=true}
mixed[0]={kind=user,name=alice}
mixed[1]={kind=group,members=5}
```

- Outer braces `{` … `}` bracket the inline object.
- Inside, comma-separated `key=value` pairs in canonical (UTF-8 byte-order) key order.
- Keys follow the path-key wrap rules plus `,`, `{`, `}` added as wrap triggers.
- Values follow the bare-value rules plus `,` and `}` added as wrap triggers.

Encoder eligibility: every value in the object is a primitive (string, number, boolean, null), no cell string contains `\n` / `\r` / `>>>`, no key contains `<<<` / `>>>` / `\n` / `\r`. Nested objects or arrays inside an inline object are not supported — the encoder falls back to path mode for non-flat structures.

Inline-object mode is never used at the root: the document root must remain path-addressable so per-leaf recovery still applies.

#### Multi-line array literal ([ADR-0013](./adr/0013-multi-line-array-literal.md))

A non-empty array MAY be emitted as a single multi-line literal that shares the array prefix once across all rows:

```
events=[
{type=click,target=button#submit}
{type=view,page=/pricing}
{type=click,target=a.cta}
]

timestamps=[
1715600000
1715600015
1715600030
]
```

- Opener: a leaf whose value after `=` is exactly `[` (the line ends with `=[`).
- Body: each subsequent non-blank line is one element. Blank lines are tolerated as whitespace.
- Closer: a line equal to `]`.
- Elements may be primitives (numbers, booleans, `null`, bare or wrapped strings) or flat inline-object literals (`{k=v,…}`). Nested arrays inside the literal are not allowed; arrays-of-arrays fall back to path mode.

Encoder eligibility: every element is a primitive without `\n`/`\r`, or a flat object that is eligible for the inline-object form.

Encoder also wraps two extra string shapes to avoid grammar collisions:

- A single-line string equal to `[` wraps (`s=<<<[>>>`) so the value isn't read as an array opener.
- A string row equal to `]` inside an array literal wraps (`<<<]>>>`) so it doesn't close the array early.

Repair: an unterminated array literal (no `]` closer before end of document) is a hard error in v0.3; the decoder does not attempt to synthesize a closer.

#### Encoder selection rule ([ADR-0012](./adr/0012-encoder-picks-cheapest-array-mode.md))

For each array and each non-empty nested object the encoder builds every legal candidate (path, table where eligible, inline where eligible, array literal where eligible) and emits the shortest by byte length. Ties resolve by preference order: path > table > inline > literal. The decoder accepts all forms; the choice is encoder-local.

### 3.4 Value forms

#### Bare values (type inferred)

| Literal | Type |
|---|---|
| `42`, `-3.14`, `1e3`, `0` | number (JSON number grammar) |
| `true`, `false` | boolean |
| `null` | null |
| `{key=val[,key=val]*}` | inline object ([ADR-0010](./adr/0010-inline-object-form.md)) |
| `{}` | empty object |
| `[]` | empty array |
| `[` (at end of leaf line, no other chars) | array-literal opener ([ADR-0013](./adr/0013-multi-line-array-literal.md)) |
| Any other bare identifier (no RAIF-significant chars) | string |

Number grammar: `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`. Leading zeros, `NaN`, `Infinity` are rejected — exactly as JSON.

**Parser separator rule:** the leaf separator is the first top-level `=` or `:` (or `::`) outside any `<<<...>>>` range. Once that's found, the value extends to the end of the line (or, for multiline blocks, to the matching nonce closer). So values can freely contain `=`, `,`, `:`, `[`, `]`, `{`, `}` — only the *literal* forms (`null`, `true`, `false`, `[]`, `{}`, JSON numbers, inline-object syntax), leading/trailing whitespace, embedded newlines, a leading `<<<`, or an embedded `>>>` that the bare-slice rule can't unwrap force a wrap.

#### Delimited strings (`<<< ... >>>`)

For string values containing RAIF-significant characters or that would otherwise parse as a literal:

```
greeting=<<<hello, "world"!>>>
weird=<<<has commas, "quotes", {braces}, =equals=, and a 42 number>>>
embedded_close=<<<arrow >>> inside>>>
```

`<<<` and `>>>` each tokenize as a single token in cl100k_base, matching JSON's `"` overhead per side. Inside `<<< ... >>>`, every byte is literal. The decoder unwraps by **outermost slice**, so an embedded `>>>` on a single-line value is handled transparently:

```
field=<<<a>>>b>>>   ← decodes to: a>>>b
```

#### Multiline / nonce-bounded strings ([ADR-0011](./adr/0011-multiline-nonce-optional.md))

For values containing `\n` or `\r`, the encoder uses a line-bounded form. The nonce is optional and used only when a content line literally equals `>>>`.

Bare (default):

```
body=<<<
Hello,

This is a multiline message. It can contain anything,
including >>> arrows (only at line start would matter).
>>>
```

Nonce-bounded (used only when a content line is exactly `>>>`):

```
body=<<<7f2a
Hello,

>>>
this line above is literally `>>>` and would otherwise close the block.
>>>7f2a
```

When present, the nonce is a short random hex string generated by the encoder per block. Collision probability is ~1/65 536 per block for 4-hex-char nonces; encoders should widen to 6+ hex chars if a document contains many text blocks.

The model emitting RAIF-G copies the nonce verbatim from the opener to the closer. A mismatched nonce is a repairable error if exactly one closer with the expected length exists in the stream (see §6).

**Choosing the form** (per [ADR-0007](./adr/0007-value-wrap-rules-are-minimal.md) and [ADR-0011](./adr/0011-multiline-nonce-optional.md)): the encoder wraps only on true ambiguities.

1. Bare (`field=value`) — default for everything that isn't ambiguous, including strings containing `,`, `:`, `[`, `]`, `{`, `}`, `=`.
2. Delimited single-line (`field=<<<value>>>`) — empty string, leading/trailing whitespace, starts with `<<<`, contains embedded `>>>`, equals a JSON literal (`null` / `true` / `false` / `[]` / `{}` / any JSON number), or parses as inline-object syntax.
3. Bare multiline (`field=<<<\n…\n>>>`) — contains `\n` or `\r` and no content line equals `>>>`.
4. Nonce-bounded multiline (`field=<<<NONCE\n…\n>>>NONCE`) — contains `\n` or `\r` and at least one content line equals `>>>`.

### 3.5 Null and empty containers (JSON literals)

Null and empty containers use the JSON literal forms (see [ADR-0009](./adr/0009-null-and-empty-containers-use-json-literals.md)):

```
optional_field=null
empty_list=[]
empty_object={}
```

Strings literally equal to `"null"`, `"[]"`, `"{}"`, `"true"`, `"false"`, or any JSON number form, or any inline-object syntax form, MUST be wrapped:

```
placeholder=<<<null>>>
literal_brackets=<<<[]>>>
version_tag=<<<true>>>
literal_inline=<<<{a=1,b=2}>>>
```

### 3.6 Type tags (explicit, for ambiguity only)

When a value would be parsed as the wrong type, prepend the type code:

```
id:s=42            # string "42", not number 42
flag:s=true        # string "true", not boolean true
count:n=0          # explicit number 0 (redundant but legal)
```

Equivalent to wrapping in `<<< ... >>>`:

```
id=<<<42>>>
flag=<<<true>>>
```

Both forms are accepted. Canonical RAIF-R uses the form whose encoded length is shorter.

### 3.7 Quoted keys (for pathological keys)

JSON keys containing path-significant characters (`.`, `[`, `]`) MUST be wrapped with `<<< ... >>>`:

```
<<<user.email>>>=e@example.com
<<<items[0]>>>=value
```

Inside an inline-object literal, additional characters become significant (`,`, `{`, `}`, `=`, `:`), and pathological keys are wrapped the same way:

```
mixed[0]={<<<user.email>>>=x@y.z,role=admin}
```

Without the quotes these would collide with the path / inline syntax. Keys containing literal `<<<` or `>>>` are rejected (no escape mechanism is provided; such keys are vanishingly rare in real JSON).

---

## 4. Type system

| Code | Meaning | JSON form |
|---|---|---|
| `s` | string | string |
| `t` | multiline text | string (with newlines inside) |
| `n` | number | number |
| `b` | boolean | true / false |

Type codes appear only in **explicit type tag** form when value inference would be wrong: `id:s=42` forces "string 42", `count:n=0` forces number. Null and empty containers use JSON literals directly (`=null`, `=[]`, `={}`) — see [ADR-0009](./adr/0009-null-and-empty-containers-use-json-literals.md). Inline-object values are recognized by syntactic shape (§3.4), not by a type code. The `z` / `l` / `o` codes from earlier drafts are obsolete.

JSON arrays and non-empty nested objects do not have a top-level type code; they are represented by their constituent leaves under path syntax, by a table header + rows, or by an inline-object leaf.

Type-system principle: values use **JSON semantics verbatim**. RAIF does not introduce int/float distinction, does not handle big-integer precision specially, does not normalize locales, does not accept `NaN` / `Infinity`. See [ADR-0006](./adr/0006-value-semantics-inherit-from-json.md).

---

## 5. JSON round-trip rules

### 5.1 JSON → RAIF (encoder)

1. Reject if input is not a JSON object.
2. For each `(key, value)` pair:
   - Primitive value → emit one leaf.
   - Array → if it is empty, emit `key=[]`; else build candidate emissions (path mode, table mode if eligible, inline-object mode if eligible) and emit the shortest. See [ADR-0012](./adr/0012-encoder-picks-cheapest-array-mode.md).
   - Object → if it is empty, emit `key={}`; else build path-expansion vs inline-object (if eligible) and emit the shorter; inline form is never used at the root.
   - `null` → emit `key=null`.
3. Key encoding:
   - Plain keys (containing no `.`, `[`, `]`, `=`, `:`, newline, leading/trailing whitespace, or `<<<` / `>>>`) emit unquoted.
   - Pathological keys wrap with `<<<...>>>`.
4. Value encoding (per [ADR-0007](./adr/0007-value-wrap-rules-are-minimal.md), [ADR-0011](./adr/0011-multiline-nonce-optional.md), [ADR-0013](./adr/0013-multi-line-array-literal.md)):
   - If the string contains `\n` or `\r`, use the bare multiline form unless a content line equals `>>>`, in which case use the nonce-bounded multiline form.
   - Else if the string is empty, has leading/trailing whitespace, starts with `<<<`, contains an embedded `>>>`, equals `[]` / `{}`, equals `[`, matches a JSON literal (`true` / `false` / `null` / JSON number), or parses as inline-object syntax, wrap with `<<<...>>>`.
   - Else emit bare.
   - Inside an array literal, additionally wrap any row whose value is `]` so it doesn't close the array early.

### 5.2 RAIF → JSON (decoder)

1. Parse all leaves. Syntax errors short-circuit (with repair attempts per Section 6).
2. Walk each leaf's path to build the JSON object.
3. Reject path collisions (`a=1` and `a.b=2`).
4. Reject sparse array indices.
5. JSON literals (`null`, `true`, `false`, `[]`, `{}`, numbers) decode to their JSON values.
6. Inline-object syntax (`{key=val,…}`) decodes to a JSON object; non-matching `{…}` decodes as a string.
7. Bare values decode per the inference rules in §3.4.

### 5.3 Round-trip fidelity

For any in-scope JSON object `J`:

- `decode(encode(J))` equals `J` as JSON values. Object key order is not preserved across the round-trip (RAIF re-emits in UTF-8 byte order).
- `encode(decode(encode(J)))` is byte-identical to `encode(J)` after canonical RAIF-R normalization, modulo random multiline nonces (which differ run-to-run).
- Number precision inherits the host language. Strings, booleans, and `null` are byte-exact.

---

## 6. Repair (syntax only)

The interpreter MAY repair the following representation errors during parsing. Every repair is recorded in an audit log.

- Stripped markdown fences (` ``` `, ` ```raif `, etc.) around the document.
- Extra prose before or after the document, when the RAIF block is identifiable.
- Mode markers (`<raif>` / `</raif>` and the special-token equivalents `<|raif_start|>` / `<|raif_end|>`) extracted from surrounding text. The decoder strips matched pairs before parsing.
- Wrong separator (`:` in place of `=` between key and value) corrected when unambiguous. A typed-leaf separator (`:s=`, `:n=`, etc.) is preserved as-is.
- Leaf order normalized to canonical (ascending indices, UTF-8 byte order).
- Missing trailing newline added.
- `\r\n` and `\r` line endings normalized to `\n`.
- Mismatched nonce on a multiline closer corrected if exactly one closer line starting with `>>>` exists downstream of the opener; ambiguous candidates fail rather than guess.

The interpreter MUST NOT:

- Modify any value byte. Typos in values are validation errors, not repair candidates.
- Normalize numbers (no locale handling, no scientific-notation rewriting, no trailing-zero changes).
- Coerce a value's type (a leaf typed `s` stays `s`).
- Apply a repair when multiple repairs are equally plausible (ambiguous → validation error).

See [ADR-0004](./adr/0004-repair-fixes-syntax-not-values.md).

---

## 7. Validation

After parsing and repair, the interpreter validates:

- Every leaf parses to a value of a recognized type.
- All array indices for the same array are dense (0..N-1).
- No path collisions.
- If a schema is supplied: field names, required-ness, value constraints, enum membership.

A failed validation surfaces to the caller. The interpreter never invents or mutates values to make validation pass. The caller chooses recovery: re-prompt the model, fail the tool call, escalate.

---

## 8. Mode markers (integration tier)

For fine-tuned models, mode markers signal RAIF emission discipline:

```
<raif>
to=user@example.com
subject=Invoice ready
body=Hello there
</raif>
```

Future fine-tuned models register special tokens:

```
<|raif_start|>
...
<|raif_end|>
```

Mode markers are **not** wire-format ceremony. They are runtime framing analogous to Gemma 4's `<|tool_call|>` / `<tool_call|>` tokens. They do not count in token-efficiency comparisons.

In the prompt-only MVP, mode markers are optional textual tags. The repair pass (§6) strips them automatically so the same parser handles both prompt-only and fine-tuned-token deliveries. In the fine-tuned integration stage, they become registered special tokens and the runtime switches the parser based on token boundary alone.

---

## 9. RAIF-R canonical form (audit tier)

For audit trails and durable transport within the same schema generation, the interpreter emits **RAIF-R**: the parsed document re-serialized in canonical form with optional per-leaf checksums.

RAIF-R differences from the default form:

- Leaves sorted canonically (ascending indices, UTF-8 byte order of names).
- Each leaf MAY carry a `;<hex>` CRC-8 suffix.
- An object-level checksum MAY follow the last leaf as `;;<hex>`.
- Leaf values are byte-identical to their RAIF-G source.

RAIF-R is interpreter-generated only. Models emit the loose default form; interpreters canonicalize.

---

## 10. Comparison with JSON

| Aspect | JSON | RAIF v0.3 |
|---|---|---|
| Brace / quote balancing | Required at every level, brittle under truncation | None at top level; bounded inside inline-object leaves |
| Per-field recovery | None (one bad escape destroys the object) | Each leaf independent; inline-object loses one row |
| Special-character strings | Backslash escaping required | `<<<…>>>` raw delimiter, outermost-slice unwrap |
| Multiline strings | `\n` escapes only | Native via line-bounded form; nonce only on demand |
| Token cost (3-field tool call) | ~17 | ~15 (-12%) |
| Token cost (homogeneous array, 10 rows) | ~180 | ~133 (-26%) |
| Token cost (heterogeneous array, 3 rows) | ~32 | ~29 (-9%, was +63% in v0.2 / +9% before array-literal) |
| Token cost (flat nested object, 6 fields) | ~38 | ~34 (-11%) |
| Token cost (deep-path array, 5 rows) | ~53 | ~46 (-13%) |
| Token cost (text-heavy payload) | High (escape pairs) | Low (no escaping) |
| Overall corpus benchmark | baseline | **-13%** (18 cases, v0.3 with ADR-0013) |
| Value semantics | Standard | Identical to JSON |

---

## 11. MVP implementation surface

```ts
// @raif/core

type JSONObject = Record<string, JSONValue>;
type JSONValue = string | number | boolean | null | JSONValue[] | JSONObject;

type ParseResult =
  | { ok: true; value: JSONObject; repairs: RaifRepair[] }
  | { ok: false; errors: RaifError[]; partial?: Partial<JSONObject> };

function parseRaif(input: string): ParseResult;
function encodeRaif(obj: JSONObject): string;
function canonicalizeRaifR(input: string): string;
```

That is the entire required surface. Schema validation, repair audit, grammar generation, fine-tuning datasets all layer on top.

---

## 12. Worked example

JSON source:

```json
{
  "to": "client@example.com",
  "subject": "Invoice ready",
  "body": "Hi,\nThe invoice is ready for review.\n\nThanks,\nEgor",
  "priority": 2,
  "tags": ["billing", "urgent"],
  "metadata": {
    "tracking_id": "abc-123",
    "retry_count": 0
  },
  "scheduled_at": null,
  "attachments": []
}
```

RAIF (default form, v0.3):

```
attachments=[]
body=<<<
Hi,
The invoice is ready for review.

Thanks,
Egor
>>>
metadata={retry_count=0,tracking_id=abc-123}
priority=2
scheduled_at=null
subject=Invoice ready
tags[0]=billing
tags[1]=urgent
to=client@example.com
```

Notes:

- `attachments=[]` and `scheduled_at=null` are JSON literals.
- `body` uses the bare multiline form — no content line is exactly `>>>`, so no nonce is emitted.
- `metadata` collapses to an inline-object leaf (shorter than path expansion at `metadata.tracking_id=…\nmetadata.retry_count=…`).
- `tags` is a 2-element array of primitives — at this size path mode and the array-literal form tie, and the selector picks the form whose byte length is smaller. (For 4+ primitives the literal form pulls ahead.)
- No string in this example matches a JSON literal, inline-object syntax, or contains an embedded `>>>`, so none need the simple `<<<...>>>` form.

Round-trip: decode produces a JSON object byte-equivalent to the source after key reordering to UTF-8 byte order.

---

## 13. Design decisions

All load-bearing decisions are captured as ADRs:

- [ADR-0001](./adr/0001-text-block-nonce-delimiters.md) — Text-block delimiters use ASCII `<<<` / `>>>` with a per-block nonce when needed
- [ADR-0002](./adr/0002-bare-typecode-sentinels-for-null-and-empty-containers.md) — *(superseded by ADR-0009)*
- [ADR-0003](./adr/0003-schema-versioning-is-out-of-scope.md) — Schema versioning and evolution are out of scope
- [ADR-0004](./adr/0004-repair-fixes-syntax-not-values.md) — Repair fixes syntax, not values
- [ADR-0005](./adr/0005-minimal-default-emission-form.md) — Default emission form is ceremony-free
- [ADR-0006](./adr/0006-value-semantics-inherit-from-json.md) — Value semantics inherit from JSON
- [ADR-0007](./adr/0007-value-wrap-rules-are-minimal.md) — Value-wrap rules are minimal
- [ADR-0008](./adr/0008-table-mode-for-homogeneous-arrays.md) — Table mode for homogeneous arrays
- [ADR-0009](./adr/0009-null-and-empty-containers-use-json-literals.md) — Null and empty containers use JSON literals
- [ADR-0010](./adr/0010-inline-object-form.md) — Inline-object form for heterogeneous arrays and flat nested objects
- [ADR-0011](./adr/0011-multiline-nonce-optional.md) — Multiline nonce is optional, used only on demand
- [ADR-0012](./adr/0012-encoder-picks-cheapest-array-mode.md) — Encoder picks the cheapest emission per array / nested object
- [ADR-0013](./adr/0013-multi-line-array-literal.md) — Multi-line array literal `prefix=[\n…\n]` for shared-prefix savings
