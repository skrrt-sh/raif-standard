# Fine-tune integration philosophy: light SFT/LoRA + GBNF bonus, BYO base, 3B target

The first OpenRouter sweep (6 models × 18 shapes × 2 trials) drew a clear empirical line at the ~20B parameter mark: `gpt-oss-20b` hit 100% parse / 83% fidelity for RAIF (essentially matching JSON at 100/100); models in the 1B–8B range sat at 64–89% parse / 42–53% fidelity. The few-shot prompt is sufficient at 20B+ and *barely* sufficient at 8B; below that, prompt-engineering alone has hit a ceiling.

Two paths forward beyond prompt engineering:

1. **Train a model to emit RAIF natively** — bypass the few-shot prompt entirely.
2. **Constrain the model's output at decode-time** — force valid RAIF via grammar-constrained decoding (GBNF on llama.cpp, xgrammar on vLLM).

These are complementary, not exclusive. v0.4 chooses an integration philosophy that combines them in a specific way, calibrated to RAIF's "lightweight standard" identity.

## Decision

**Tier 1 (primary): SFT/LoRA, no tokenizer changes.** A LoRA adapter trained on `(JSON-request, RAIF-output)` pairs teaches a base model to emit RAIF natively. No special-token registration, no base-model retraining. The LoRA can be attached to any compatible base or merged into it. Published as a HuggingFace adapter; users BYO base.

**Tier 2 (bonus): GBNF / xgrammar grammar files alongside the LoRA.** For runtimes that support grammar-constrained decoding (llama.cpp, vLLM, mlc-llm), a published GBNF file makes invalid RAIF syntax *literally impossible* to emit. Eliminates parse errors entirely; doesn't help with semantic ambiguity (a string-typed field decoded as null literal is still wrong even if syntactically valid). Optional — works without it, better with it.

**Tier 3 (deferred): special-token registration, full fine-tune.** Registering `<|raif_start|>` / `<|raif_end|>` (and possibly `<<<` / `>>>` as atomic tokens) in the tokenizer is technically the most powerful integration, but it requires vendor cooperation (Meta, Mistral, etc.) or base-model retraining. Premature without a vendor partner. Re-evaluated post-v0.5.

### Target model tier: 3B class

Initial training target is **Llama-3-3B-Instruct** (or equivalent commodity 3B base). Rationale:

- 7B-base models already nearly match JSON on RAIF emission with the current few-shot prompt; the marginal gain from a LoRA at 7B is modest.
- 1B-base models are an aspirational stretch — the format-following task may not converge cleanly at that scale without DPO + adversarial focus + significant engineering.
- 3B is the on-device / edge sweet spot: large enough to converge reliably on format-following, small enough to be the meaningful RAIF use case (RAIF's token win matters most where total token budget is constrained, which is exactly the small-model context).

### Acceptance criteria

The v0.5 LoRA ships when:

- **Parse rate ≥ 98%** at 3B-LoRA across the corpus (matches 7B-base JSON parse rate ~94–100%).
- **Fidelity rate ≥ 95%** at 3B-LoRA across the corpus (matches 7B-base JSON fidelity rate ~72–100%, hits the upper end).
- **Token win preserved**: RAIF tokens ≤ 0.92× JSON tokens averaged across the corpus (preserves the −8% or better wire-format win at 3B-LoRA).
- **No regression on held-out shapes**: 3–5 corpus shapes withheld from training, evaluated at the same parse/fidelity rates as in-training shapes.

Falling short of any criterion triggers a recipe iteration (DPO addition, adversarial-focus rebalancing, schema-declaration prompt redesign), not a release.

### Inference-time prompt strategy

The fine-tuned model is **prompt-free by default**. The chat template request alone (e.g., `"Reply with {to:..., subject:..., priority:...} as RAIF"`) is sufficient. The current prompt's spec block (~140 tokens) and three few-shot examples (~250 tokens) are removed.

For schema-known calls (tool calls, function calling), an optional compact **schema declaration** is appended to the request:

```
<schema>
to:s
subject:s
priority:n
body:s
</schema>
```

The schema declaration uses RAIF-native path syntax with type codes (`:s`, `:n`, `:b`, `:t`) — consistent with the rest of the format, ~10× more token-efficient than embedding a JSON-Schema or Zod block. The declaration format is specified in detail in the v0.5 spec section §14.

This removes ~400 tokens of prompt overhead per call — converting RAIF from "more expensive than JSON when you count the prompt" to "cheaper than JSON end-to-end per call." The inference-time win is potentially larger than the wire-format win.

## Why LoRA over full fine-tune

- **Portability.** A LoRA adapter is ~10–100 MB; a full fine-tune is the full base model size. Users can pull the adapter once and attach it to whatever base they already have.
- **Composability.** A user with their own task-specific LoRA can stack RAIF-LoRA on top; full fine-tuned weights would conflict.
- **Maintenance.** When a new base model lands (e.g., Llama-4-3B), re-training a LoRA against it is cheaper than re-fine-tuning the full model.
- **Risk.** A LoRA that misbehaves can be detached. A merged fine-tune is permanent.

The trade-off: LoRA adapters sometimes underperform full fine-tunes on out-of-distribution inputs. For the format-following task RAIF cares about, this is unlikely to bite — the task is narrow and well-defined.

## Why GBNF/xgrammar as a bonus, not a requirement

GBNF (llama.cpp's grammar format) and xgrammar (vLLM's equivalent) let the runtime constrain the model's output to match a context-free grammar. For RAIF this means the model literally cannot emit invalid syntax — parse rate goes to 100% by construction.

But:

- Grammar files are runtime-specific. Publishing them ties us to specific runtimes; users on other inference stacks (TGI, MLC, OpenAI API, Anthropic API) don't benefit.
- Grammars constrain syntax, not semantics. The model can still emit `placeholder=null` when the field is supposed to be a string — the grammar is satisfied.
- Maintaining a GBNF that exactly matches the RAIF spec across spec revisions is real work.

So GBNF/xgrammar files ship alongside the LoRA as a "use this if your runtime supports it" bonus. Most reliability comes from the LoRA; the grammar files close the residual parse-error gap for runtimes that allow it.

## Why 3B and not 7B / 1B

| target | pros | cons | verdict |
|---|---|---|---|
| 1B-LoRA | edge / browser / phone deployment | format-following may not converge; aggressive recipe needed; uncertain ship date | stretch goal post-3B |
| 3B-LoRA | sweet spot for on-device / edge; format-following converges cleanly; ships in ~2 weeks | smaller addressable audience than 7B in the OSS community (changing fast) | **target** |
| 7B-LoRA | most-used OSS base; biggest user base; safest convergence | 7B-base already nearly works with prompts — marginal value-add | secondary release after 3B ships |
| 14B+ LoRA | best reliability | RAIF's token win matters less; users at this scale are usually not bottlenecked by tokens | skipped |

After 3B ships and validates the recipe, scaling sideways to 7B is a re-run of the same training pipeline. Scaling down to 1B is a recipe iteration (DPO, more adversarial data, possibly tokenizer surgery).

## Dataset construction (high level)

Detailed dataset design lands as part of the v0.5 implementation work. Sketch:

- **Synthetic from corpus + encoder × variation.** Take the 18 corpus shapes, generate 100–500 variations per shape (different field names, value lengths, array sizes, nesting depths). Encode each with the current RAIF encoder. Yields ~5k–10k `(JSON, RAIF)` pairs.
- **Adversarial focus on the four hard shapes.** Extra weight on `pathological_keys`, `numeric_string_ambiguity`, `heterogeneous_array`, `deep_array_literal` — both standard variations and intentionally-malformed examples (so the model learns the right wrap rules under adversarial conditions).
- **No real tool-call traces in v0.5.** Synthetic is sufficient for the format-following task; real-data scraping (OpenAI function-calling logs, etc.) is deferred to a possible v0.6 if v0.5 falls short.
- **Eval set: 3–5 held-out corpus shapes.** Never seen during training; evaluated at every epoch.

Total dataset target: 10k–20k examples. Training time on commodity GPU (single A100 or H100): hours, not days.

## Roadmap dependency

This ADR sits in a dependency chain established by the v0.4 grilling:

1. Ship Track 1 ([ADR-0015](./0015-deterministic-decoder-repair-tier.md)).
2. Re-run the OpenRouter harness; quantify the residual.
3. Decide on Track 2 markers (separate ADR, conditional on the data).
4. Run the tokenizer-breadth gate (soft gate: measure Δ per tokenizer, document, proceed).
5. Build the dataset, train the 3B-LoRA, publish the adapter + GBNF — this ADR.

Each gate produces data that informs the next decision. The roadmap is sequenced rather than parallelized so that fine-tune dataset construction sees a clear picture of what model errors actually look like *after* deterministic repair has stripped the easy failures.

## Consequences

- A new repo `raif-lora/` (or a dedicated branch) holds the training pipeline, dataset generation scripts, and eval harness. The training code does not live in `prototype/` — that directory stays focused on the encoder/decoder/harness.
- The harness gains a `--lora <hf-id>` flag (or equivalent) so the same `bun harness` workflow benchmarks the LoRA-attached model alongside vanilla baselines.
- A GBNF grammar file lands at `grammars/raif.gbnf` and an xgrammar file at `grammars/raif.xgrammar`. Both kept in sync with the spec.
- The v0.5 spec adds §14 (Schema declaration format) and §15 (Fine-tune integration — LoRA distribution, prompt-free inference protocol, optional schema-declaration prompt suffix).
- HuggingFace artifacts: `raif-standard/raif-llama3-3b-lora` (LoRA), `raif-standard/raif-llama3-7b-lora` (after 3B validates), `raif-standard/raif-grammars` (GBNF + xgrammar files).

## Considered alternatives

- **T1 only — pure SFT/LoRA, no grammar layer.** Rejected: grammar-constrained decoding is essentially free on supported runtimes and pushes parse rate to 100%. Why not.
- **T3 heavy — special-token registration.** Rejected for v0.5: requires vendor cooperation or base-model retraining. Premature without a partner. Re-evaluate once the LoRA path is validated and a vendor expresses interest.
- **Target 7B first instead of 3B.** Rejected: 7B-base already nearly matches JSON on RAIF emission. Marginal gain. 3B is where the addressable problem lives.
- **Full fine-tune instead of LoRA.** Rejected: portability and maintenance trade-offs favor LoRA for this narrow task.
- **Skip fine-tuning, push prompt engineering harder.** Rejected by the data: the few-shot prompt is at its ceiling at the 8B class. Adding more examples or anti-examples saturates fast and bloats per-call cost.
