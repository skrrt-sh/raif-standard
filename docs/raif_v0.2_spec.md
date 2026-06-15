# RAIF Standard v0.2

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
- Self-healing parser that repairs **syntax** errors (markdown fences, missing newlines, wrong separators, leaf order).
- Token efficiency that beats JSON on most object shapes.

### Out of scope

- Top-level arrays (`[1,2,3]`), top-level primitives, multi-document streams, JSON Lines / NDJSON.
- Schema versioning, schema registries, schema evolution. Use protobuf or Avro for cross-time wire compatibility. (See [ADR-0003](./adr/0003-schema-versioning-is-out-of-scope.md).)
- Value-level repair: typo correction, locale normalization, fuzzy boolean matching. (See [ADR-0004](./adr/0004-repair-fixes-syntax-not-values.md).)
- Richer-than-JSON types: no separate int/float, no dates, no URIs. (See [ADR-0006](./adr/0006-value-semantics-inherit-from-json.md).)

---

## 3. Wire format

### 3.1 The leaf

A **leaf** is one line representing one scalar value, one null, or one empty-container marker.

```
to=user@example.com
priority=2
notify=true
empty_list:l
nothing:z
```

Each leaf is independently parseable. A corrupted leaf damages only itself; neighbors survive.

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

When every element of an array is an object with the same flat key set, the encoder emits a header + indexed rows instead of repeating the path prefix per leaf:

```
items::id,name,qty
items[0]=1,foo,2
items[1]=2,bar,5
items[2]=3,baz,1
```

The `::` after the array prefix declares the column list (sorted UTF-8 byte order). Each row is one leaf with cells separated by commas; cell wrapping follows [ADR-0007](./adr/0007-value-wrap-rules-are-minimal.md) with `,` added as a wrap trigger.

Encoder eligibility: array has ≥ 2 elements, every element is a flat object with identical keys, every cell is a primitive without newlines or `>>>`, column names are simple identifiers. Otherwise path mode applies.

Crossover: table mode wins (vs path mode AND vs JSON) for N ≥ 2.

**Wire order:** any order. Parser reorders during canonicalization. Canonical RAIF-R order is: ascending array indices, then UTF-8 byte order of names within each scope.

**Sparse arrays:** REJECTED. If the source JSON has null elements, the encoder MUST emit them explicitly:

```
arr[0]=a
arr[1]=null
arr[2]=b
```

A document where array indices skip is a validation error.

**Path collision:** `a=1` and `a.b=2` cannot both exist. Validation error.

### 3.4 Value forms

#### Bare values (type inferred)

| Literal | Type |
|---|---|
| `42`, `-3.14`, `1e3`, `0` | number (JSON number grammar) |
| `true`, `false` | boolean |
| `null` | null |
| Any other bare identifier (no RAIF-significant chars) | string |

Number grammar: `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`. Leading zeros, `NaN`, `Infinity` are rejected — exactly as JSON.

**Parser separator rule:** the leaf separator is the first top-level `=` or `:` (or `::`) outside any `<<<...>>>` range. Once that's found, the value extends to the end of the line (or, for multiline blocks, to the matching nonce closer). So values can freely contain `=`, `,`, `:`, `[`, `]`, `{`, `}` — only the *literal* forms (`null`, `true`, `false`, `[]`, `{}`, JSON numbers), leading/trailing whitespace, embedded newlines, embedded `>>>`, or a leading `<<<` force a wrap.

#### Delimited strings (`<<< ... >>>`)

For string values containing RAIF-significant characters or that would otherwise parse as a literal:

```
greeting=<<<hello, "world"!>>>
weird=<<<has commas, "quotes", {braces}, =equals=, and a 42 number>>>
```

`<<<` and `>>>` each tokenize as a single token in cl100k_base, matching JSON's `"` overhead per side. Inside `<<< ... >>>`, every byte is literal except `>>>` itself.

(An earlier iteration of this spec used U+241E (`␞`) on the assumption that it was a single token. Prototype probing showed `␞` is 3 tokens in cl100k_base; see [ADR-0001](./adr/0001-text-block-nonce-delimiters.md) for the empirical correction.)

#### Multiline / nonce-bounded strings

For values containing `\n`, `\r`, or a literal `>>>`, fall back to the nonce-bounded form. A short random hex nonce is generated by the encoder per text block:

```
body=<<<7f2a
Hello,

This is a multiline message. It can contain anything,
including >>> and "quotes" and {braces}.
>>>7f2a
```

Opener: `<<<<nonce>` followed by `\n`. Closer: `>>><nonce>` on its own line. Collision probability is ~1/65 536 per block for 4-hex-char nonces; encoders should widen to 6+ hex chars if a document contains many text blocks.

The model emitting RAIF-G copies the nonce verbatim from the opener to the closer. A mismatched nonce is a repairable error if exactly one closer with the expected nonce exists in the stream.

**Choosing the form** (per [ADR-0007](./adr/0007-value-wrap-rules-are-minimal.md)): the encoder wraps only on true ambiguities.

1. Bare (`field=value`) — default for everything that isn't ambiguous, including strings containing `,`, `:`, `[`, `]`, `{`, `}`, `=`.
2. Delimited (`field=<<<value>>>`) — empty string, leading/trailing whitespace, starts with `<<<`, equals a JSON literal (`null` / `true` / `false` / `[]` / `{}` / any JSON number).
3. Nonce-bounded (`field=<<<NONCE\n...\n>>>NONCE`) — contains `\n`, `\r`, or literal `>>>`.

### 3.5 Null and empty containers (JSON literals)

Null and empty containers use the JSON literal forms (see [ADR-0009](./adr/0009-null-and-empty-containers-use-json-literals.md), supersedes ADR-0002):

```
optional_field=null
empty_list=[]
empty_object={}
```

Strings literally equal to `"null"`, `"[]"`, `"{}"`, `"true"`, `"false"`, or any JSON number form MUST be wrapped:

```
placeholder=<<<null>>>
literal_brackets=<<<[]>>>
version_tag=<<<true>>>
```

There is no `:typecode` sentinel form (that form was removed in v0.2 after empirical benchmarking showed it cost more BPE tokens than the literals it was meant to compress).

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

Without the quotes these would collide with the path syntax for nested objects and arrays. Keys containing literal `<<<` or `>>>` are rejected (no escape mechanism is provided; such keys are vanishingly rare in real JSON).

---

## 4. Type system

| Code | Meaning | JSON form |
|---|---|---|
| `s` | string | string |
| `t` | multiline text | string (with newlines or `>>>` inside) |
| `n` | number | number |
| `b` | boolean | true / false |

Type codes appear only in **explicit type tag** form when value inference would be wrong: `id:s=42` forces "string 42", `count:n=0` forces number. Null and empty containers use JSON literals directly (`=null`, `=[]`, `={}`) — see [ADR-0009](./adr/0009-null-and-empty-containers-use-json-literals.md). The `z` / `l` / `o` codes from earlier drafts are obsolete.

JSON arrays and non-empty nested objects do not have a top-level type code; they are represented by their constituent leaves under path syntax.

Type-system principle: values use **JSON semantics verbatim**. RAIF does not introduce int/float distinction, does not handle big-integer precision specially, does not normalize locales, does not accept `NaN` / `Infinity`. See [ADR-0006](./adr/0006-value-semantics-inherit-from-json.md).

---

## 5. JSON round-trip rules

### 5.1 JSON → RAIF (encoder)

1. Reject if input is not a JSON object.
2. For each `(key, value)` pair:
   - Primitive value → emit one leaf.
   - Array → if it is empty, emit `key=[]`; else if homogeneous flat-object eligible, emit table header + rows; else emit one leaf per element using bracket-index syntax.
   - Object → if it is empty, emit `key={}`; else recurse with `key.` prefix.
   - `null` → emit `key=null`.
3. Key encoding:
   - Plain keys (containing no `.`, `[`, `]`, `=`, `:`, newline, leading/trailing whitespace, or `<<<` / `>>>`) emit unquoted.
   - Pathological keys wrap with `<<<...>>>`.
4. Value encoding (per [ADR-0007](./adr/0007-value-wrap-rules-are-minimal.md)):
   - If the string contains `\n`, `\r`, or a literal `>>>`, use the nonce-bounded form.
   - Else if the string is empty, has leading/trailing whitespace, starts with `<<<`, equals `[]` / `{}`, or matches a JSON literal (`true` / `false` / `null` / JSON number), wrap with `<<<...>>>`.
   - Else emit bare. Strings containing `,`, `:`, `[`, `]`, `{`, `}`, `=` are all safe bare.

### 5.2 RAIF → JSON (decoder)

1. Parse all leaves. Syntax errors short-circuit (with repair attempts per Section 6).
2. Walk each leaf's path to build the JSON object.
3. Reject path collisions (`a=1` and `a.b=2`).
4. Reject sparse array indices.
5. Sentinels decode to `null`, `[]`, `{}`.
6. Bare values decode per the inference rules in Section 3.4.

### 5.3 Round-trip fidelity

For any in-scope JSON object `J`:

- `decode(encode(J))` equals `J` as JSON values. Object key order is not preserved across the round-trip (RAIF re-emits in UTF-8 byte order).
- `encode(decode(encode(J)))` is byte-identical to `encode(J)` after canonical RAIF-R normalization.
- Number precision inherits the host language. Strings, booleans, and `null` are byte-exact.

---

## 6. Repair (syntax only)

The interpreter MAY repair the following representation errors during parsing. Every repair is recorded in an audit log.

- Stripped markdown fences (` ``` `, ` ```raif `, etc.) around the document.
- Extra prose before or after the document, when the RAIF block is identifiable.
- Mode markers (`<raif>`, `</raif>`) extracted from surrounding text.
- Wrong separator (`:` in place of `=` between key and value) corrected when unambiguous.
- Leaf order normalized to canonical (ascending indices, UTF-8 byte order).
- Missing trailing newline added.
- `\r\n` and `\r` line endings normalized to `\n`.
- Mismatched nonce on a multiline closer corrected if exactly one closer with the opener's nonce exists in the stream.

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

In the prompt-only MVP, mode markers are optional textual tags. In the fine-tuned integration stage, they become registered special tokens and the runtime switches the parser based on token boundary alone.

---

## 9. RAIF-R canonical form (audit tier)

For audit trails and durable transport within the same schema generation, the interpreter emits **RAIF-R**: the parsed document re-serialized in canonical form with optional per-leaf checksums.

```
body=<<<7f2a
Hello there
>>>7f2a;a8
notify=true;1d
priority=2;33
subject=Invoice ready;3c
to=user@example.com;91
```

RAIF-R differences from the default form:

- Leaves sorted canonically (ascending indices, UTF-8 byte order of names).
- Each leaf MAY carry a `;<hex>` CRC-8 suffix.
- An object-level checksum MAY follow the last leaf as `;;<hex>`.
- Leaf values are byte-identical to their RAIF-G source.

RAIF-R is interpreter-generated only. Models emit the loose default form; interpreters canonicalize.

---

## 10. Comparison with JSON

| Aspect | JSON | RAIF |
|---|---|---|
| Brace / quote balancing | Required, brittle under truncation | None at top level |
| Per-field recovery | None (one bad escape destroys the object) | Each leaf is independent |
| Special-character strings | Backslash escaping required | `<<<...>>>` raw delimiter |
| Multiline strings | `\n` escapes only | Native via nonce block |
| Token cost (3-field tool call) | ~17 | ~15 (-12%) |
| Token cost (homogeneous array, 10 rows) | ~180 | ~133 (-26%) |
| Token cost (text-heavy payload) | High (escape pairs) | Low (no escaping) |
| Overall corpus benchmark | baseline | **-8%** |
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

RAIF (default form):

```
attachments=[]
body=<<<7f2a
Hi,
The invoice is ready for review.

Thanks,
Egor
>>>7f2a
metadata.retry_count=0
metadata.tracking_id=abc-123
priority=2
scheduled_at=null
subject=Invoice ready
tags[0]=billing
tags[1]=urgent
to=client@example.com
```

Most strings emit bare. The body uses the nonce-bounded form because it contains newlines. `attachments=[]` and `scheduled_at=null` are JSON literals. No string in this example matches a JSON literal (`true` / `false` / `null` / `[]` / `{}` / a number), so none need the simple `<<<...>>>` form.

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
