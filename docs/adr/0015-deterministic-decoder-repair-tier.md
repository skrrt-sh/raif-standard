# Deterministic decoder repair tier (TIER 2)

The v0.3 repair pass ([ADR-0004](./0004-repair-fixes-syntax-not-values.md)) is intentionally narrow: surface errors only (markdown fences, line endings, mode markers, separator typos, mismatched nonces). The first OpenRouter sweep (6 models × 18 shapes × 2 trials) showed this pass firing in **1 of 432 trials** — sound but rarely applicable. The dominant failure modes were grammar inventions that the repair pass refused to touch under ADR-0004's "syntax not values" rule.

Closer inspection of the failure outputs revealed a class of repairs that are **deterministic by construction**: there is exactly one logically valid interpretation of the malformed bytes, derivable from the wire alone without out-of-band context. ADR-0004's "syntax not values" rule was written before this class was named; the rule's *intent* (forbid heuristic value mutation that loses information) is preserved by the new tier, because every TIER 2 repair has a unique correct answer that is reachable by code-only reasoning.

## Decision

`fix` and (transitively) `decode` apply **TIER 2 deterministic repairs** in addition to the v0.3 TIER 1 surface repairs. The TIER 2 scope for v0.4 is exactly four repairs:

### A. Leading-zero "number" → string coercion

A bare value matching `0\d+(\.\d+)?` (one or more digits after a leading zero) is **not a valid JSON number** — JSON's number grammar rejects leading zeros except for the bare `0`. There is no consistent decode that treats it as a number; the only logically valid interpretation is a string.

```
zipcode=02134        # → "02134" (not number 2134, not number 02134 — number is illegal)
```

Distinct from `zipcode=0` (valid JSON number) and `zipcode=0.5` (valid number) — both decode unchanged. The repair fires only when the digits after the leading zero are not followed by `.`, `e`, or `E` consistent with valid number form, and would otherwise parse as illegal.

**Implementation status:** v0.3's `NUMBER_RE` already rejects leading-zero forms, so `decodeBareValue("02134")` already falls through to the string branch. A is therefore *existing v0.3 behavior formalized as a TIER 2 invariant* — no code change in v0.4. The repair does not emit an audit-log entry because there is nothing to repair: the wire shape `02134` was never accepted as a number in the first place.

### B. Repeated-key auto-indexing

When a leaf key appears more than once at the same scope and no `key[N]=…` form already exists for that key, the decoder auto-indexes the repetitions as array elements in encounter order:

```
mixed={kind=user,name=alice}
mixed={kind=group,members=5}
mixed={kind=user,name=bob,role=admin}
```

becomes

```
mixed[0]={kind=user,name=alice}
mixed[1]={kind=group,members=5}
mixed[2]={kind=user,name=bob,role=admin}
```

Eligibility:

- All occurrences are at the same scope (root or same parent path).
- No `mixed[N]=…` form already exists for the same key (would create a collision).
- The repair is refused if any of the values are themselves indexed forms (e.g. `mixed[0]=…` mixed with `mixed=…` is ambiguous).

### C. Nested inline-object flattening

An inline-object leaf whose values include further inline objects (or array literals) is flattened into path-mode leaves. ADR-0010 forbids nested inline-objects in the wire grammar; this repair recovers when a model emits the forbidden form anyway:

```
data={user={id=7,handle=egor},meta={has_more=false}}
```

becomes

```
data.user.id=7
data.user.handle=egor
data.meta.has_more=false
```

Bounded: only flat-key inline-objects (no `=` inside values other than the inner `key=value` separators) are flattened. Inline-objects containing partially-mangled syntax fall through to the standard parse-fail path.

### D. Sparse table mode (decode-accept only)

A table row containing `null` cells is accepted as a valid heterogeneous-array representation. Multiple real models naturally emit this for arrays whose elements have overlapping-but-not-identical key sets:

```
mixed::kind,members,name,role
mixed[0]=user,null,alice,null
mixed[1]=group,5,null,null
mixed[2]=user,null,bob,admin
```

decodes to

```json
{ "mixed": [
  { "kind": "user", "name": "alice" },
  { "kind": "group", "members": 5 },
  { "kind": "user", "name": "bob", "role": "admin" }
] }
```

A `null` cell signals "this key is absent from this object", not "this key is present with value null". The encoder **does not** emit this form — the cheapest-mode pick in [ADR-0012](./0012-encoder-picks-cheapest-array-mode.md) continues to choose path / table / inline / array-literal. RAIF-R for any heterogeneous array re-emits as whatever form the encoder picks (typically array literal per [ADR-0013](./0013-multi-line-array-literal.md)). Sparse table is one-way: a valid input form, never an output form.

**Encoder companion change:** to keep round-trip semantics exact, the encoder's `asTable` eligibility check is tightened in v0.4 to refuse table form when any cell value would be `null`. Without this, an input like `[{id:1, note:null}, {id:2, note:null}]` would encode to table form with `null` cells, and the decoder would interpret the `null` cells as "key absent" — breaking round-trip. The encoder now falls back to inline-object / array-literal / path mode for such arrays; all three carry `null` explicitly and round-trip cleanly. Token impact on the 18-shape corpus: zero (no shape in the corpus has nulls in a homogeneous array).

(If a future bench shows sparse-table is sometimes the cheapest emission, ADR-0012 may be amended to include it. Not yet justified by data.)

## Out of scope for v0.4

Three repairs that were considered and rejected for this release:

- **Extra-cell-with-key recognition** — e.g., `events[4]=view,/thanks,1715600200,referrer=/checkout` where the final cell carries an extra `key=value` for a row that breaks homogeneity. Heuristic-but-bounded; deferred until D (sparse-table) is measured and we know whether the residual is worth a separate repair.
- **Table-row width majority repair** — if N-1 rows match the header width and 1 row is off-by-one, "fix" the off-by-one row by guessing where the missing/extra cell is. Violates the deterministic principle: the missing cell could be at any position.
- **`\n` escape literal → real newline** — when a single-line value contains the literal two-char `\n` sequence and the model probably meant a newline. This is *value mutation* (`"foo\\nbar"` and `"foo\nbar"` are different strings); coercing one to the other crosses the ADR-0004 boundary.

Each of the deferred items can be promoted in a future ADR once we have data justifying the trade-off.

## Why this stays compatible with ADR-0004

ADR-0004's rule: "repair fixes syntax, not values." TIER 2 repairs A/B/C/D are all *parse-rule* changes — they change which input bytes successfully decode, but they never invent or mutate a value byte that the input didn't already specify:

- A: the bytes `02134` decode to the string `"02134"` — the encoder's bytes are passed through; no characters are added or changed.
- B: `mixed=…\nmixed=…` becomes `mixed[0]=…\nmixed[1]=…` — the *value bytes are unchanged*; only the path is augmented with an index derived from the existing wire order.
- C: nested-inline flattening preserves every value byte; only the path is restructured.
- D: `null` cells map to "key absent" rather than to value `null` — but the wire's `null` byte already had no other consistent interpretation in a column whose other rows carry actual values for that key.

If a future repair *would* mutate a value byte, it stays out of TIER 2 and requires its own ADR amending ADR-0004 (or, more likely, an opt-in TIER 3 schema-aware repair tier — see [ADR-0017](./0017-fine-tune-integration-philosophy.md) for the planned schema-as-parity mechanism).

## Failure handling

When two TIER 2 repairs *could* apply to the same input and would produce different outputs, the repair refuses rather than guess. This preserves the "deterministic by construction" property. Concrete cases:

- A vs B: `mixed=02134\nmixed=02135` — A fires per value (string coercion), B fires per key (auto-index). They commute; both fire. Result: `mixed[0]="02134"`, `mixed[1]="02135"`.
- B vs C: `data={user={id=7},user={id=8}}` — B says auto-index `user`; C says flatten nested inline. Both fire in well-defined order (C first, then B on the resulting `data.user=…\ndata.user=…`).
- B vs D: `mixed::kind\nmixed[0]=user\nmixed=group` — table form mixed with bare repeats. Refused: which interpretation is correct depends on whether the table is the intent or the repeats are. Surface as validation error.

The precedence rule when repairs commute: alphabetical (A before B before C before D). Documented in the implementation; testable.

## Consequences

- The `fix` function gains four new repair phases (one per TIER 2 repair). Each phase is implemented as a pure function over a leaf list, contributing entries to the `repairs` audit log.
- The encoder is unchanged. Canonical RAIF for any JSON value is byte-identical before and after this ADR.
- The corpus harness should see large jumps on `heterogeneous_array`, `wide_heterogeneous_array`, `numeric_string_ambiguity`, and the deep-nesting / json-heavy shapes that previously failed on nested inline-object emission. Expected post-Track-1 numbers will be re-measured by re-running the OpenRouter sweep.
- v0.3 documents continue to decode unchanged (no input that was previously valid becomes invalid; some inputs that were previously invalid are now repairable).
- Spec §6 (Repair) gets a new TIER 2 subsection enumerating A/B/C/D with examples and bounds.
