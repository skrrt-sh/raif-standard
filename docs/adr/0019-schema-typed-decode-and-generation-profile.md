# Schema-typed decode mode and the generation profile

Date: 2026-06-13. Status: accepted. Builds on ADR-0016 (schema-as-parity) and ADR-0018; refines ADR-0012's scope to the canonical profile; realizes the §3.2 schema declaration from `fine_tune_plan.md`.

## Context

The format audit identified the two highest-leverage format-level changes: (1) every harness run shows the dominant fidelity failures are semantic encoding decisions pushed onto the model (wrap-when-literal, pathological keys) — decisions a known schema can make instead; (2) the cheapest-mode pick asks a model to replicate a byte-cost optimizer, and canonical sort places large text blocks early, which is truncation-adversarial. Measured at equal token budgets, canonical RAIF recovered 43.0% of leaves under truncation vs 40.8% for JSON+jsonrepair — too close for a format whose pitch is resilience.

## Decision 1 — schema-typed decode

`decode` / `decodeLenient` / `fix` / `validate` accept an optional schema (a parsed `RaifSchema` or declaration text; `<schema>` wrapper tags are accepted verbatim). Declaration syntax is the plan §3.2 form: `to:s`, `tags[]:s`, `items[].id:n`, `user.handle:s`, `note:s?`, `items[]:o`, `<<<a.b>>>:s`.

With a schema, **types come from the schema, not value-shape inference**:

- `s`/`t` fields take the raw bytes verbatim — `placeholder=null` is the string `"null"`, `priority=2` under `priority:s` is `"2"`. A `<<<…>>>` wrap still unwraps (it is transport, not type assertion). This removes the wrap-when-literal ambiguity class by construction.
- `n`/`b` fields must parse, or surface a validation error — never coerced (ADR-0004). Re-prompting remains the recovery path.
- Bare `null` under an optional field (`note:s?`) is JSON null; under a required field it is data (`"null"`). The tagged form (`note:s=null`) is always the string.
- The schema wins over a conflicting wire tag (`id:n=42` under `id:s` → `"42"`): the tag is the model's assertion, the schema is ground truth.
- `o` declares open structure: declared children are still typed; *undeclared* children are allowed and inferred. `o` without children is plain inference.
- Required fields (no `?`) must be present after assembly — including inside array elements; unknown fields/columns are validation errors.
- **Pathological-key recovery (the ADR-0016 payoff):** an unwrapped dotted key (`user.email=…`) that fails path resolution but matches a declared flat root field resolves to it, recorded as `pathological_key_resolved`. Cell keys (inline objects, table columns) match declared names directly, so pathological keys there need no recovery at all.

Verified against the full regenerated training set: 1,534/1,534 schema blocks parse, and schema-typed decode of every completion reproduces the exact source JSON.

## Decision 2 — generation profile

`encode(obj, { profile: "generation", markers?: true })` is the form models are trained to emit. Canonical (default) is unchanged: cheapest-mode pick, full sort — the transport/audit form (`fix` always outputs it).

- **Deterministic mode rules, no cost comparison**: arrays use table when eligible, else array literal, else path; nested objects always use path (never the collapsed inline form). A model can learn a fixed precedence; it cannot replicate a byte-length optimizer — ADR-0012 is hereby scoped to the canonical profile.
- **Truncation-optimal ordering**: single-line leaves first, then table units, then array literals, then multiline blocks; canonical order within each class. The decoder accepts any order, so this is free.
- **Optional mode-marker framing** (`<raif>` … `</raif>`): a missing closer is the truncation signature. `decodeLenient` exposes `truncated: boolean` (missing closer, or any block/literal closed at EOF). Markers are recognized only as whole lines at the document edges — a marker token glued to content is data (the global strip was another silent value-corruption vector, now fixed along with the stateful `/g`-regex detection bug).

Measured on the corpus at equal token budgets: generation profile −12.2% tokens vs minified JSON (canonical: −14.4%) and **47.3% leaf recovery under truncation vs 40.8% for JSON+jsonrepair**. Both headline claims — cheaper than JSON and more resilient than JSON — now hold simultaneously on the same emission form.

## Consequences

- Dataset completions are generated with the generation profile (markers off — they are runtime framing and would skew the token-Δ metric per ADR-0017); heterogeneous-array schema declarations now mark partial union fields optional.
- The GBNF accepts both profiles and optional marker framing (lint: 58/58).
- The eval harness may now also score schema-typed decode for tool-call-style shapes; the acceptance-gate metrics in plan §1 remain defined on schema-free decode until re-baselined.
- Tests: 153, including schema/profile slices and the extended 500-seed property (generation profile round-trip + marker-content adversaria).
