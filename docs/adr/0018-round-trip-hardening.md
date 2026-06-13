# Round-trip hardening: wrap-rule closure, canonical byte order, deterministic nonces, truncation recovery, lenient decode

Date: 2026-06-13. Status: accepted. Amends ADR-0007 (wrap rules), ADR-0011 (nonce), ADR-0013 (array-literal repair), ADR-0015 (TIER 2-D); enforces ADR-0004.

## Context

A code audit plus a seeded fuzz harness found that `decode(encode(J)) == J` was false for several string classes, that the repair tier violated its own "never touch value bytes" rule, and that the format's core pitch — per-leaf recovery — was unimplemented. All findings reproduced as failing tests before the fixes landed (`prototype/src/raif.test.ts`, "ADR-0018 hardening regressions" + the 500-seed property test).

## Decisions

1. **Wrap-rule closure.** Wrap triggers are decided against the *assembled line*, not the value in isolation. New triggers: a value tail that would make the line a block opener (`…=<<<hex`, `…=<{1,2}hex`, `…=[`, lone `[`) — for leaf strings and table cells; `{` and a non-leading `<<<` anywhere in inline-object/table cells (the comma splitter tracks `{`-depth and `<<<…>>>` ranges, so either desynchronizes the split).
2. **Type-tag form is canonical for protected single-line strings.** `key:s=value` (3 bytes of ceremony) replaces `key=<<<value>>>` (7) whenever tag-safe: value equals its trim, is not `<<<…>>>`-shaped, and has no opener tail. Implements spec §3.6's "shorter form is canonical". Corpus bench moved −13% → −14%.
3. **Canonical order is true UTF-8 byte order** (code-point comparison, not JS UTF-16 code-unit sort), and the cheapest-mode pick measures UTF-8 bytes.
4. **Nonces are deterministic** — FNV-1a over block content, re-hashed on collision. `encode` is byte-deterministic; `validate(encode(x))` and byte-idempotence of `fix` now hold for nonce documents.
5. **Line endings.** Structural CRLF is repaired in two bounded forms only: document-wide CRLF (every line) and trailing `\r` on individual structural lines. `\r` anywhere else is data and round-trips byte-exactly. The encoder's multiline trigger is `\n` only; the old global `\r`→`\n` rewrite (which mutated value bytes) is removed.
6. **TIER 2-D superseded.** A `null` table cell decodes to JSON null, exactly like a bare `null` literal — restoring v0.3 semantics. "Key absent" is a schema-aware concern (ADR-0016). The encoder may now emit null cells in table mode.
7. **Truncation recovery.** An unterminated array literal or multiline block whose closer is missing *and* for which no closer-like line exists downstream is closed at EOF, with `unterminated_*_closed_at_eof` repairs. Ambiguous candidates still refuse (ADR-0004). Supersedes the v0.3 hard error — truncation is the dominant real-world LLM failure.
8. **Strict paths and numbers.** `a[01]`, `a[1x]`, `a[1]b`, `a.`, empty segments are errors (previously coerced silently); a JSON number that overflows a double is a clear error instead of an Infinity crash downstream.
9. **Block-aware repair pre-pass.** Brace flattening skips multiline block interiors and tracks array-literal regions at every level; it can no longer rewrite value bytes (this was an active ADR-0004 violation).
10. **`decodeLenient`** — the per-leaf recovery entry point promised by spec §3.1/§11: never throws, returns `{ value, errors[], repairs[] }`, where each bad leaf is skipped and named. Sparse arrays are pruned with an error rather than failing the document. Intended use: agent runtimes re-ask the model for only the broken fields.
11. **Own-property decoding.** Keys are model-controlled, so the decoder defines own properties (JSON.parse semantics); `__proto__` paths can no longer pollute prototypes.

## Consequences

- 121 tests including a 500-seed (5000 locally) random round-trip property: `decode∘encode` identity, zero repairs on canonical input, `validate`/`fix` agreement, lenient parity.
- Canonical output changed (tag form, UTF-8 order, deterministic nonces, null table cells): training data must be regenerated (done) and the GBNF re-linted (done, 39/39).
- The v0.3 spec is amended in place pending the v0.5 spec; see the amendments note at the top of `raif_v0.3_spec.md`.
