# RAIF — Repairable AI Interchange Format

**RAIF** is a wire format for the single JSON object an LLM emits for a tool
call or structured output. It round-trips losslessly to JSON, **repairs local
syntax errors** so one mangled field doesn't destroy the whole document, and
costs **fewer tokens than JSON** on most realistic shapes.

> JSON was designed for a deterministic writer. The writer is now a language
> model — probabilistic, prone to fenced code blocks, truncation, and slipped
> separators. RAIF keeps the writer side loose and puts the strictness in a
> deterministic **interpreter** that can repair, validate, and canonicalize.

```ts
import { encode, decode } from "raif";

encode({ user: { name: "Ada", email: "ada@example.com" }, active: true, retries: 3 });
// active=true
// retries=3
// user={email=ada@example.com,name=Ada}

decode("...").value;   // -> back to the exact JSON object
```

## What it stands for

**R**epairable **AI** **I**nterchange **F**ormat. "Repairable" is the whole
thesis: the format assumes its writer will make mistakes and is built so a
parser can recover from them deterministically — never by guessing values, only
by fixing syntax (see [ADR-0004](./docs/adr/0004-repair-fixes-syntax-not-values.md)).

## Why not just use JSON?

Models emit malformed JSON often enough that production tool-calling needs a
recovery story, and JSON has none — a single missing brace or a truncated
stream loses the entire object. The usual patch (`jsonrepair` + retries) guesses
at structure and still throws away everything after the break. RAIF instead:

- addresses every leaf independently (`user.email=...`), so a broken leaf is
  *one* broken leaf, not a broken document;
- strips the ceremony JSON spends tokens on (`{`, `}`, `"`, `,`, `:`) for the
  common shapes;
- defines a bounded, auditable repair tier instead of ad-hoc heuristics.

## Killer features

### 1. Self-healing decode

The decoder runs a bounded repair pass before parsing: markdown fences, mode
markers, line-ending noise, and slipped `:`→`=` separators are fixed
automatically, and every fix is reported — it never silently rewrites values.
Ambiguous damage is refused, not guessed.

```ts
// What a model actually emitted: fenced + a stray ":" separator
decode("```\nactive=true\nretries=3\nuser.name: Ada\n```");
// ok: true
// repairs: [{ kind: "markdown_stripped" },
//           { kind: "separator_coerced", detail: "':' → '=' at line 4" }]
```

### 2. Truncation recovery — keep the leaves you got

When the stream is cut off mid-generation, `decodeLenient` returns every intact
leaf plus a per-leaf error list and a `truncated` flag — so an agent can re-ask
only the broken field instead of regenerating the whole call.

```ts
// stream cut off after "lat":
decodeLenient("<raif>\ncity=Oslo\nlabel=HQ\nlat");
// {
//   value:   { city: "Oslo", label: "HQ" },   // the good leaves survive
//   truncated: true,
//   errors:  [{ line: 3, error: "no separator in leaf at line 3: lat" }]
// }
```

Measured: **47% leaf recovery at an equal token budget**, vs 41% for
JSON + jsonrepair.

### 3. Fewer tokens than JSON

Removing JSON's per-field punctuation is a **−12% to −14% token reduction** vs
minified JSON — confirmed both on the encoder bench and on real model output,
across the cl100k and Llama-3.2 tokenizers. It wins on every common shape.

### 4. Lossless, deterministic round-trip

`decode(encode(x))` reproduces `x` exactly. Emission is canonical (UTF-8
key-sorted), so `encode` is idempotent and `validate` is a pure check — proven
across 18 corpus shapes under a 5,000-seed adversarial fuzz test.

### 5. Schema-typed decode kills the literal-string trap

Give `decode` an optional schema and types come from the schema, not from
guessing. The string `"null"` under a string field stays the string `"null"` —
the classic fidelity killer is gone by construction.

```ts
decode("flag=null", "flag:s").value;   // { flag: "null" }   (string field)
decode("flag=null").value;             // { flag: null }     (JSON literal)
```

### 6. A four-function API — nothing more

```ts
encode(obj, opts?)            // JSON object -> RAIF
decode(raif, schema?)         // RAIF -> { ok, value, repairs }   (repairs, then parses)
decodeLenient(raif, schema?)  // RAIF -> { value, errors, truncated, repairs }  (never throws)
fix(raif, schema?)            // RAIF -> canonical RAIF           (the pure repair entry point)
validate(raif, schema?)       // read-only canonicality check
```

## How to use it

The reference implementation is a single dependency-light TypeScript module,
`prototype/src/raif.ts` (pure functions, no runtime deps for the core).

```sh
cd prototype
bun install
bun check        # round-trip smoke test across the corpus
bun test         # property tests (153)
bun bench        # token comparison vs JSON
bun compare      # RAIF / TOON / YAML / JSON across two tokenizers
bun tui          # interactive single-case browser
```

Then import the four functions:

```ts
import { encode, decode, decodeLenient, fix, validate } from "./prototype/src/raif.ts";

const raif = encode(toolCallArgs);          // emit
const { ok, value, repairs } = decode(raif); // consume + auto-repair
if (!ok) { /* re-ask the model */ }
```

### Using it for LLM tool-calls

1. Prompt or fine-tune the model to emit RAIF instead of JSON (see the
   **raif-lora** repo for the Llama-3.2-3B fine-tune).
2. `decode` the output. If `ok`, you have typed args. If the stream truncated,
   `decodeLenient` gives you the good leaves and tells you which field to re-ask.
3. Optionally pass a schema so types are pinned and unknown/missing fields are
   validated.

## Scope (what RAIF is *not*)

RAIF handles **single JSON objects** for **LLM-generated output**. It is not a
general interchange format, not a compression scheme, not a schema language, and
not an LLM-*input* format (that's TOON's job). These boundaries are deliberate —
see [ADR-0003](./docs/adr/0003-schema-versioning-is-out-of-scope.md) and the
out-of-scope notes in `HANDOFF.md`.

## Repository layout

```
raif-standard/
├── CONTEXT.md          ← glossary; read this first
├── HANDOFF.md          ← full state, empirical findings, open questions
├── docs/
│   ├── raif_v0.3_spec.md       ← current spec
│   ├── fine_tune_plan.md       ← the v0.5 LoRA plan (see the raif-lora repo)
│   └── adr/0001…0019           ← architecture decision records (the "why")
└── prototype/
    └── src/raif.ts             ← encoder + decoder (pure functions; the keepers)
```

The LoRA fine-tune workstream lives in the sibling repo **raif-lora**, which
expects to be checked out next to this one (it uses `../raif-standard/prototype`
as its canonical decoder during eval).

## Status

**v0.4.2** — schema-typed decode + a deterministic generation profile
([ADR-0019](./docs/adr/0019-schema-typed-decode-and-generation-profile.md)). The
spec is implemented in `prototype/src/raif.ts`; the design history is in the
ADRs. New here? Read `CONTEXT.md` for vocabulary, then `HANDOFF.md` for the full
picture.
