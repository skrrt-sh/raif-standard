# Table mode for homogeneous arrays of objects

Path mode in v0.2 represents `[{a:1, b:"x"}, {a:2, b:"y"}, ...]` as one leaf per `(row, column)` pair:

```
items[0].a=1
items[0].b=x
items[1].a=2
items[1].b=y
```

Every row pays for the full prefix `items[N].` again, every column name again. JSON shares those tokens via its brace structure (`{"items":[{"a":1,"b":"x"},...]}`); RAIF doesn't. On the prototype's `array_of_objects` and `large_table` corpus cases, this cost RAIF +78% vs minified JSON.

We add a **table mode** for arrays where every element is an object with the same key set. The encoder auto-detects the shape; the decoder learns one new leaf form.

## Wire format

```
items::a,b              ← table header: prefix `::` comma-separated column list
items[0]=1,x            ← row: prefix `[N]=` comma-separated cells in column order
items[1]=2,y
```

The `::` distinguishes the header from a typed leaf (`:s=...`) or a bare value. Columns are sorted UTF-8 byte order in canonical form. Cells in each row appear in the same order as the header.

### Cell value forms

- Numbers, booleans, `null` → JSON literal form (same as bare values elsewhere).
- Strings → bare unless they contain `,` (the cell separator), in which case wrap with `<<<...>>>`. The five wrap conditions from [ADR-0007](./0007-value-wrap-rules-are-minimal.md) apply, with `,` added.
- Multiline strings, strings containing `>>>`, and nested objects/arrays make the row ineligible; the encoder falls back to path mode for the whole array.

### Eligibility

Encoder uses table mode when **all** of:

1. Array has ≥ 2 elements.
2. Every element is a plain (non-null, non-array) object.
3. Every element has exactly the same key set.
4. Every cell value is a primitive (string, number, boolean, null).
5. No cell string contains `\n`, `\r`, or `>>>`.
6. Column names contain none of: `,`, `=`, `:`, `<<<`, `>>>`.

If any condition fails, encoder uses path mode and emits no header for that array.

## Impact on the corpus

| case | path mode | table mode |
|---|---:|---:|
| array_of_objects (3 rows × 3 cols) | +78% | -10% |
| large_table (10 rows × 4 cols) | (would be +100%+) | -26% |
| json_heavy (embedded 2-row array) | +37% | +3% |

Crossover: table mode wins for N ≥ 2. The two-row case in `json_heavy` doesn't fully amortize the header overhead, but still beats path mode meaningfully.

## What this is not

This is **not** TOON. Table mode is a single tactical addition for one well-defined shape (homogeneous arrays of flat records). It doesn't try to compress everything; it doesn't introduce a new top-level paradigm. Arrays of objects with varying keys, nested values, or text-heavy fields still use path mode.

It is also not a schema. The header declares the column list inline, per emission. No registry, no version negotiation, no cross-time guarantees — consistent with [ADR-0003](./0003-schema-versioning-is-out-of-scope.md).

## Consequences

- The decoder must track table headers it has seen so far in the current document. A row referring to a column list not yet declared is a parse error.
- The wire format has a third leaf shape (table header), in addition to bare leaves and typed leaves.
- The encoder gains a non-trivial detection pass for each array. Cost is O(N×K) where N is row count and K is column count.
- LLM emission of table mode is straightforward: declare the header, then emit rows. Models handle this pattern fluently in our experience (TOON-style, CSV-style emissions are common in training data).

## What's still unfixed

`heterogeneous_array` — arrays of objects with *different* key sets — still loses to JSON badly (+63% in the bench). This is structurally unavoidable in path mode (no shared schema → no shared tokens) and out of table mode's scope. Likely acceptable: such payloads are rarer than homogeneous tables in tool-call/API-response data, and the alternative (per-row schema declaration) would be worse than JSON for small N.
