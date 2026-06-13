# Inline-object form for heterogeneous arrays and flat nested objects

Path mode and table mode (ADR-0008) together cover the easy cases: nested objects with deep paths, and arrays of objects with a shared key set. They leave two cases where RAIF lost to minified JSON in the v0.2 prototype:

- **Heterogeneous arrays** (`heterogeneous_array` corpus case, +63% vs JSON). Arrays of objects whose key sets differ from row to row. Table mode is ineligible. Path mode pays the full `prefix[N].keyName=` overhead per cell, with no shared structure between rows for the parser to amortize.
- **Wide-but-flat nested objects** (`json_heavy.data.user`-style sub-objects, contributing to the +3% loss on `json_heavy`). Three or four keys, all primitives, but the parent prefix is long and repeats per leaf.

For both shapes, JSON wins because its brace structure lets it share the parent prefix once and list `key:value,` pairs at low per-cell cost. RAIF needs an analogous form.

## Wire format

A leaf may emit an object value as a single inline literal:

```
prefix={key1=val1,key2=val2,key3=val3}
```

- Outer braces `{` … `}` bracket the inline object.
- Inside, comma-separated `key=value` pairs in canonical (UTF-8 byte-order) key order.
- Keys follow the path-key wrap rules ([ADR-0001](./0001-text-block-nonce-delimiters.md), [ADR-0007](./0007-value-wrap-rules-are-minimal.md)) plus `,`, `{`, `}` added as wrap triggers.
- Values follow the bare-value rules ([ADR-0007](./0007-value-wrap-rules-are-minimal.md)) plus `,` and `}` added as wrap triggers.

Two example shapes:

```
mixed[0]={kind=user,name=alice}
data.user={handle=egor,id=7,verified=true}
```

## Eligibility

The encoder may emit the inline-object form when **all** of:

1. The value is a plain (non-null, non-array) object.
2. Every cell value is a primitive (string, number, boolean, null).
3. No cell string contains `\n`, `\r`, or `>>>`.
4. No key contains `<<<` / `>>>` / `\n` / `\r`.
5. The result is shorter than path expansion (see [ADR-0012](./0012-encoder-picks-cheapest-array-mode.md)).

If any condition fails, encoder uses path mode. Nested objects/arrays inside an inline object are not supported — keep inline objects flat. (Recursive inline would amplify the "one bad cell kills the row" failure mode and forces the parser to balance braces, which we deliberately avoided for the top-level wire format.)

## Disambiguation from string values

A bare string value `{not an object}` already round-trips fine today: the encoder emits it bare, the decoder takes the raw text. To keep this working alongside the inline-object form, the decoder applies the inline-object grammar **first** and falls back to string only when the grammar doesn't match:

- `{}` → empty object (existing rule).
- `{key=val[,key=val]*}` matching the inline-object grammar → object value.
- Anything else starting with `{` and ending with `}` → string value.

A string that would parse as inline-object syntax (e.g. literal `"{a=1,b=2}"`) gets wrapped by the encoder: `key=<<<{a=1,b=2}>>>`. This adds 6 chars to a vanishingly rare value and removes the ambiguity completely.

## Impact on the corpus

| case | path mode | inline-object |
|---|---:|---:|
| heterogeneous_array (3 rows, mixed keys) | +63% | +9% |
| wide_heterogeneous_array (5 rows, mixed keys) | (would be ~+90%) | +5% |
| flat_inline_object (1 obj, 6 primitive fields) | (would be ~+10%) | -11% |
| json_heavy (nested `data.user` collapse) | +3% | -7% |
| nested_object (`user` collapses) | -12% | -20% |

The wins on json-heavy and nested_object are entirely from the **nested-object** application of inline form, which is shorter than path expansion whenever the parent prefix is long enough.

`heterogeneous_array` and `wide_heterogeneous_array` still lose to JSON. The residual loss is structural: JSON's `,` row separator is cheaper than RAIF's `\nprefix[N]=` row separator. Closing this gap would require an array-mode header that shares the prefix once across rows; that's deferred (see "Future" below).

## Failure-mode comparison vs path mode

| failure | path mode | inline-object |
|---|---|---|
| one bad cell | only that leaf is lost | the entire row is lost |
| truncated stream mid-row | all complete leaves recoverable | the truncated row is lost; earlier rows intact |
| corrupted brace inside row | n/a | row lost; later rows intact (each row is its own leaf) |

The locality unit shifts from cell to row. Acceptable: rows are still independent leaves separated by `\n`, so a bad row never poisons its neighbors.

## What this is not

- Not full inline JSON. Nested objects/arrays inside an inline object are rejected by eligibility; the encoder falls back to path mode.
- Not a schema. There's no header, no column declaration, no version. Each row carries its own key list inline.
- Not TOON. Inline-object is one wire shape for one local optimization; TOON is a separate input-compression format with its own design philosophy.

## Consequences

- The decoder gains one new value-parsing path: `tryParseInlineObject`. About 25 lines.
- The encoder gains an eligibility check and a cost comparison for arrays and nested objects. See [ADR-0012](./0012-encoder-picks-cheapest-array-mode.md) for the selection rule.
- The bare string grammar narrows slightly: any value that parses as `{key=val,...}` is now an object, not a string. Strings of that shape must wrap.
- LLM emission: inline-object reads JSON-like and models should emit it fluently. No new keyword to memorize.

## Future

A "shared-prefix array header" could close the remaining loss on heterogeneous arrays:

```
mixed::*
[0]={kind=user,name=alice}
[1]={kind=group,members=5}
```

The `::*` declares an inline-object array; subsequent `[N]={...}` rows use the implicit prefix. Saves the per-row prefix repetition. Worth exploring once we have LLM-generated data to confirm the locality trade-off (models forgetting the active prefix is a real failure mode). Deferred.
