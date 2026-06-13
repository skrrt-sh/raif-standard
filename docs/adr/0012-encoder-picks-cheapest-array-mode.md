# Encoder picks the cheapest emission per array and per nested object

The v0.2 spec defined two specialized modes alongside path mode:

- **Table mode** ([ADR-0008](./0008-table-mode-for-homogeneous-arrays.md)) for arrays of homogeneous flat objects.
- (implicit) **Path mode** as the universal fallback.

With [ADR-0010](./0010-inline-object-form.md) adding **inline-object mode** for arrays of flat objects with mixed key sets and for non-empty nested objects, the encoder now has up to three candidates per array and two per nested object. Static eligibility rules ("use table mode whenever shape X") don't capture the actual cost trade-off. Concretely, in the v0.2 prototype:

- A 2-row, 3-column homogeneous array goes through table mode and saves vs path expansion, but the header `posts::id,likes,title` plus two rows is still 3 token-leaves where path mode is 6 token-leaves of smaller individual size. At N=2 the comparison can flip either way depending on column-name length.
- A 1-row array of an object with 3 primitive fields gives table mode no advantage (ineligible at N<2) and inline-object mode usually wins over path mode.
- A nested object with 3 primitive fields and a long path prefix saves vs path expansion in inline-object form, but a nested object with 1 short-key field doesn't.

## Decision

For each array and each non-empty nested object, the encoder builds every legal candidate (path, table where eligible, inline where eligible), measures their **byte length** (with `\n` separators counted), and emits the shortest. Ties resolve by candidate order (path > table > inline) to keep the wire form stable across encoder runs.

Byte length is used as a proxy for token count. For candidates that share most of their characters (same key names, same primitive cell values, same prefix), byte ordering matches token ordering closely enough for selection — and avoids dragging a tokenizer into the encoder.

## What this is not

- Not a global optimizer. The encoder picks locally per array / per nested object, not across the whole document. Some object shapes have a globally cheaper emission that local choices miss (e.g. promoting a parent prefix into a shared header). That's left to a future ADR if it ever becomes load-bearing.
- Not a tokenizer-aware encoder. Tokenizer-perfect costing would require running a BPE tokenizer per candidate, which adds a dependency the encoder shouldn't carry. Byte length is the cheap proxy.
- Not a guarantee of "always shorter than JSON." Some shapes (small heterogeneous arrays, pathological-key objects) still lose to JSON because JSON's tokenization is unusually compact for those specific patterns. We accept residual losses where the structural floor is above JSON.

## Impact on the corpus

| case | v0.2 selector | v0.3 selector |
|---|---|---|
| array_of_objects (3 rows, 3 cols) | table mode -10% | table mode -10% (unchanged: table beats inline at this size) |
| large_table (10 rows, 4 cols) | table mode -26% | table mode -26% (unchanged) |
| json_heavy (embedded `posts` 2-row + nested `data.user`) | table for posts +3% | table for posts, inline for `data.user` → -7% |
| nested_object | path mode -12% | inline mode for `user` → -20% |
| heterogeneous_array | path mode +63% | inline mode +9% |
| flat_inline_object | (would be path -10%) | inline mode -11% |

The selector also keeps RAIF from regressing on cases where the new modes don't help: e.g. `nested_object` with a 1-key sub-object stays in path mode because inline overhead `={...}` exceeds path-prefix savings.

## Algorithm

```
emit_array(arr, prefix):
    candidates = [as_path(arr, prefix)]
    if eligible_for_table(arr): candidates.append(as_table(arr, prefix))
    if eligible_for_inline(arr): candidates.append(as_inline(arr, prefix))
    pick min by bytes; emit

walk_object(obj, prefix):
    path_leaves = recursive_path_emit(obj, prefix)
    if prefix != "" and eligible_for_inline(obj):
        inline_leaf = encode_inline_object(obj, prefix)
        if bytes(inline_leaf) < bytes(path_leaves): emit inline_leaf; return
    emit path_leaves
```

Inline form is never used at the root of the document because the root must remain path-addressable (the whole point of RAIF's leaf-per-line layout is per-leaf recovery; collapsing the root into one inline-object would defeat that).

## Cost

- Encoder builds up to three string lists per array. The cost is bounded by the size of the array. For documents with very large homogeneous arrays, table mode is built and discarded once per array.
- Byte counting is `O(total chars per candidate)`. Negligible.
- The encoder remains deterministic: given the same input, byte-length comparisons are byte-exact and the order of preference is documented.

## Consequences

- The wire form a model sees for a given JSON object can no longer be predicted from a simple "always use mode X for shape Y" rule — it depends on column-name length, value length, and prefix depth.
- Training data for fine-tuned RAIF emission must include all four wire shapes (path, table, inline-object, plus the optional-nonce multiline) so the model can both *emit* and *consume* them. The selection rule itself is encoder-only; models never need to compute it.
- The encoder rejects no new shapes — every JSON object that round-tripped in v0.2 still round-trips in v0.3. Only the wire bytes change.
- Repair audit: the decoder ignores which mode the encoder picked. All forms decode to the same JSON. The repair pass does not depend on the selection.

## Considered options

- **Static rules per shape (v0.2 status quo)** — rejected: leaves obvious wins on the table.
- **Tokenizer-aware selection** — rejected: introduces a tokenizer dependency in the encoder; not worth it for the marginal accuracy gain.
- **Pick by leaf count, not byte length** — rejected: a 1-leaf inline form of 80 bytes vs a 3-leaf path form of 30 bytes is sometimes shorter in *leaves* but longer in *bytes*; bytes is the right proxy for tokens.
