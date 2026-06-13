# Text-block delimiters use ASCII `<<<` / `>>>` with a per-block nonce when needed

RAIF text blocks need a delimiter that survives arbitrary embedded payloads — including code, Markdown, and RAIF examples that legitimately contain `>>>`. Length prefixes are hostile to grammar-constrained decoding and force the model to count bytes; whitespace-significant indentation conflicts with the line-oriented RAIF syntax. We use ASCII `<<<` (opener) and `>>>` (closer) with a per-block random hex nonce **only when the value forces it** — i.e. when the value contains `\n`, `\r`, or a literal `>>>`. Bare delimited form (`<<<value>>>`, no nonce) handles the common single-line case at minimum cost.

**Empirical note (2026-05-16):** an earlier iteration of this ADR used U+241E (`␞`, RECORD SEPARATOR) as a single-token delimiter on the assumption that modern BPE tokenizers fold it to one token. Prototype probing against cl100k_base showed `␞` is actually **3 tokens** (its three UTF-8 bytes each tokenize separately), and `␞␞␞` is **9 tokens** — six tokens of overhead per single-line delimited string, eighteen per nonce-bounded multiline block. `<<<` and `>>>` both tokenize as **1 token** in cl100k_base. Reverting to ASCII delimiters dropped the overall benchmark from +24% (RAIF vs JSON) to +13% across the prototype corpus; cases involving string delimiters (text_with_specials, multiline_body, pathological_keys, numeric_string_ambiguity) flipped from large losses to ~parity or wins. The remaining +13% is concentrated in the array-of-objects case (+78%) — a structural problem with path mode that the delimiter choice doesn't touch (tracked separately).

## Forms

- **Bare single-line delimited:** `field=<<<value>>>` — used when the value contains a RAIF-significant character, leading/trailing whitespace, or looks like a literal. Two tokens of delimiter overhead per string, matching JSON's `"..."`.
- **Nonce-bounded:** `field=<<<NONCE\n...\n>>>NONCE` — used when the value contains `\n`, `\r`, or a literal `>>>`. The nonce is a short hex string randomly generated per block by the encoder; collision probability is ~1/65 536 for 4-hex-char nonces.

## Considered options

- **Original fixed `<<<` / `>>>` without nonce for multiline** — rejected; realistic payloads (bash here-strings, Markdown blockquotes, RAIF training data) contain `>>>` and would corrupt the closer when the value spans multiple lines. The nonce-bounded form covers this. The non-nonce form is still used for single-line strings that happen not to contain `>>>` (encoder verifies before choosing).
- **Length-prefixed text in RAIF-G** — bulletproof but models are bad at counting bytes and grammar-constrained decoding doesn't enforce length prefixes well (spec Section 12 caveat).
- **Indentation-bounded blocks (Python-style)** — collision-free but introduces whitespace-significant syntax that conflicts with RAIF's line orientation.
- **U+241E `␞` "single-token" delimiter** — *initially adopted*, then reverted after empirical probing showed it's 3 tokens in cl100k_base. The assumed compactness didn't hold.
- **Forbid `>>>` in values, require base64 escape** — violates Design Goal #5 (no escaping by default) and bootstrapping breaks for any tool that emits RAIF examples.

## Consequences

- The encoder picks the cheapest form for each string: bare > `<<<value>>>` > `<<<NONCE\n...\n>>>NONCE`. Models follow the same rule.
- Pathological keys reuse the same delimiter: `<<<user.email>>>=value`.
- Keys containing literal `<<<` or `>>>` are rejected by the encoder (no escape mechanism). This is acceptable — such keys are vanishingly rare in real JSON.
- The remaining structural weakness (array-of-objects path-mode bloat) is independent of this decision and needs its own treatment.

## Considered options

- **Fixed `<<<` / `>>>`** — original spec; rejected because realistic payloads (bash here-strings, Markdown blockquotes, RAIF training data) contain `>>>`.
- **Length-prefixed text in RAIF-G** — bulletproof but models are bad at counting bytes and grammar-constrained decoding doesn't enforce length prefixes well (Section 12 caveat).
- **Indentation-bounded blocks (Python-style)** — collision-free but introduces whitespace-significant syntax that conflicts with RAIF's line orientation.
- **Forbid `>>>` in values, require base64 escape** — violates Design Goal #5 (no escaping by default) and bootstrapping breaks for any tool that emits RAIF examples.

## Consequences

- The header must carry the nonce (open question: separate `n=` field vs. reusing `id=`).
- Models must reliably copy the nonce from the header to every text-block delimiter. Mis-copied nonces are a new failure mode — but a locally-detectable one (parser knows the expected nonce, can scan for near-matches).
- Collision probability is ~1/65k per text block; for objects with many text blocks, may need to widen to 6+ hex chars or rotate per block.
- Bootstrapping: RAIF examples in training data must use varying nonces so the model learns to copy rather than memorize a specific value.
