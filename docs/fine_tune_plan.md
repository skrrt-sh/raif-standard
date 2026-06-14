# Fine-tune execution plan — v0.5

This document converts the design in [ADR-0017](./adr/0017-fine-tune-integration-philosophy.md) into an actionable execution plan. It is intentionally concrete enough that a future agent (or human) can execute it end-to-end without re-deriving the design choices.

**Out-of-band prerequisites** (not produced by this plan): a single A100 / H100 / RTX 4090-class GPU (or rented equivalent — RunPod, Modal, Lambda, etc.), a HuggingFace account with write access to a `raif-standard/` org or user namespace, and ~$50–$200 in GPU credits for the full pipeline.

## 1. Goal & acceptance gate (recap)

A LoRA adapter for **Llama-3.2-3B-Instruct** (or equivalent commodity 3B base) that:

- **Parse rate ≥ 98%** on the corpus.
- **Fidelity rate ≥ 95%** on the corpus.
- **Token win preserved**: RAIF tokens ≤ 0.92× JSON tokens averaged over the corpus.
- **No regression on held-out shapes**: 3–5 corpus shapes withheld from training, evaluated at the same rates as in-training shapes.

If any criterion is missed, iterate the recipe (DPO addition, adversarial-focus rebalancing, schema-declaration redesign) — do not ship.

## 2. Repo layout

Keep the training workstream out of the `raif-standard` monorepo. `raif-lora` is a separate repo. Layout:

```
raif-lora/                           ← new repo, sibling of raif-standard/
├── README.md
├── pyproject.toml                   ← uv / poetry / pip — pick one
├── src/
│   ├── dataset.py                   ← synthetic-from-corpus generator
│   ├── train.py                     ← SFT entry point (axolotl or unsloth)
│   ├── train_dpo.py                 ← optional DPO pass
│   ├── eval.py                      ← held-out eval (uses the `raif` PyPI package directly)
│   └── publish.py                   ← push to HuggingFace
├── configs/
│   ├── llama-3-3b-sft.yaml          ← axolotl/unsloth training config
│   └── llama-3-3b-dpo.yaml          ← DPO config (optional)
├── data/                            ← generated, gitignored
│   ├── train.jsonl
│   ├── eval.jsonl
│   └── README.md                    ← regeneration recipe (deterministic)
├── grammars/
│   ├── raif.gbnf                    ← llama.cpp grammar
│   ├── raif.xgrammar                ← vLLM grammar
│   └── grammars.test.ts             ← lints both against the corpus
└── adapters/                        ← gitignored; LoRA outputs land here
```

The `raif-standard` monorepo stays focused on the encoder/decoder packages, conformance corpus, and bench harness (`packages/js`, `packages/py`, `conformance/`). The `raif-lora/` repo depends on the published **`raif` PyPI package** (`pip install raif` / `uv add raif`) and imports `encode` / `decode` / `fix` / `validate` directly — the Python implementation now exists (full surface, stdlib-only, no `bun` at runtime), so there is no shelling out to `bun` and no `-e` install against the monorepo. (Today `raif-lora` still ships its own decoder; depending on the published package is the intended direction.)

## 3. Dataset construction

### 3.1 Synthetic-from-corpus pipeline

Each corpus shape in `packages/js/bench/corpus.ts` (the TS reference's dev corpus) becomes a *template*. The dataset generator produces N variations per template by varying:

- Field names (rotate from a pool of ~200 realistic identifiers: `user_id`, `created_at`, `payload`, …).
- String values (pool of ~500 realistic short strings + a few realistic long strings).
- Numeric ranges (random small ints, medium ints, floats, negatives, zero, large ints).
- Array sizes (1–10 for general arrays, 2–20 for table-shaped arrays).
- Nesting depth (1–5 levels for path-mode shapes).

For each variation:

1. Generate the source JSON.
2. Call `raif.encode(...)` from the `raif` PyPI package to produce the canonical RAIF (no `bun` in the loop).
3. Wrap into a chat-template message pair:

```json
{
  "messages": [
    { "role": "system", "content": "<no spec, no examples — model knows RAIF natively>" },
    { "role": "user", "content": "<request_template>\n\n<schema>\n<schema_declaration>\n</schema>" },
    { "role": "assistant", "content": "<raif_output>" }
  ]
}
```

The `<request_template>` is a short natural-language description of the JSON to emit (synthesized from the shape: `"Return a tool call with these fields: …"`).

### 3.2 Schema declaration format

The compact schema declaration (used at inference time and during training) uses RAIF-native syntax:

```
<schema>
to:s
subject:s
priority:n
body:s
tags[]:s              ← array of strings
user.id:n             ← nested
user.handle:s
user.verified:b
items[]:o             ← array of objects (heterogeneous; type is implied)
attachments[]:s?      ← optional (the field may be absent)
</schema>
```

Type codes (reuse RAIF's existing `s` / `n` / `b` / `t`):

| Code | Meaning |
|---|---|
| `s` | string |
| `n` | number |
| `b` | boolean |
| `t` | multiline text (string with embedded newlines) |
| `o` | object (used inside `[]` to say "array of objects") |

Modifiers:

- `field?:type` — field is optional (may be absent from the output).
- `field[]:type` — field is an array of the given type.
- `parent.child:type` — nested path.

The schema declaration is **never emitted by the model in its output** — it is a prompt cue only. The decoder optionally accepts the same format when supplied programmatically via the `fix(raif, schema?)` parameter (ADR-0016).

### 3.3 Volume

- Synthetic base: 18 shapes × 500 variations = **9,000 examples**.
- Adversarial focus on hard shapes: `pathological_keys`, `numeric_string_ambiguity`, `heterogeneous_array`, `deep_array_literal`, `wide_heterogeneous_array` get an extra 500 variations each = **2,500 adversarial examples**.
- Total: **~11,500 train examples + ~500 eval examples** (3–5 held-out shapes × 100 variations each).

### 3.4 Held-out shapes

Withhold from training:
- `multiline_body` — exercises the line-bounded form
- `pathological_keys` — exercises the wrap rule under adversarial conditions
- `large_table` — exercises table mode at scale
- `deep_array_literal` — exercises nested array-literal handling
- `flat_inline_object` — exercises inline-object form

If the model performs well on these without seeing them in training, the recipe generalizes. If it fails, the dataset variation rules need adjustment (more diversity within the in-training shapes).

## 4. Training recipe

### 4.1 Base model

**Llama-3.2-3B-Instruct.** Reasons: most-supported 3B base in 2026, well-instruction-tuned, available on HuggingFace under `meta-llama/Llama-3.2-3B-Instruct`. Alternate candidates: `Qwen/Qwen2.5-3B-Instruct`, `microsoft/Phi-3-mini-4k-instruct` — pick the one that has the best chat template support in the chosen training framework.

### 4.2 SFT config (axolotl example)

```yaml
base_model: meta-llama/Llama-3.2-3B-Instruct
model_type: LlamaForCausalLM
tokenizer_type: AutoTokenizer

datasets:
  - path: ./data/train.jsonl
    type: chat_template
    chat_template: llama3

val_set_size: 0.05
sequence_len: 2048

adapter: lora
lora_r: 32
lora_alpha: 64
lora_dropout: 0.05
lora_target_modules:
  - q_proj
  - v_proj
  - k_proj
  - o_proj
  - gate_proj
  - down_proj
  - up_proj

gradient_accumulation_steps: 4
micro_batch_size: 4
num_epochs: 3
optimizer: adamw_torch
learning_rate: 2e-4
lr_scheduler: cosine
warmup_steps: 100

bf16: auto
flash_attention: true

logging_steps: 10
saves_per_epoch: 1
output_dir: ./adapters/llama-3-3b-raif-sft

# Optional W&B
wandb_project: raif-lora
wandb_name: llama-3-3b-sft-r32-3epoch
```

Expected training time on a single A100-80G: **~3–5 hours** for 3 epochs on 11.5k examples.

### 4.3 SFT → eval → DPO loop

1. Train SFT adapter per config above.
2. Run eval (§5) against the SFT adapter.
3. If acceptance gate is met → ship.
4. If not → collect (chosen, rejected) preference pairs:
   - For each prompt where SFT produces a fidelity-incorrect output, run the prompt 8× with temperature=0.7 to get diverse samples.
   - Score each sample with the harness; the highest-fidelity sample is `chosen`, a wrong-fidelity sample is `rejected`.
   - Yields a DPO dataset of ~500–1500 preference pairs depending on residual error rate.
5. Train DPO adapter on top of SFT adapter (configs in `configs/llama-3-3b-dpo.yaml`).
6. Re-eval; loop until gate hits.

Most projects of this scope converge in SFT alone; DPO is only needed if 3B is structurally too small for the format-following task.

## 5. Eval protocol

### 5.1 Extend the harness

Add a `--lora <adapter-path-or-hf-id>` flag to the bench harness (`packages/js/bench/harness.ts`), or run the equivalent eval from `raif-lora` using the `raif` PyPI package directly. When set:

- Provider must be `ollama` or a `local` mode (use llama.cpp / vLLM with the adapter applied).
- Prompts skip the spec block and few-shot examples — pass only the request + optional `<schema>` declaration.
- Output scoring identical to current harness.

Implementation sketch:

```sh
bun harness --provider ollama --model llama3-3b-raif-sft --trials 3 --no-prompt-prefix
```

Where `--no-prompt-prefix` flips the prompt template to the prompt-free form.

### 5.2 Acceptance run

After training:

```sh
# Full corpus, with held-out shapes called out separately
bun harness --provider local --lora adapters/llama-3-3b-raif-sft \
            --trials 3 --concurrency 4

# Held-out shapes
bun harness --provider local --lora adapters/llama-3-3b-raif-sft \
            --trials 3 --shapes multiline_body,pathological_keys,large_table,deep_array_literal,flat_inline_object
```

Compare to the 7B-base JSON baseline (from `harness_runs/2026-05-16T18-20-41-591Z_openrouter_6models.json` — qwen-2.5-7b-instruct or mistral-nemo) for parse + fidelity. Gate per §1.

### 5.3 Token-win re-validation

Re-run `bun bench` to confirm encoder-side Δ vs JSON. Then re-compute Δ from the LoRA's actual output:

```
delta_tok = (mean RAIF output tokens) / (mean JSON output tokens) — 1.0
```

Gate: `delta_tok <= -0.08` (RAIF at least 8% cheaper).

## 6. GBNF + xgrammar grammars

Hand-write both from the v0.4 spec. Stored under `raif-lora/grammars/`.

### 6.1 GBNF (llama.cpp)

Skeleton:

```
root            ::= leaf ("\n" leaf)* "\n"?
leaf            ::= key sep value
key             ::= plain-key | wrapped-key
plain-key       ::= [^.=:[\]\n\r<>{},]+ ("." [^.=:[\]\n\r<>{},]+ | "[" [0-9]+ "]")*
wrapped-key     ::= "<<<" [^>\n]+ ">>>"
sep             ::= "=" | ":s=" | ":n=" | ":b=" | ":t=" | "::"
value           ::= bare-value | wrapped-value | multiline-value | inline-object | array-literal
…
```

(Full grammar derived from the `packages/js/src/raif.ts` parser; ~80 lines.)

Test: every shape in the corpus, when emitted by the encoder, must be accepted by the grammar. Add a lint command:

```sh
bun grammar-test  # round-trips each corpus shape through GBNF parser, asserts accept
```

### 6.2 xgrammar (vLLM)

Same grammar, JSON-schema-ish format. Easier to write because xgrammar is more permissive on lookahead.

### 6.3 Documentation

`grammars/README.md` with:
- Example usage in llama.cpp: `llama-cli -m model.gguf --grammar-file raif.gbnf`
- Example usage in vLLM: `--guided-decoding raif.xgrammar`
- Caveat: grammars enforce syntax only, not semantics (e.g., the type-string `version_tag=true` is grammatically valid even when the field is supposed to be a string).

## 7. Distribution

### 7.1 HuggingFace artifacts

| Repo | Contents | When |
|---|---|---|
| `raif-standard/raif-llama3-3b-lora` | LoRA weights, adapter_config.json, README, eval table | After 3B passes the acceptance gate |
| `raif-standard/raif-llama3-7b-lora` | Same for 7B (re-run dataset, re-train) | Optional — after 3B ships |
| `raif-standard/raif-grammars` | `raif.gbnf`, `raif.xgrammar`, README, version pin | Concurrent with first LoRA release |

### 7.2 LoRA README structure

```markdown
# raif-llama3-3b-lora

Native RAIF emission for Llama-3.2-3B-Instruct. Drop the few-shot prompt; ask for the output directly.

## Usage (transformers)
…
## Usage (vLLM)
…
## Usage (llama.cpp — merge first)
…

## Eval (v0.5)
| metric | this LoRA | base + few-shot | 7B-base + JSON |
|---|---:|---:|---:|
| RAIF parse | XX% | YY% | ZZ% |
| RAIF fidelity | XX% | YY% | ZZ% |
| token Δ vs JSON | XX% | YY% | — |

## License
Apache-2.0 (matches Llama-3 license terms; verify before redistribution).
```

## 8. Execution sequence

1. **Set up `raif-lora/` repo** — bootstrap pyproject, axolotl install, GPU acquisition.
2. **Build `src/dataset.py`** — produces deterministic `data/train.jsonl` and `data/eval.jsonl` from the corpus. Commit the generator; gitignore the outputs.
3. **Add `--lora` flag to the bench harness (`packages/js/bench/harness.ts`)** — same change can land before training; lets the harness be tested with the base model first.
4. **Train SFT adapter** — `python src/train.py configs/llama-3-3b-sft.yaml`. ~3-5 hr on A100.
5. **Eval SFT adapter** — `bun harness --provider local --lora ./adapters/…`. Gate check.
6. **(If needed) Train DPO adapter** — only if SFT misses the gate.
7. **Write GBNF + xgrammar grammars** — concurrent with training; takes ~1–2 days.
8. **Publish to HuggingFace** — LoRA adapter + grammars repo.
9. **Update HANDOFF.md** with v0.5 status row.
10. **Write `docs/raif_v0.5_spec.md`** — add §14 Schema declaration format, §15 Fine-tune integration, supersede v0.3 spec.

## 9. Decisions that may need to be revisited

- **3B target → 1B stretch.** If 3B converges easily (~98/95+ on first SFT pass), try 1B next. If it doesn't converge cleanly, accept 3B as the floor.
- **Llama base → Qwen / Phi.** If Llama-3.2-3B's chat template is awkward or its tokenizer makes `<<<` cost > 1 token, switch to Qwen2.5-3B or Phi-3-mini. Re-run §5.3 token-win check on the new base to confirm RAIF still wins.
- **Adversarial focus weights.** If the model converges on common shapes but consistently fails on `pathological_keys`, increase that shape's variation count from 500 to 1500 (and document the imbalance in `data/README.md`).
- **GBNF lookahead limitations.** If llama.cpp's GBNF can't express the array-literal opener cleanly, fall back to a more permissive grammar that allows occasional invalid emissions and rely on the LoRA + repair pass to catch them. Document the trade-off in `grammars/README.md`.

## 10. Out of scope for v0.5

Carrying these explicitly so they don't creep in:

- **Real tool-call trace dataset.** Synthetic is sufficient. Defer to v0.6 if v0.5 falls short.
- **Special-token registration (`<|raif_start|>` / `<|raif_end|>`).** That's T3 in ADR-0017 — needs vendor cooperation or base retraining. Premature.
- **RAIF-R audit tier with CRC-8 / Reed-Solomon parity.** Separate workstream; not blocked by fine-tune.
- **Multi-base meta-adapter / merged "RAIF-capable" model collection.** Pick one base, ship one adapter. Expand later.
- **Web playground / demo site.** Nice-to-have, not on the critical path.

## 11. Definition of done for v0.5

The fine-tune workstream ships when ALL of these are true:

- [ ] LoRA adapter on HuggingFace under `raif-standard/`.
- [ ] Adapter card lists eval numbers from §5.2 in the README.
- [ ] `raif.gbnf` + `raif.xgrammar` published, lint test passes against the corpus.
- [ ] `HANDOFF.md` v0.5 status row added.
- [ ] `docs/raif_v0.5_spec.md` published, supersedes v0.3 spec.
- [ ] Bench harness (`packages/js/bench/harness.ts`) `--lora` flag merged and documented in `packages/js/README.md`.
- [ ] A v0.5 retrospective ADR (next number 0018) capturing what worked, what didn't, residual gaps.

Until all six are checked, v0.5 is in progress, not shipped.
