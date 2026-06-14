// Generates the language-agnostic RAIF conformance corpus from the canonical
// TypeScript reference implementation. Every expected output is captured by
// actually running the reference — never hand-written — so the corpus is ground
// truth that any port (Python, etc.) must reproduce exactly.
//
// Run:  bun run conformance/generate.ts   (from the repo root)
// Output: conformance/{encode,decode,lenient,fix,validate}.json
//
// The corpus is committed; regenerate it whenever the reference impl or spec
// changes, then review the diff.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { corpus } from "../packages/js/bench/corpus.ts";
import {
  decode,
  decodeLenient,
  encode,
  fix,
  validate,
  type EncodeOptions,
  type JSONObject,
} from "../packages/js/src/raif.ts";

const SPEC = "v0.5";
const here = import.meta.dir;

function repairKinds(repairs: { kind: string }[]): string[] {
  return repairs.map((r) => r.kind).sort();
}

function write(name: string, cases: unknown[]) {
  const path = join(here, `${name}.json`);
  const body = {
    spec: SPEC,
    function: name,
    note: "Generated from the RAIF TypeScript reference. Do not edit by hand.",
    cases,
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
  console.log(`  ${name}.json: ${cases.length} cases`);
}

// ── encode: every corpus shape, in both emission profiles ───────────────────
const encodeCases: unknown[] = [];
for (const entry of corpus) {
  for (const profile of ["canonical", "generation"] as const) {
    const opts: EncodeOptions = { profile };
    encodeCases.push({
      name: `${entry.name}__${profile}`,
      description: entry.description,
      input: entry.json,
      opts,
      expected: encode(entry.json, opts),
    });
  }
}

// ── decode: round-trip every shape, plus repair + error cases ───────────────
const decodeCases: unknown[] = [];
for (const entry of corpus) {
  const raif = encode(entry.json);
  const r = decode(raif);
  if (!r.ok) throw new Error(`reference decode failed for ${entry.name}`);
  decodeCases.push({
    name: `roundtrip__${entry.name}`,
    input: raif,
    schema: null,
    expected: r.value,
    repairs: repairKinds(r.repairs),
  });
}

// Hand-authored degraded inputs — the repair branches. Expected output is
// captured from the reference, so these assert real behaviour, not a guess.
// Inputs are lifted verbatim from the reference's own tests (raif.test.ts) so
// each fires a specific repair kind; the captured `repairs` array is the proof.
const repairInputs: { name: string; input: string; schema?: string }[] = [
  { name: "markdown_fence", input: "```\nactive=true\nuser={name=Ada}\n```" },
  { name: "mode_markers", input: "<raif>\ncity=Oslo\nlat=59.9\n</raif>" },
  { name: "separator_coerced", input: "active=true\nuser.name: Ada" },
  { name: "fenced_with_lang", input: "```raif\nx=1\ny=2\n```" },
  // ── the 9 previously-uncovered repair kinds (raif.test.ts) ──────────────
  // unterminated_array_closed_at_eof (~380)
  { name: "unterminated_array_eof", input: "mixed=[\n{a=1}\n{b=2}" },
  // mismatched_nonce_recovered (~454)
  { name: "mismatched_nonce", input: "body=<<<7f2a\nhello\n>>>7f2b" },
  // multiline_braces_flattened (~473)
  { name: "multiline_braces", input: "a={\nb=1\n}" },
  // delimiter_count_repaired (~520)
  { name: "delimiter_count_opener", input: "body=<<\nHi\nThere\n>>>" },
  { name: "delimiter_count_closer", input: "body=<<<\nHi\nThere\n>>" },
  // repeated_keys_indexed (~590)
  {
    name: "repeated_keys",
    input:
      "mixed={kind=user,name=alice}\nmixed={kind=group,members=5}\nmixed={kind=user,name=bob,role=admin}",
  },
  // nested_inline_flattened (~647)
  {
    name: "nested_inline",
    input: "data={user={id=7,handle=egor},meta={has_more=false}}",
  },
  // line_endings_normalized (~860)
  { name: "line_endings", input: "a=1\r\nb=2\r\n" },
  // unterminated_block_closed_at_eof (~930)
  { name: "unterminated_block_eof", input: "a=1\nbody=<<<\nline one\nline two" },
  // pathological_key_resolved (~1340) — schema-driven
  {
    name: "pathological_key",
    input: "user.email=x@y.z",
    schema: "<<<user.email>>>:s",
  },
];
for (const c of repairInputs) {
  const r = decode(c.input, c.schema);
  decodeCases.push({
    name: `repair__${c.name}`,
    input: c.input,
    schema: c.schema ?? null,
    ...(r.ok
      ? { expected: r.value, repairs: repairKinds(r.repairs) }
      : { error: true }),
  });
}

// Inputs the decoder must reject (ambiguous / unrepairable).
const errorInputs: { name: string; input: string }[] = [
  { name: "garbage", input: "this is not raif at all !!!" },
  { name: "empty", input: "" },
];
for (const c of errorInputs) {
  const r = decode(c.input);
  decodeCases.push({
    name: `error__${c.name}`,
    input: c.input,
    schema: null,
    ...(r.ok ? { expected: r.value, repairs: repairKinds(r.repairs) } : { error: true }),
  });
}

// ── decode with NON-NULL schema (ADR-0019) ──────────────────────────────────
// Schema declarations + inputs lifted from raif.test.ts (~1203–1477). Every
// expected output / error flag is captured from the reference run.
type SchemaCase = { name: string; input: string; schema: string };
const schemaDecodeCases: SchemaCase[] = [
  // scalar types s/n/b/t and the o open-structure
  { name: "scalar_s_keeps_strings", input: "flag=true\nplaceholder=null\npriority=2", schema: "placeholder:s\npriority:s\nflag:s" },
  { name: "scalar_s_inline_lookalike", input: "s={a=1,b=2}", schema: "s:s" },
  { name: "scalar_s_wrapped_unwraps", input: "s=<<<hello, world>>>", schema: "s:s" },
  { name: "scalar_n_ok", input: "count=42", schema: "count:n" },
  { name: "scalar_n_bad", input: "count=high", schema: "count:n" },
  { name: "scalar_b_bad", input: "on=yes", schema: "on:b" },
  { name: "schema_wins_over_wire_tag", input: "id:n=42", schema: "id:s" },
  // optional `?`
  { name: "optional_s_bare_null", input: "note=null", schema: "note:s?" },
  { name: "optional_s_tagged_null", input: "note:s=null", schema: "note:s?" },
  // array-element types in both literal and path-row forms
  { name: "array_elem_s_literal", input: "tags=[\ntrue\n42\nnull\n]", schema: "tags[]:s" },
  { name: "array_elem_s_path", input: "tags[0]=true\ntags[1]=07", schema: "tags[]:s" },
  // table-cell typing
  { name: "table_cell_typed", input: "items::id,note\nitems[0]=1,null\nitems[1]=2,true", schema: "items[].id:n\nitems[].note:s" },
  // inline-object cell typing
  { name: "inline_object_typed", input: "user={id=7,tag=42}", schema: "user.id:n\nuser.tag:s" },
  // o open-structure: children decode by inference
  { name: "open_o_array_inference", input: "mixed=[\n{kind=user,n=5}\n{kind=group}\n]", schema: "mixed[]:o" },
  // o with declared children: typed where declared, open elsewhere
  { name: "open_o_declared_children", input: "mixed=[\n{id=42,other=true}\n]", schema: "mixed[]:o\nmixed[].id:s\nmixed[].extra:n?" },
  { name: "open_o_heterogeneous", input: "mixed=[\n{kind=user,name=alice}\n{kind=group,members=5}\n]", schema: "mixed[]:o\nmixed[].kind:s\nmixed[].name:s?\nmixed[].members:n?" },
  { name: "open_o_array_literal", input: "extra=[\n1\ntwo\n]", schema: "extra:o?" },
  // multiline block typed
  { name: "multiline_t_ok", input: "body=<<<\nline1\nline2\n>>>", schema: "body:t" },
  { name: "multiline_n_bad", input: "count=<<<\nx\n>>>", schema: "count:n" },
  // nested interpretation when schema declares nested shape
  { name: "nested_path_field", input: "user.email=x@y.z", schema: "user.email:s" },
  // ── validation error branches ──
  { name: "err_missing_required", input: "to=a@b.c", schema: "to:s\nsubject:s" },
  { name: "ok_optional_absent", input: "to=a@b.c", schema: "to:s\nnote:s?" },
  { name: "err_unknown_field", input: "to=a@b.c\nextra=1", schema: "to:s" },
  { name: "err_scalar_where_object", input: "user=5", schema: "user.id:n" },
  { name: "err_required_in_array_elem", input: "items=[\n{id=1}\n]", schema: "items[].id:n\nitems[].name:s" },
];
for (const c of schemaDecodeCases) {
  const r = decode(c.input, c.schema);
  decodeCases.push({
    name: `schema__${c.name}`,
    input: c.input,
    schema: c.schema,
    ...(r.ok
      ? { expected: r.value, repairs: repairKinds(r.repairs) }
      : { error: true }),
  });
}

// ── decode: number / unicode / CRLF edge cases (highest JS↔Py risk) ──────────
// Captured from the reference. Leading-zero→string is intentionally omitted
// (covered by roundtrip__numeric_string_ambiguity).
const edgeDecodeCases: { name: string; input: string; schema?: string }[] = [
  { name: "numeric_overflow_exp", input: "a=1e309" },
  { name: "numeric_overflow_digits_typed", input: "a:n=" + "9".repeat(400), schema: "a:n" },
  { name: "malformed_index_leading_zero", input: "a[01]=1" },
  { name: "malformed_index_trailing_alpha", input: "a[1x]=1" },
  { name: "malformed_index_exponent", input: "a[1e5]=1" },
  { name: "non_ascii_digit_value", input: "a=١" },
  { name: "non_ascii_digit_index", input: "a[1١]=x" },
  { name: "double_boundary_odd", input: "a=9007199254740993" },
  { name: "double_boundary_even", input: "a=9007199254740992" },
  { name: "crlf_document_normalized", input: "a=1\r\nb=2\r\n" },
];
for (const c of edgeDecodeCases) {
  const r = decode(c.input, c.schema);
  decodeCases.push({
    name: `edge__${c.name}`,
    input: c.input,
    schema: c.schema ?? null,
    ...(r.ok
      ? { expected: r.value, repairs: repairKinds(r.repairs) }
      : { error: true }),
  });
}

// ── decodeLenient: truncation recovery ──────────────────────────────────────
const lenientCases: unknown[] = [];
const truncatedInputs: { name: string; input: string; schema?: string }[] = [
  { name: "cut_midstream", input: "<raif>\ncity=Oslo\nlat" },
  { name: "complete", input: "city=Oslo\nlat=59.9" },
  { name: "fence_unclosed", input: "```\nx=1\ny=2" },
  // per-leaf recovery (raif.test.ts ~940–969)
  { name: "garbage_line_between_leaves", input: "good=1\n@@@garbage\nalso=2" },
  { name: "bad_table_row_skipped", input: "items::id,name\nitems[0]=1,foo\nitems[1]=2\nitems[2]=3,baz" },
  { name: "path_collision_first_wins", input: "a=1\na.b=2" },
  // marker-missing-close → truncated (raif.test.ts ~1426)
  { name: "marker_missing_close", input: "<raif>\na=1\nb=2" },
  // EOF-closed multiline → truncated (raif.test.ts ~1439)
  { name: "eof_closed_multiline", input: "a=1\nbody=<<<\ncut off here" },
  // marker-looking values survive (raif.test.ts ~1444): the wire form is the
  // reference's own encoding of the marker-bearing object, so stripping must
  // not touch the values.
  {
    name: "marker_looking_values",
    input: encode({ s: "<raif>", t: "a </raif> b", body: "x\n<raif>\ny" }),
  },
  // schema-aware lenient: per-leaf schema error (raif.test.ts ~1327)
  { name: "schema_per_leaf_error", input: "to=a@b.c\ncount=high", schema: "to:s\ncount:n" },
];
for (const c of truncatedInputs) {
  const r = decodeLenient(c.input, c.schema);
  lenientCases.push({
    name: c.name,
    input: c.input,
    schema: c.schema ?? null,
    expected: r.value,
    truncated: r.truncated,
    errorCount: r.errors.length,
    repairs: repairKinds(r.repairs),
  });
}

// ── fix: canonicalization ───────────────────────────────────────────────────
const fixCases: unknown[] = [];
for (const entry of corpus.slice(0, 8)) {
  const raif = encode(entry.json, { profile: "generation" });
  const r = fix(raif);
  if (!r.ok) throw new Error(`reference fix failed for ${entry.name}`);
  fixCases.push({
    name: `canonicalize__${entry.name}`,
    input: raif,
    expected: r.canonical,
    repairs: repairKinds(r.repairs),
  });
}
for (const c of repairInputs) {
  const r = fix(c.input, c.schema);
  fixCases.push({
    name: `fix__${c.name}`,
    input: c.input,
    schema: c.schema ?? null,
    ...(r.ok ? { expected: r.canonical, repairs: repairKinds(r.repairs) } : { error: true }),
  });
}
// fix with NON-NULL schema (a subset of the schema decode cases that fix can
// canonicalize). Schema drives typing, so the canonical form may differ from
// an untyped fix.
const schemaFixCases: SchemaCase[] = [
  { name: "scalar_s_keeps_strings", input: "flag=true\nplaceholder=null\npriority=2", schema: "placeholder:s\npriority:s\nflag:s" },
  { name: "table_cell_typed", input: "items::id,note\nitems[0]=1,null\nitems[1]=2,true", schema: "items[].id:n\nitems[].note:s" },
  { name: "inline_object_typed", input: "user={id=7,tag=42}", schema: "user.id:n\nuser.tag:s" },
  { name: "pathological_key", input: "user.email=x@y.z", schema: "<<<user.email>>>:s" },
];
for (const c of schemaFixCases) {
  const r = fix(c.input, c.schema);
  fixCases.push({
    name: `fix_schema__${c.name}`,
    input: c.input,
    schema: c.schema,
    ...(r.ok ? { expected: r.canonical, repairs: repairKinds(r.repairs) } : { error: true }),
  });
}
// fix byte-idempotence: a canonical doc and a nonce-bearing multiline doc both
// fix to themselves (raif.test.ts ~901). Captured as fix cases with no repairs.
const idempotentFixInputs: { name: string; input: string }[] = [
  { name: "canonical_doc", input: encode({ a: 1, body: "line1\nline2", s: "x" }) },
  { name: "nonce_multiline", input: encode({ body: "a\n>>>\nb" }) },
];
for (const c of idempotentFixInputs) {
  const r = fix(c.input);
  fixCases.push({
    name: `idempotent__${c.name}`,
    input: c.input,
    schema: null,
    ...(r.ok ? { expected: r.canonical, repairs: repairKinds(r.repairs) } : { error: true }),
  });
}

// ── validate: canonical is valid; degraded / garbage is not ─────────────────
const validateCases: unknown[] = [];
for (const entry of corpus.slice(0, 8)) {
  const raif = encode(entry.json);
  const r = validate(raif);
  validateCases.push({ name: `canonical__${entry.name}`, input: raif, schema: null, valid: r.ok });
}
for (const c of repairInputs) {
  const r = validate(c.input, c.schema);
  validateCases.push({
    name: `noncanonical__${c.name}`,
    input: c.input,
    schema: c.schema ?? null,
    valid: r.ok,
  });
}
for (const c of errorInputs) {
  const r = validate(c.input);
  validateCases.push({ name: `noncanonical__${c.name}`, input: c.input, schema: null, valid: r.ok });
}
// validate with NON-NULL schema: the validation error branches (a canonical
// wire form that the schema accepts/rejects). Captured from the reference.
const schemaValidateCases: SchemaCase[] = [
  { name: "n_ok", input: "count=42", schema: "count:n" },
  { name: "n_bad", input: "count=high", schema: "count:n" },
  { name: "b_bad", input: "on=yes", schema: "on:b" },
  { name: "missing_required", input: "to=a@b.c", schema: "to:s\nsubject:s" },
  { name: "optional_absent_ok", input: "to=a@b.c", schema: "to:s\nnote:s?" },
  { name: "unknown_field", input: "to=a@b.c\nextra=1", schema: "to:s" },
  { name: "scalar_where_object", input: "user=5", schema: "user.id:n" },
  { name: "required_in_array_elem", input: "items=[\n{id=1}\n]", schema: "items[].id:n\nitems[].name:s" },
];
for (const c of schemaValidateCases) {
  const r = validate(c.input, c.schema);
  validateCases.push({ name: `schema__${c.name}`, input: c.input, schema: c.schema, valid: r.ok });
}
// validate byte-idempotence: a canonical doc and a nonce-bearing multiline doc
// must both validate (raif.test.ts ~896).
for (const c of idempotentFixInputs) {
  const r = validate(c.input);
  validateCases.push({ name: `idempotent__${c.name}`, input: c.input, schema: null, valid: r.ok });
}

// ── encode: UTF-8 byte-order key sort (raif.test.ts ~874) ────────────────────
// Astral-plane key sorts after U+FFFD — UTF-16 sort would invert this. Captured
// as an encode case so the corpus pins the byte-order contract.
encodeCases.push({
  name: "utf8_byte_order_keys__canonical",
  description: "canonical key order is UTF-8 byte order (astral after U+FFFD)",
  input: { "😀": 1, "�": 2 },
  opts: { profile: "canonical" } as EncodeOptions,
  expected: encode({ "😀": 1, "�": 2 }, { profile: "canonical" }),
});

console.log(`Generating RAIF conformance corpus (spec ${SPEC})…`);
write("encode", encodeCases);
write("decode", decodeCases);
write("lenient", lenientCases);
write("fix", fixCases);
write("validate", validateCases);
console.log("Done.");
