# Null and empty containers use bare type-code sentinels

> **Status: superseded by [ADR-0009](./0009-null-and-empty-containers-use-json-literals.md).** Empirical benchmarking showed `:z` / `:l` / `:o` cost more BPE tokens than `=null` / `=[]` / `={}`, not fewer. The sentinel form is removed from v0.2.

> Below: the original reasoning, preserved for context.

Path mode must round-trip JSON bijectively, but implicit-null and implicit-empty-container encodings collapse `{"a": null}`, `{"a": []}`, `{"a": {}}`, and `{}` into the same zero-leaf RAIF. We introduce three sentinel forms — `a:z` for null, `a:l` for empty array, `a:o` for empty object — using the type code alone (no `=`, no value). The bare-typecode form is reserved exclusively for these three "presence-of-empty" types; all other types require `=<value>` or a text block, so a malformed leaf like `subject:s` is syntactically distinguishable from a valid sentinel and the repair pass can flag it. Array elements are always emitted as explicit leaves (`a[0]:z`, `a[1]:z`, ...) so array length is recoverable without a separate count mechanism — accepting a token cost for null-heavy arrays in exchange for never asking the model to count.

Object key ordering is UTF-8 byte order. This is the only collation portable across JS (UTF-16 code unit), Python (Unicode code point), and Go (byte).

## Considered options

- **`tags:l=[]` / `meta:o={}`** — rejected; the `=[]` adds 2–4 tokens of pure noise.
- **`a[]:i=3` length-leaf** — rejected; requires the model to count array length, which is the worst-case BPE failure mode.
- **Open/close markers `tags[` / `tags]`** — rejected; requires balancing, the same JSON brace problem RAIF was designed to escape.
- **Implicit nulls / implicit empties** — rejected; breaks bijective round-trip.

## Consequences

- Three new type codes (`z`, `l`, `o`) are introduced into the MVP type set, raising the minimum implementation surface.
- Null-heavy arrays pay a ~30% token penalty vs. JSON. Acceptable for the model-correctness win.
- Grammar must enforce that bare `:<typecode>` is only legal for `z | l | o`.
