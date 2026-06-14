# raif

**RAIF** — a token-efficient, repair-tolerant interchange format for the JSON
object an LLM emits. The canonical TypeScript reference implementation: pure,
zero runtime dependencies, fully typed. Decodes losslessly back to JSON, repairs
the common failure modes of generated output, and costs ~14% fewer tokens than
JSON.

- Spec & monorepo: <https://github.com/skrrt-sh/raif-standard>
- Python package: `raif` on PyPI

## Install

```sh
bun add @skrrt-sh/raif        # or: npm install @skrrt-sh/raif / pnpm add @skrrt-sh/raif
```

## Usage

```ts
import { encode, decode, decodeLenient, fix, validate, parseSchema } from "@skrrt-sh/raif";

// JSON object -> canonical RAIF
encode({ to: "a@b.com", subject: "hi" });
// "subject=hi\nto=a@b.com"

// Generation profile (what models are trained to emit)
encode({ items: [{ id: 1 }, { id: 2 }] }, { profile: "generation" });

// RAIF -> JSON, with repair reporting
decode("a=1\nb=hi");
// { ok: true, value: { a: 1, b: "hi" }, repairs: [] }

// Self-healing: strips fences / markers, coerces ":"->"=", reports every repair
decode("```\nactive=true\nuser.name: Ada\n```");
// { ok: true, value: { active: true, user: { name: "Ada" } },
//   repairs: [{ kind: "markdown_stripped" }, { kind: "separator_coerced" }] }

// Per-leaf recovery — never throws, surfaces truncation
decodeLenient("<raif>\ncity=Oslo\nlat");
// { value: { city: "Oslo" }, errors: [...], repairs: [...], truncated: true }

// Canonicalize (decode -> re-encode); idempotent
fix("```\na=1\n```");
// { ok: true, canonical: "a=1", repairs: [...] }

// Read-only canonicality check
validate("a=1"); // { ok: true }

// Optional schema-typed decode: a bare null under a string field stays "null"
const schema = parseSchema("priority:n\nnote:s?");
decode("priority=2\nnote=hi", schema);
```

## API

| Function | Returns |
| --- | --- |
| `encode(obj, opts?)` | `string` (canonical RAIF) |
| `decode(text, schema?)` | `{ ok, value \| error, repairs }` |
| `decodeLenient(text, schema?)` | `{ value, errors, repairs, truncated }` |
| `fix(text, schema?)` | `{ ok, canonical \| error, repairs }` |
| `validate(text, schema?)` | `{ ok }` or `{ ok: false, errors }` |
| `parseSchema(decl)` | `RaifSchema` |

`opts` is `{ profile?: "canonical" \| "generation"; markers?: boolean }`. The
package ships dual ESM + CommonJS builds with type declarations for each.

## Development

This package lives in the [raif-standard](https://github.com/skrrt-sh/raif-standard)
monorepo. Benchmark and harness tooling (token comparisons, the corpus browser,
the LLM round-trip harness) lives under [`bench/`](bench) and is not published;
see [`bench/RUN_HISTORY.md`](bench/RUN_HISTORY.md) for the token-saving iteration log.

```sh
bun install
bun test          # property suite + shared conformance corpus
bun run build     # dual ESM+CJS + type declarations
```

## License

Apache-2.0
