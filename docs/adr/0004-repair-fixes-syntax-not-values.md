# Repair fixes syntax, not values

Section 9.1 of the original spec mixed two kinds of repair: **structural** fixes to the RAIF wrapper (markdown fences, missing envelope, wrong separators, field order, missing newlines, length/checksum recovery) and **value** fixes to field contents (enum typo correction, boolean normalization, number locale cleanup). The second category is invention dressed up as repair — it can flip semantics silently, depends on heuristics that vary across implementations and locales, and is precisely where "deterministic, bounded, auditable" stops being true.

We restrict repair to syntax only. If a field value is malformed (wrong enum, garbled number, unrecognized boolean), the parser surfaces a validation error and the caller decides what to do — re-prompt the model, fail the tool call, escalate to a human. The interpreter never mutates field contents.

This gives "deterministic repair" actual meaning: the only thing repair can do is reshape the bytes around the values, never the values themselves.

## Consequences

- The original 9.1 list splits: keep markdown stripping, envelope reconstruction, separator normalization, field reorder, missing-newline, length-recovery, checksum insertion. Drop enum-typo, boolean-normalization, number-cleanup.
- The repair-code enum loses `enum_corrected`, `boolean_normalized`. Keeps the structural codes.
- Models trained on RAIF must emit canonical value forms; the spec defines exactly one canonical form per type. Variant input forms are validation errors, not repair candidates.
- Re-prompting the model on validation failure becomes the standard recovery path. The spec should document the suggested re-prompt structure (echo the validation error back).
- `tool-call` mode safety becomes simpler: any syntax repair below a confidence threshold blocks execution; there are no value mutations to worry about.

## Considered options

- **Keep boolean normalization** (small surface, common variant inputs) — rejected for consistency; one principle is easier to defend than "values mostly never, except for booleans."
- **Keep enum repair with strict Levenshtein-1 + unique-candidate rules** — rejected; even strict rules cross the line into invention, and the user's framing ("fix syntax, not fields") is sharper.
