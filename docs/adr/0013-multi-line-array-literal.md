# Multi-line array literal form: `prefix=[\n…rows…\n]`

The v0.3 changes (inline-object form, ADR-0010) collapsed heterogeneous arrays from +63% (RAIF loses badly to JSON) to +9% (RAIF nearly ties). The residual loss has one structural source: **per-row prefix repetition**. Inline-object rows look like

```
events[0]={type=click,target=button#submit}
events[1]={type=view,page=/pricing}
events[2]={type=click,target=a.cta}
```

— and `events[N]=` is paid five tokens at a time per row. JSON shares its array context once (`{"events":[…,…,…]}`) and pays only `,` between rows. RAIF v0.3 had no analogous "say-the-prefix-once" wire form.

## Decision

A non-empty array MAY be emitted as a single multi-line literal:

```
events=[
{type=click,target=button#submit}
{type=view,page=/pricing}
{type=click,target=a.cta}
]
```

- Opener: a leaf whose value after `=` is exactly `[` (the line ends with `=[`). The key is the array path.
- Body: each subsequent non-blank line is one array element. Blank lines are ignored (whitespace tolerance for repair).
- Closer: a line equal to `]`.
- Elements may be primitives (`42`, `true`, `null`, bare or wrapped strings) or flat inline-object literals (`{key=val,…}`). Nested arrays are not allowed inside a literal; arrays-of-arrays fall back to path mode.

Tokens for the running corpus example (`heterogeneous_array`, 3 rows × mixed keys):

| form | RAIF tokens | Δ vs JSON (32) |
|---|---:|---:|
| path mode (v0.2) | 52 | +63% |
| inline-object per row (v0.3) | 35 | +9% |
| **array literal (v0.4)** | **29** | **-9%** |

`heterogeneous_array` finally drops below JSON.

## Choice of syntactic form

Two shapes were considered:

**A. Shared-prefix header `prefix::*` + `[N]={…}` rows**

```
events::*
[0]={type=click,target=button#submit}
[1]={type=view,page=/pricing}
[2]={type=click,target=a.cta}
```

The `::*` header declares an "implicit prefix"; rows are addressed with just `[N]={…}` and the parser keeps `events` as ambient state. Reuses the existing `::` separator syntax (table-mode header).

**B. Bracket literal `prefix=[…rows…]` (this ADR)**

The shape above.

**Why B:** explicit boundaries (`[` opens, `]` closes) make the array's extent locally observable. Variant A requires the parser to carry ambient state ("the active prefix") that lives outside any single line — a bad fit for RAIF's leaf-per-line locality and a worse fit for repair under truncation (a missing `::*` header silently re-attributes its rows to no array, and a row `[0]={…}` is an *error* outside an implicit-prefix context). The bracket form also works uniformly for arrays of primitives, not just arrays of objects, with no schema-flavored decision encoded in the opener.

Variant A would have saved one to two tokens per emission by dropping the per-row prefix entirely, where bracket form pays the prefix once in the opener. We chose B regardless because the repair / locality story is cleaner; the bench delta is essentially the same.

## Eligibility

The encoder may emit the array-literal form when every element is:

- a primitive (string, number, boolean, null) with no `\n` / `\r`, OR
- a flat inline-object (the eligibility used by [ADR-0010](./0010-inline-object-form.md)).

If any element is a nested array or a non-flat object, the encoder falls back to path mode.

## Cost-aware selection

The array-literal form joins the cost-aware selection from [ADR-0012](./0012-encoder-picks-cheapest-array-mode.md). For each array the encoder builds every legal candidate (path / table / inline-object-per-row / array-literal) and emits the shortest. Cross-over points observed on the corpus:

- 2–3 row inline-eligible arrays: literal beats inline-object per row.
- Homogeneous tables with **short** column names: literal also wins at small N (≤ ~6 rows). Table mode reclaims the lead at large N because the header amortizes (see `large_table` at 10 × 4 cols, still -26% via table mode).
- Homogeneous tables with **longer** column names: table mode wins sooner because the per-row savings (table omits keys, literal repeats them) outweigh the header cost.
- Primitive arrays at long paths (`data.session.actions[N]=…`): literal wins clearly; the shared prefix is paid only once.

## Disambiguation

Two grammar collisions to avoid:

1. A string value equal to `[` would be read as an array opener (`s=[`). Encoder now wraps single-char `[` strings: `s=<<<[>>>`.
2. A string row literally `]` inside an array literal would close the array early. Encoder wraps `]` row values: `<<<]>>>`.

No new escape rules elsewhere. A string value `[1,2,3]` or `[anything-not-just-[]` still emits bare; the array opener requires the value to be **exactly** `[` (line ends with `=[`).

## Repair

- **Missing `]` closer.** The decoder currently throws on `unterminated array literal`. A future repair could synthesize a `]` at the next top-level-looking line. Deferred — the current pass is strict and ambiguous repair is worse than reporting the error.
- **Blank lines inside the literal.** Ignored (treated as separators only). Models often pad output; we don't punish them.
- **Stray `]` outside any literal.** Parsed as a normal leaf and almost certainly fails as malformed. Acceptable.

## Failure-mode comparison

| failure | path mode | array literal |
|---|---|---|
| one bad element | only that leaf is lost | only that row line is lost (within the literal) |
| truncated mid-array | all complete leaves recoverable | unterminated literal → whole array lost |
| bad opener (`=[ ` with trailing space) | n/a | parse fails, whole array lost |

Trade-off: the literal collapses one independence axis (the array boundary) into two lines (opener / closer). In exchange you save tokens and gain a more JSON-like surface that models emit fluently. Acceptable for the common case; path mode is always available as a fallback.

## Impact on the corpus

| case | v0.3 (inline-object) | v0.4 (array literal) |
|---|---:|---:|
| heterogeneous_array | +9% | **-9%** |
| wide_heterogeneous_array | +5% | **-8%** |
| json_heavy (nested `posts` 2-row) | -7% | **-12%** |
| null_and_empties (`tags`) | ±0% | **-21%** |
| deep_array_literal (new) | (would be ~-2%) | -13% |
| long_primitive_array (new) | (would be ~+5%) | ±0% |
| **overall (18-case corpus)** | -11% | **-13%** |

`pathological_keys` still loses at +7% — the structural floor there is the per-key `<<<>>>` wrap overhead, which neither the inline-object form nor the array literal touches. A root-level inline form would help but was rejected in [ADR-0010](./0010-inline-object-form.md) (root must stay path-addressable).

## Consequences

- The wire grammar gains one new leaf shape (`array_literal`) in addition to bare / typed / multiline / table-header / table-row / inline-object. Eight surface forms total.
- The parser gains a new opener-regex check (`/^(.+)=\[$/`) before the existing nonce-opener check.
- The encoder's array-emission selector now has four candidates per array.
- The encoder's string-wrap rules gain one new trigger (`v === "["`).
- LLM emission: the form is JSON-array-shaped (`key=[\n…\n]`), which models in our experience produce fluently when shown two examples. Less novel to memorize than the `::*` shorthand.

## Considered options

- **Shorthand `prefix::*` + `[N]={…}` rows.** Rejected for locality reasons (above).
- **Inline single-line array `key=[a,b,c]`.** Rejected: collides with the bare string grammar (today `s=[anything]` is a string); fixing the collision would force wraps on a much larger class of strings. The multi-line form preserves the existing string grammar exactly because the opener requires `=[$` (end-of-line).
- **Make the closer `]\n` mandatory at end of file.** Rejected: adding a global closer rule complicates repair and means the parser can't decide closure until end-of-document.
