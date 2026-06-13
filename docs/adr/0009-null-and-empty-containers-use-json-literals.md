# Null and empty containers use JSON literals, not sentinels

Supersedes [ADR-0002](./0002-bare-typecode-sentinels-for-null-and-empty-containers.md). The original sentinel forms `key:z` / `key:l` / `key:o` were adopted on the assumption that bare type codes would be shorter than spelled-out literals. Empirical benchmarking against cl100k_base showed the opposite: `:z` typically tokenizes as 2 tokens, `=null` as 2 tokens, but the encoder's per-leaf newline plus the longer literal name often packs better with neighboring tokens. Across the prototype corpus, replacing all sentinel forms with `key=null` / `key=[]` / `key={}` reduced overall RAIF token cost by about 5% and flipped the `null_and_empties` benchmark case from +16% (RAIF loses) to ±0% (parity).

The literal forms also remove a special parsing path (no more bare `:typecode` form), simplify the grammar, and match JSON byte-for-byte so encoder/decoder don't need a translation step for these primitives.

## Rules

- `key=null` → JSON null. Canonical and only form.
- `key=[]` → empty array. Canonical and only form.
- `key={}` → empty object. Canonical and only form.
- Strings literally equal to `"null"`, `"true"`, `"false"`, `"[]"`, `"{}"`, or any JSON number form MUST be wrapped: `key=<<<null>>>`, `key=<<<[]>>>`, etc.
- Non-empty inline literals (`[1,2,3]`, `{a:1}`) remain illegal as bare values per ADR-0005. A bare value starting with `[` and not equal to `[]` decodes as a plain string.

## Why this doesn't conflict with ADR-0005

ADR-0005 banned inline object/array literals to avoid brace-balancing. We're not adding them back — only the *empty* forms `[]` and `{}` are reserved literals. The parser still rejects nested `[...]` / `{...}` content; only the empty forms are recognized. Nesting must still use path mode.

## Consequences

- `:` separator now only appears in typed leaves (`id:s=42`, `count:n=0`) and table-mode headers (`items::col1,col2`). The bare `key:typecode` form is gone.
- Type set in the spec stays the same (`s, t, n, b`); `z, l, o` are still recognized as type *codes* (in `:s=...`-style explicit forms — though `:z=`, `:l=`, `:o=` have no useful meaning since the value itself is in the literal). For v0.2 prototype, only `s, t, n, b` appear in typed leaves; `z/l/o` are obsolete codes.
- Encoder and decoder both shrink by ~30 lines of code.
