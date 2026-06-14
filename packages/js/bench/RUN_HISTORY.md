# RAIF prototype — token-saving iteration log

Historical run notes from the prototype phase that produced the encoder. These
record how the cost-aware encoder converged to ~14% fewer tokens than JSON across
the 18-shape corpus. Reproduce the current numbers with `bun run bench/bench.ts`
(or `bun bench`).

## Notes / answers from sessions

### Run 5 — 2026-05-16 (v0.3 + ADR-0013)

After adding the multi-line array literal form (`prefix=[\n…rows…\n]`) as a 4th candidate in the cost-aware selector:

| case | run 4 | now |
|---|---:|---:|
| short_tool_call | -12% | -12% |
| scalars_mixed | -12% | -12% |
| nested_object | -20% | -20% |
| array_of_objects | -10% | -10% |
| text_with_specials | -11% | -11% |
| multiline_body | -9% | -9% |
| null_and_empties | ±0% | **-21%** |
| pathological_keys | +7% | +7% |
| numeric_string_ambiguity | ±0% | ±0% |
| deep_nesting | -50% | -50% |
| json_heavy | -7% | **-12%** |
| large_table | -26% | -26% |
| heterogeneous_array | +9% | **-9%** |
| literal_strings | -9% | -9% |
| wide_heterogeneous_array | +5% | **-8%** |
| flat_inline_object | -11% | -11% |
| deep_array_literal (new) | — | -13% |
| long_primitive_array (new) | — | ±0% |
| **overall (18 cases)** | — | **-13%** |
| overall (16 cases from run 4) | -11% | **-14%** |

**Biggest swings:**
- `heterogeneous_array`: +9% → -9% (the structural floor identified in ADR-0010 has been crossed)
- `wide_heterogeneous_array`: +5% → -8%
- `null_and_empties`: ±0% → -21% (the `tags` array is now a literal)
- `json_heavy`: -7% → -12%

**Test status:** 18/18 round-trip, 18/18 idempotent, 60/60 property tests. Zero TS diagnostics.

**Remaining loss:** `pathological_keys` (+7%) — small object where 2 of 3 keys need `<<<>>>` wrapping. Object is too small for any of the four array/object compression forms to help. Root-level inline form (rejected per ADR-0010 — root must stay path-addressable) would close it.

### Run 4 — 2026-05-16 (v0.3)

After ADR-0010 (inline-object form), ADR-0011 (optional multiline nonce), ADR-0012 (cheapest-mode pick), and an expanded repair pass (mode-marker strip, separator coercion, mismatched-nonce recovery):

| case | run 3 | now |
|---|---:|---:|
| short_tool_call | -12% | -12% |
| scalars_mixed | -12% | -12% |
| nested_object | -12% | **-20%** |
| array_of_objects | -10% | -10% |
| text_with_specials | -11% | -11% |
| multiline_body | +2% | **-9%** |
| null_and_empties | ±0% | ±0% |
| pathological_keys | +7% | +7% |
| numeric_string_ambiguity | ±0% | ±0% |
| deep_nesting | -50% | -50% |
| json_heavy | +3% | **-7%** |
| large_table | -26% | -26% |
| heterogeneous_array | +63% | **+9%** |
| literal_strings | -9% | -9% |
| wide_heterogeneous_array (new) | — | +5% |
| flat_inline_object (new) | — | -11% |
| **overall (16 cases)** | — | **-11%** |
| overall (12 v0.2 cases only) | -8% | **-13%** |

**RAIF now wins by -13% on the v0.2 corpus and -11% on the expanded v0.3 corpus.** Test status: 16/16 round-trip, 16/16 idempotent, 54/54 property tests pass.

**Biggest single swing:** `heterogeneous_array` flipped from +63% (RAIF loses badly) to +9% (RAIF nearly ties JSON) via the inline-object form (ADR-0010). The +9% residual is structural — JSON's `,` row separator is cheaper than RAIF's `\nprefix[N]=` and we don't yet share the array prefix across rows.

**Repair tests added:** mode-marker stripping, separator coercion (`:` → `=`), mismatched-nonce recovery, and refusal-to-repair when the recovery is ambiguous.

**Remaining losses:**
- `pathological_keys` (+7%) — small 3-key object where 2 keys need `<<<>>>` wrapping. Object-too-small for inline-object to help.
- `wide_heterogeneous_array` (+5%) — 5-row mixed-key array. Path-prefix repetition is the floor; a future array-mode header (`mixed::*`) could close this.
- `heterogeneous_array` (+9%) — same structural cause, smaller payload.

**Not measured here:** LLM-generated RAIF reliability, repair-robustness under corruption, other tokenizers (Gemma, Llama, Qwen). Tracked in handoff.

### Run 3 — 2026-05-16

After (A) drop sentinels + (B) relax value-wrap + (C) table mode (ADR-0007, ADR-0008, ADR-0009):

| case | original | after delim swap | now |
|---|---:|---:|---:|
| short_tool_call | -12% | -12% | -12% |
| scalars_mixed | -10% | -10% | -12% |
| nested_object | -12% | -12% | -12% |
| array_of_objects | +78% | +78% | **-10%** |
| text_with_specials | +25% | +3% | **-11%** |
| multiline_body | +30% | -2% | -2% |
| null_and_empties | +16% | +16% | **±0%** |
| pathological_keys | +37% | +7% | +7% |
| numeric_string_ambiguity | +30% | +3% | **±0%** |
| deep_nesting | -50% | -50% | -50% |
| json_heavy | +37% | +37% | **+3%** |
| large_table (new) | — | — | **-26%** |
| heterogeneous_array (new) | — | — | +63% |
| literal_strings (new) | — | — | -9% |
| **overall** | **+24%** | **+13%** | **-8%** |

**RAIF now wins on average (-8%).** Test status: 14/14 round-trip, 14/14 idempotent, 34/34 property tests pass.

**Remaining losses:**
- `heterogeneous_array` (+63%) — arrays of objects with different key sets. Structurally hard: no shared schema, path mode emits one leaf per (row, field) without any compression opportunity. Likely acceptable: tool-call args and API responses rarely have this shape.
- `pathological_keys` (+7%) — small object where keys need wrapping. Newline-per-leaf overhead dominates.
- `json_heavy` (+3%) — embedded 2-row array doesn't fully amortize table mode header. Larger arrays win clearly (see `large_table`).

**Not measured here:** LLM-generated RAIF reliability, repair-robustness under corruption, other tokenizers (Gemma, Llama, Qwen). Tracked in handoff.

### Run 2 — 2026-05-16

Swapped `␞` → `<<<` / `>>>` delimiters after probing cl100k_base showed `␞` was 3 tokens, not 1. Dropped overall from +24% to +13%; flipped four delimiter-driven cases from RED to ~tied. Recorded in ADR-0001 amendment.

### Run 1 — 2026-05-16

Initial encoder/decoder built per the v0.2 spec. All 11 original corpus shapes round-tripped cleanly. Bench showed RAIF +24% vs JSON, which prompted the next two iterations.
