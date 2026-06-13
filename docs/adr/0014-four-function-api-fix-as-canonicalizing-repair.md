# Four-function API: `encode` / `decode` / `fix` / `validate` (with `fix` as canonicalizing repair)

The v0.3 prototype exposes two functions: `encode(JSONObject) → string` and `decode(string) → JSON-or-error`. Repair is buried inside `decode` — markdown fence stripping, line-ending normalization, mode-marker stripping, multi-line brace flattening, separator coercion, mismatched-nonce recovery, and (after Track 1) the deterministic TIER 2 extensions all run as opaque pre-parse phases.

Two problems with this:

1. **No way to use RAIF without going to JSON.** A caller who wants to repair a damaged RAIF document and persist the *fixed RAIF* (not the JSON projection) has no API for it. They'd have to `decode → encode`, which performs a needless JSON round-trip and erases any RAIF-side properties (canonical leaf order, type-tag form choices) that don't survive the JSON detour.
2. **No way to ask "is this canonical?"** A caller who has already canonical RAIF and wants a fast "yes/no it's parseable as-is" check has no read-only path — they pay the full `decode` cost just to discover their input was already clean.

## Decision

The v0.4 public API has four functions, each with one purpose:

```ts
// JSON ↔ RAIF
encode(obj: JSONObject): string
  // JSON → canonical RAIF. Unchanged from v0.3.

decode(raif: string): DecodeResult
  // RAIF → JSON. Composition: fix → parse → toJson.
  // External semantics unchanged from v0.3.

// RAIF ↔ RAIF (new in v0.4)
fix(raif: string): FixResult
  // Pure RAIF → canonical RAIF. Applies every deterministic repair
  // (TIER 1 + TIER 2). Returns { ok: true, canonical, repairs }
  // or { ok: false, errors, partialCanonical? }. No JSON involved.

validate(raif: string): ValidationResult
  // Pure read-only check. Returns { ok: true } if the input is already
  // canonical, else { ok: false, errors }. Never mutates; never repairs.
  // Useful as a fast pre-check before fix for callers that expect to
  // receive canonical input on the happy path.
```

Intermediate types (`RaifTree`, `parse`, `toJson`, `fromJson`) stay **internal** for v0.4. They may be promoted to public API in v0.5 if a real caller wants to build trees programmatically.

## `fix` is both repair and canonicalization

`fix` always produces canonical RAIF — sorted leaves, normalized whitespace, every legal repair applied, byte-identical output for any input that reduces to the same JSON value (modulo random multiline nonces).

Rejected alternative: split into `fix` (only-repair, preserves leaf order) + `canonicalize` (sort, normalize). Reasoning for the merge: it gives one answer to "what does this function do?" — *"give me the canonical RAIF representation of this input."* Order-preserving repair is a niche concern (audit logs that need to show the model's original leaf order); it can be built on top by callers who need it, by running a custom leaf-extraction pass against the input and then re-applying ordering. The 90% case is "I have messy RAIF, give me clean RAIF" and one function serves that cleanly.

## `decode` is `fix` then `parse` then `toJson`

The composition is the entire definition. This means:

- Any change to TIER 2 repair behavior is automatically reflected in `decode`.
- `decode` and `fix` agree on which inputs are repairable — never one accepting and the other rejecting.
- The test suite gains a coverage shortcut: a property test that `decode(raif) ≡ toJson(parse(fix(raif).canonical))` for all repairable inputs.

## Why split now, not at v0.5

The Track 1 work expands repair from surface-level (`stripMarkdownFences`, `flattenMultilineBraces`) to structural-level (repeated-key auto-indexing, sparse-table accept, nested-inline flattening, leading-zero coercion). The repair surface grows. Without the split, the only entry point to that surface is `decode`, which forces every caller through JSON. The split is a prerequisite for Track 1 to be useful to non-JSON callers — chiefly any tooling that wants to *inspect* or *re-emit* repaired RAIF without losing wire-form precision.

## Consequences

- `prototype/src/raif.ts` gains `fix`, `validate`, and an internal `parse` (operating only on canonical RAIF). The existing `decode` is rewritten as `fix → parse → toJson`.
- Tests gain a `fix.test.ts` exercising the RAIF→RAIF property: idempotence (`fix(fix(x)).canonical === fix(x).canonical`), totality (every repairable input has exactly one canonical output), JSON-faithfulness (`toJson(parse(fix(x).canonical)) ≡ decode(x).value`).
- `validate(x).ok === true` ⟹ `fix(x)` is a no-op (the canonical form is `x` itself).
- The harness in `prototype/src/harness.ts` continues to use `decode` for scoring; no harness change required.
- The spec gets a new `§11 API surface` section documenting the four functions. The `canonicalizeRaifR` function mentioned in v0.3 §11 is replaced by `fix` (with note that `fix` does what `canonicalizeRaifR` was intended to do, plus repair).

## Considered alternatives

- **Status quo — repair hidden inside `decode`.** Rejected: no RAIF→RAIF path for tooling; no fast canonicality check.
- **Three functions: `encode` / `decode` / `repair` (no `validate`).** Rejected: callers who only want to know "is my input clean?" still pay the full repair pipeline. `validate` is cheap by being read-only.
- **Five functions: split `fix` into `repair` + `canonicalize`.** Rejected: the merged form has one clear purpose ("give me canonical RAIF") and matches the 90% case.
- **Expose `RaifTree` publicly in v0.4.** Rejected: commits us to a tree-API surface we don't have a use case for. Defer to v0.5 once the LoRA workstream gives us concrete needs (e.g., schema-aware tree manipulation).
