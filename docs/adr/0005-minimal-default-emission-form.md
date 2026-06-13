# Default emission form is ceremony-free, named, type-inferred

The original spec's default emission carried a per-object header (`!raif/0.1 s=X m=Y`), a `!end` terminator, mandatory type tags on every leaf, and a `<<<NONCE...>>>NONCE` text block for any non-trivial string. For short objects this ceremony cost ~2× JSON's tokens, which contradicts the "token-efficient" pillar. The original spec also exposed three coequal modes (`pos`, `named`, `path`) and asked the caller to choose.

We collapse the default to a minimal form:

1. **No per-object header by default.** The integration context (fine-tuned model + runtime, or caller-supplied parser config) already knows the mode and the expected schema. Header reappears only as opt-in for cross-context replay or mixed-prose emission.
2. **No `!end` marker by default.** Mode markers (`<raif>` / `</raif>`, or special tokens in the fine-tuned stage) close the block at the integration boundary; EOF closes it in raw use.
3. **Bare values with type inference.** `to=x@y.com`, `count=42`, `done=true`. Type tags appear only when inference is ambiguous (`id:s=42` to force a numeric-shaped string).
4. **`␞` (U+241E Record Separator) as the single-token string delimiter** for values containing RAIF-significant characters. The nonce-block form from ADR-0001 survives as the **multiline-only fallback** for values containing newlines or literal `␞`.
5. **Path mode is the only nesting mode.** `user.name=Egor`, `items[0].id=1`. Inline object literals (`user={...}`) are not part of the default form — they would reintroduce brace-balancing, the JSON failure mode RAIF was designed to escape.

## Consequences

- **Named is now the implicit default;** position mode (`1:s=...`) survives only as a niche optimization for schemas with very long field names. For short field names, named beats position once type tags are elided.
- **The `m=` header field becomes mostly vestigial.** Parser infers from leaf shape (path syntax → path mode; plain identifiers → named mode).
- **The `!end` marker is recoverable** for callers who need it (e.g. for archives), but no longer per-object overhead.
- **Multiline values pay the ADR-0001 nonce-block cost only when they're actually multiline.** Single-line strings with special chars use the cheaper `␞` form.
- **Parsers must handle multiple input variants:** with or without header, with or without `!end`, with or without explicit types, with or without `␞`-delimited strings. This is the deliberate "loose model emission, strict canonical interpreter" split — but it widens the parser surface.

## Considered options

- **Keep minified header (`!r0.2`).** Rejected — even 2 tokens of per-object handshake is too many when the integration already knows the contract.
- **Keep `!end` for safety.** Rejected for same reason; runtime framing or EOF is sufficient.
- **Always-typed values for clarity.** Rejected — inference covers the common case and the type tag becomes signal-on-exception, which is sharper than always-noise.
- **Inline object literals as a convenience.** Rejected — reintroduces balancing, contradicts the recovery-locality pillar.

## Open: type inference rules

This ADR establishes the principle. The actual rules for what `42`, `42.0`, `1e3`, `null`, `true`, `12345678901234567890` parse as need their own ADR after grilling.
