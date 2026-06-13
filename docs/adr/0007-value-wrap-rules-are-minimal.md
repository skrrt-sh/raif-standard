# Value-wrap rules are minimal

An earlier version of the encoder wrapped any string containing `,`, `:`, `[`, `]`, `{`, `}`, or `=` with `<<<...>>>`. This was over-conservative: the parser doesn't actually need those wraps because it locks the key, separator, and value boundaries up front (first top-level `=` or `:` outside `<<<...>>>` ranges). After it has the value, every byte in the value is content. The wrap was costing real tokens (~3 per affected leaf in cl100k_base) for zero parsing benefit.

We restrict value wrapping to **true ambiguities only**:

1. Empty string — `field=<<<>>>`.
2. Leading or trailing whitespace — `field=<<< padded>>>`.
3. Contains `\n`, `\r`, or literal `>>>` — escalates to the nonce-bounded multiline form.
4. Starts with `<<<` — would be misread as a delimiter opener.
5. Equals exactly `null`, `true`, `false`, `[]`, `{}`, or a JSON number literal — would parse as that literal instead of as a string.

Anything else, including strings containing `,`, `:`, `[`, `]`, `{`, `}`, `=`, or RFC-3986 URL chars, goes bare.

## Impact on the corpus benchmark

Cases involving previously-wrapped strings (`text_with_specials`, `numeric_string_ambiguity`, `pathological_keys`, the array_of_objects' contained values) all dropped 5–30 percentage points. Combined with the table-mode change ([ADR-0008](./0008-table-mode-for-homogeneous-arrays.md)) and the sentinel removal ([ADR-0009](./0009-null-and-empty-containers-use-json-literals.md)), the overall benchmark flipped from +24% (RAIF loses) to -8% (RAIF wins).

## Why this is safe

The parser-side guarantee is: a leaf is `key SEP value` where SEP is the first top-level `=` or `:` outside any `<<<...>>>` range. Once SEP is found, value is the rest of the line (or, for multiline blocks, the body up to the nonce closer). Nothing in the value can confuse the parser about where the value ends — that's already fixed by line boundaries.

The five cases above are the only ones where decoding the value back to its semantic meaning becomes ambiguous, and the wrap is the deterministic disambiguator.

## Consequences

- The encoder is shorter and the output is smaller on every string-heavy case.
- Decoder behavior is unchanged — it always knew how to handle bare strings with `,`/`:`/`[`/etc.
- One subtle edge: strings that *happen to look like* `<<<foo>>>` (e.g. someone literally types triple-bracket in their string) now must be wrapped, otherwise the decoder would unwrap them. The "starts with `<<<`" rule handles this — full-wrap means the outer `<<<>>>` is the delimiter and the literal triple-brackets are preserved inside.
