// RAIF v0.4 encoder + decoder + fix + validate. Pure functions; the keepers.
// Spec: docs/raif_v0.3_spec.md; v0.4 changes in ADRs 0014-0017.
//
// Changes vs v0.3:
//   - Public API split into four functions: encode, decode, fix, validate.
//     `fix` is pure RAIF→canonical RAIF; `decode` is `fix` then JSON projection;
//     `validate` is a read-only canonicality check. ADR-0014.
//   - TIER 2 deterministic decoder repairs (ADR-0015):
//       A. Leading-zero "number" already decodes as string (v0.3 invariant; now
//          formally documented as TIER 2 — no code change).
//       B. Repeated-key auto-indexing: `mixed=…\nmixed=…` → `mixed[0]=…\nmixed[1]=…`.
//       C. Nested inline-object flattening: `{user={id=7}}` parses as a nested
//          object via brace-depth-aware comma splitting.
//       D. Sparse table mode: `null` cells in table rows mean "key absent."
//          Decoder-accept only; the encoder never emits this form.
//
// Changes vs v0.2:
//   - Multiline form: nonce is optional. Bare `<<<\n...\n>>>` is the default;
//     nonce-bounded `<<<NONCE\n...\n>>>NONCE` is used only when a content line
//     literally equals `>>>`. ADR-0011.
//   - Inline-object leaf form `prefix[N]={k=v,...}` for arrays whose elements
//     are flat objects with primitive cells. Targets heterogeneous arrays that
//     table mode can't handle. ADR-0010.
//   - Cost-aware array emission: the encoder computes path, table, and inline
//     candidates per array and emits the shortest. ADR-0012.
//   - Decoder repair pass extended: strip `<raif>`/`</raif>` mode markers,
//     coerce stray `:` separator to `=` when unambiguous, recover a mismatched
//     multiline closer when there is exactly one viable candidate.
//
// Changes vs v0.1:
//   - Dropped sentinel forms `:z` / `:l` / `:o`. Empty containers and null
//     use the JSON literal forms `=null` / `=[]` / `={}` instead. ADR-0009.
//   - Relaxed value-wrap rules. ADR-0007.
//   - Added table mode for arrays of homogeneous objects. ADR-0008.
//
// String delimiter: `<<<` / `>>>`. 1 token each in cl100k_base. See ADR-0001.

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONValue[] | JSONObject;
export type JSONObject = { [k: string]: JSONValue };

const OPEN = "<<<";
const CLOSE = ">>>";

// ─── Canonical ordering, length, and line-hazard helpers (ADR-0018) ───

// UTF-8 byte order equals Unicode code-point order. JS's default string sort
// compares UTF-16 code units, which ranks U+E000..U+FFFF above astral code
// points — wrong for the spec's canonical ordering (§3.3, §9).
function compareUtf8(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

const UTF8_ENCODER = new TextEncoder();

function utf8Len(s: string): number {
  return UTF8_ENCODER.encode(s).length;
}

// A value whose tail would make the assembled leaf line itself look like a
// block opener (`…=<<<hex`, `…=<{1,2}hex`, `…=[`) must be wrapped: the
// decoder's opener detection matches whole lines, so an unlucky value tail
// would otherwise hijack the leaf into a multiline/array-literal parse and
// swallow its neighbors.
const OPENER_TAIL_RE = /(^|=)(<{1,3}[0-9a-fA-F]*|\[)$/;

function hasOpenerTail(v: string): boolean {
  return OPENER_TAIL_RE.test(v);
}

function stripCR(l: string): string {
  return l.endsWith("\r") ? l.slice(0, -1) : l;
}

// ─── Encoder ──────────────────────────────────────────────────────────

// Emission profiles (ADR-0019):
//   "canonical"  — cheapest-mode pick, fully sorted; the transport/audit form.
//   "generation" — what models are trained to emit. Deterministic mode rules
//     (table → array literal → path; no byte-cost optimization, so the model
//     learns one habit, not an optimizer) and truncation-optimal ordering
//     (single-line leaves first, tables, array literals, multiline blocks
//     last — the decoder accepts any order, and this order maximizes leaf
//     recovery when output is cut at a token budget).
export type EncodeProfile = "canonical" | "generation";

export interface EncodeOptions {
  profile?: EncodeProfile;
  // Frame the document in `<raif>` / `</raif>` mode markers (spec §8). The
  // repair pass strips them; a missing closer is the truncation signal that
  // `decodeLenient` surfaces as `truncated`.
  markers?: boolean;
}

export function encode(obj: JSONObject, opts?: EncodeOptions): string {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("RAIF requires a JSON object at top level");
  }
  const profile = opts?.profile ?? "canonical";
  const leaves: string[] = [];
  walk(obj, "", leaves, profile);
  const units = profile === "generation" ? orderForGeneration(leaves) : leaves;
  const body = units.join("\n");
  if (!opts?.markers) return body;
  return body.length === 0 ? "<raif>\n</raif>" : `<raif>\n${body}\n</raif>`;
}

// Stable-sort emission units by truncation class. Units arrive pre-joined
// (one array entry per leaf or block), so classification only needs the
// first line. Within a class, canonical (sorted) order is preserved.
function orderForGeneration(units: string[]): string[] {
  const unitClass = (u: string): number => {
    const nl = u.indexOf("\n");
    if (nl === -1) return 0;
    const first = u.slice(0, nl);
    if (NONCE_OPENER_RE.test(first)) return 3; // multiline text block
    if (first.endsWith("=[")) return 2; // array literal
    return 1; // table unit
  };
  return units
    .map((u, i) => ({ u, i, c: unitClass(u) }))
    .sort((a, b) => a.c - b.c || a.i - b.i)
    .map((x) => x.u);
}

function walk(value: JSONValue, prefix: string, leaves: string[], profile: EncodeProfile): void {
  if (value === null) {
    leaves.push(`${prefix}=null`);
    return;
  }
  if (typeof value === "boolean") {
    leaves.push(`${prefix}=${value}`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite number at ${prefix}: ${value}`);
    }
    leaves.push(`${prefix}=${JSON.stringify(value)}`);
    return;
  }
  if (typeof value === "string") {
    leaves.push(`${prefix}${encodeStringLeaf(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      leaves.push(`${prefix}=[]`);
      return;
    }
    emitArray(value, prefix, leaves, profile);
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      if (prefix !== "") leaves.push(`${prefix}={}`);
      return;
    }
    keys.sort(compareUtf8);
    const path: string[] = [];
    for (const k of keys) {
      walk(value[k]!, joinKey(prefix, k), path, profile);
    }
    // ADR-0012: also consider the inline-object form for non-empty nested
    // objects whose values are all primitives, and pick whichever is shorter.
    // Inline form is unavailable at the root (RAIF needs a path-addressable
    // root for streaming/repair to be meaningful) and in the generation
    // profile (one collapsed line trades away per-leaf truncation recovery;
    // ADR-0019).
    if (profile === "canonical" && prefix !== "" && eligibleForInlineObject(value as JSONObject)) {
      const inline = `${prefix}=${encodeInlineObject(value as JSONObject)}`;
      if (inline.length + 1 < bytes(path)) {
        leaves.push(inline);
        return;
      }
    }
    for (const leaf of path) leaves.push(leaf);
    return;
  }
  throw new Error(`unexpected value at ${prefix}: ${String(value)}`);
}

// ─── Array emission (ADR-0008 table mode, ADR-0010 inline-object, ADR-0012 pick shortest) ─

// Emit a non-empty array.
//
// Canonical profile (ADR-0012): build every eligible candidate (path, table,
// inline, literal) and append the shortest by UTF-8 byte length.
//
// Generation profile (ADR-0019): deterministic precedence — table when
// eligible, else array literal, else path. No cost comparison: a model can
// learn a fixed rule; it cannot replicate a byte-cost optimizer. Multi-line
// units are pushed pre-joined so ordering can treat them atomically.
function emitArray(arr: JSONValue[], prefix: string, leaves: string[], profile: EncodeProfile): void {
  if (profile === "generation") {
    const unit = asTable(arr, prefix) ?? asArrayLiteral(arr, prefix);
    if (unit) {
      leaves.push(unit.join("\n"));
      return;
    }
    // Path fallback: rows stay individual units so ordering keeps per-leaf
    // granularity (a row may itself be a multiline block).
    for (const leaf of asPath(arr, prefix, profile)) leaves.push(leaf);
    return;
  }
  const candidates: string[][] = [];
  candidates.push(asPath(arr, prefix, profile));
  const table = asTable(arr, prefix);
  if (table) candidates.push(table);
  const inline = asInlineObjects(arr, prefix);
  if (inline) candidates.push(inline);
  const literal = asArrayLiteral(arr, prefix);
  if (literal) candidates.push(literal);

  let best = candidates[0]!;
  let bestLen = bytes(best);
  for (let i = 1; i < candidates.length; i++) {
    const len = bytes(candidates[i]!);
    if (len < bestLen) {
      best = candidates[i]!;
      bestLen = len;
    }
  }
  for (const leaf of best) leaves.push(leaf);
}

// ADR-0013: array literal form. `prefix=[\n…rows…\n]`. Saves the per-row
// prefix repetition compared to path / inline-object modes. Rows are either
// primitives or flat inline-objects, one per line.
function asArrayLiteral(arr: JSONValue[], prefix: string): string[] | null {
  for (const item of arr) {
    if (!isArrayLiteralEligible(item)) return null;
  }
  const lines: string[] = [`${prefix}=[`];
  for (const item of arr) lines.push(encodeArrayLiteralElement(item));
  lines.push(`]`);
  return lines;
}

function isArrayLiteralEligible(v: JSONValue): boolean {
  if (v === null) return true;
  if (typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") {
    if (v.includes("\n") || v.includes("\r")) return false;
    return true;
  }
  if (Array.isArray(v)) return false; // nested arrays not allowed inside a literal
  return eligibleForInlineObject(v as JSONObject);
}

// Shared cell encoder for the three cell contexts (array-literal element,
// inline-object cell, table cell). Primitive handling (null/boolean/number) and
// the `<<<…>>>`-wrap mechanic for strings are identical across them; they differ
// ONLY in which characters force a string wrap, passed as `needsWrap`. Returns
// null for non-primitive values so each caller handles objects its own way
// (array-literal flattens to an inline-object; inline/table reject).
function encodePrimitiveCell(v: JSONValue, needsWrap: (s: string) => boolean): string | null {
  if (v === null) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return JSON.stringify(v);
  if (typeof v === "string") return needsWrap(v) ? `${OPEN}${v}${CLOSE}` : v;
  return null;
}

function encodeArrayLiteralElement(v: JSONValue): string {
  // Row position: a line literally `]` would close the array, and a line
  // literally `[` could be misread as an unterminated opener. Wrap both. Also
  // keep the standard literal/inline-object wrap rules.
  const cell = encodePrimitiveCell(v, (s) =>
    s.length === 0 ||
    s.trim() !== s ||
    s === "]" ||
    s === "[" ||
    s.startsWith(OPEN) ||
    s === "[]" || s === "{}" ||
    looksLikeLiteral(s) ||
    looksLikeInlineObject(s));
  if (cell !== null) return cell;
  // Object: must be a flat inline-object per eligibility above.
  return encodeInlineObject(v as JSONObject);
}

function bytes(leaves: string[]): number {
  let n = 0;
  for (const l of leaves) n += utf8Len(l) + 1; // +1 for the join newline
  return n;
}

function asPath(arr: JSONValue[], prefix: string, profile: EncodeProfile): string[] {
  const out: string[] = [];
  arr.forEach((item, i) => walk(item, `${prefix}[${i}]`, out, profile));
  return out;
}

function asTable(arr: JSONValue[], prefix: string): string[] | null {
  if (arr.length < 2) return null;
  const first = arr[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) return null;
  const cols = Object.keys(first).sort(compareUtf8);
  if (cols.length === 0) return null;
  for (const item of arr) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const itemKeys = Object.keys(item).sort(compareUtf8);
    if (itemKeys.length !== cols.length) return null;
    if (!itemKeys.every((k, i) => k === cols[i])) return null;
    for (const k of cols) {
      // ADR-0018 (supersedes TIER 2-D's "key absent" reading): a `null` cell
      // decodes to JSON null, exactly as the v0.3 spec defines a bare `null`
      // literal. Null cells are therefore round-trip safe in table mode.
      if (!isPrimitiveCellEligible((item as JSONObject)[k]!)) return null;
    }
  }
  for (const c of cols) {
    if (c.includes(",") || c.includes(OPEN) || c.includes(CLOSE) || c.includes("=") || c.includes(":")) {
      return null;
    }
  }
  const leaves: string[] = [];
  leaves.push(`${prefix}::${cols.join(",")}`);
  arr.forEach((row, i) => {
    const cells = cols.map((c) => encodeTableCell((row as JSONObject)[c]!));
    leaves.push(`${prefix}[${i}]=${cells.join(",")}`);
  });
  return leaves;
}

function asInlineObjects(arr: JSONValue[], prefix: string): string[] | null {
  for (const item of arr) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    if (!eligibleForInlineObject(item as JSONObject)) return null;
  }
  return arr.map((row, i) => `${prefix}[${i}]=${encodeInlineObject(row as JSONObject)}`);
}

function eligibleForInlineObject(obj: JSONObject): boolean {
  const entries = Object.entries(obj);
  if (entries.length === 0) return false; // `{}` is the empty-object literal
  for (const [k, v] of entries) {
    if (!isInlineKeyEligible(k)) return false;
    if (!isPrimitiveCellEligible(v)) return false;
  }
  return true;
}

function isInlineKeyEligible(k: string): boolean {
  if (k.length === 0) return false;
  if (k.includes("\n") || k.includes("\r")) return false;
  if (k.includes(OPEN) || k.includes(CLOSE)) return false;
  return true;
}

function isPrimitiveCellEligible(v: JSONValue): boolean {
  if (v === null) return true;
  if (typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") {
    if (v.includes("\n") || v.includes("\r") || v.includes(CLOSE)) return false;
    return true;
  }
  return false;
}

function encodeInlineObject(obj: JSONObject): string {
  const keys = Object.keys(obj).sort(compareUtf8);
  const pairs = keys.map((k) => {
    const key = needsInlineKeyQuoting(k) ? `${OPEN}${k}${CLOSE}` : k;
    return `${key}=${encodeInlineCell(obj[k]!)}`;
  });
  return `{${pairs.join(",")}}`;
}

function needsInlineKeyQuoting(k: string): boolean {
  // Inside `{...}`, `,` and `}` and `=` and `:` are all syntactically
  // significant. Also keep the path-key wrap triggers since the unwrapped
  // key path is used as the JSON key.
  for (const c of k) {
    if (c === "." || c === "[" || c === "]" || c === "=" || c === ":" ||
        c === "," || c === "{" || c === "}") {
      return true;
    }
  }
  if (/^\s|\s$/.test(k)) return true;
  return false;
}

function encodeInlineCell(v: JSONValue): string {
  // `{` and a non-leading `<<<` are wrap triggers (ADR-0018): the decoder's
  // top-level comma splitter tracks `{`-depth and skips `<<<…>>>` ranges, so
  // either character appearing bare mid-cell desynchronizes the split and
  // silently merges or drops neighboring cells.
  const cell = encodePrimitiveCell(v, (s) =>
    s.length === 0 ||
    s.trim() !== s ||
    s.includes(",") ||
    s.includes("}") ||
    s.includes("{") ||
    s.includes(OPEN) ||
    s === "[]" ||
    looksLikeLiteral(s));
  if (cell === null) throw new Error(`unexpected inline cell: ${String(v)}`);
  return cell;
}

function encodeTableCell(v: JSONValue): string {
  // Same comma-splitter triggers as inline cells (ADR-0018), plus the
  // opener-tail hazard: a table row is a whole line, so a final cell ending
  // in `=<<<` / `=[` would turn the row into a block opener.
  const cell = encodePrimitiveCell(v, (s) =>
    s.length === 0 ||
    s.trim() !== s ||
    s.includes(",") ||
    s.includes("{") ||
    s.includes(OPEN) ||
    s === "[]" ||
    looksLikeLiteral(s) ||
    hasOpenerTail(s));
  if (cell === null) throw new Error(`unexpected table cell value: ${String(v)}`);
  return cell;
}

// A string "looks like" an inline object if it would parse as `{key=val(,key=val)*}`.
// Used at encode time to force a wrap so the decoder doesn't reinterpret it.
function looksLikeInlineObject(s: string): boolean {
  if (!s.startsWith("{") || !s.endsWith("}")) return false;
  if (s === "{}") return false; // already handled as empty-object literal
  return tryParseInlineObject(s) !== null;
}

function joinKey(prefix: string, key: string): string {
  const encoded = needsKeyQuoting(key) ? `${OPEN}${key}${CLOSE}` : key;
  return prefix === "" ? encoded : `${prefix}.${encoded}`;
}

function needsKeyQuoting(key: string): boolean {
  if (key.length === 0) return true;
  if (key.includes(OPEN) || key.includes(CLOSE)) {
    throw new Error(`key contains <<< or >>> which is unsupported in this prototype: ${key}`);
  }
  for (const c of key) {
    if (c === "." || c === "[" || c === "]" || c === "=" || c === ":" || c === "\n" || c === "\r") {
      return true;
    }
  }
  if (/^\s|\s$/.test(key)) return true;
  return false;
}

const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function looksLikeLiteral(s: string): boolean {
  if (s === "true" || s === "false" || s === "null") return true;
  return NUMBER_RE.test(s);
}

// Encode one string value as the leaf suffix INCLUDING its separator:
// `=bare`, `:s=raw` (type-tag form, spec §3.6), `=<<<…>>>`, or a multiline
// block. The type-tag form is canonical whenever it is safe — it is always
// 4 bytes shorter than the wrapped form and the typed parser takes the rest
// of the line verbatim (ADR-0018).
function encodeStringLeaf(value: string): string {
  // Values containing `\n` use the line-bounded form. The nonce is only
  // required when a content line literally equals `>>>` (which would
  // terminate the bare form early). See ADR-0011. A lone `\r` (no `\n`)
  // stays on a single line — the parser splits on `\n` only, and the decoder
  // treats `\r` as data, so it round-trips byte-exactly (ADR-0018).
  if (value.includes("\n")) {
    const lines = value.split("\n");
    const collides = lines.some((l) => stripCR(l) === CLOSE);
    if (collides) {
      const nonce = nonceFor(value);
      return `=${OPEN}${nonce}\n${value}\n${CLOSE}${nonce}`;
    }
    return `=${OPEN}\n${value}\n${CLOSE}`;
  }
  // Single-line. ADR-0007 wrap conditions: only true ambiguities. Strings
  // containing `,`, `:`, `[`, `]` are safe bare — parser locks separator
  // first.
  const needsProtection =
    value.length === 0 ||
    value.trim() !== value ||
    value.startsWith(OPEN) ||
    value === "[]" || value === "{}" ||
    value.includes(CLOSE) ||
    hasOpenerTail(value) ||
    looksLikeLiteral(value) ||
    looksLikeInlineObject(value);
  if (!needsProtection) return `=${value}`;
  // Type-tag form is unsafe when surrounding whitespace could be eaten by the
  // document trim, when the raw value would be unwrapped by the typed parser
  // (`<<<…>>>`-shaped), or when the assembled line would look like a block
  // opener. Those cases keep the `<<<…>>>` wrap.
  const tagSafe =
    value.trim() === value &&
    !hasOpenerTail(value) &&
    !(value.startsWith(OPEN) && value.endsWith(CLOSE));
  if (tagSafe) return `:s=${value}`;
  return `=${OPEN}${value}${CLOSE}`;
}

// Deterministic content-derived nonce (ADR-0018): canonical RAIF must be
// byte-identical run-to-run (validate(encode(x)) and fix idempotence depend
// on it), so the nonce is an FNV-1a hash of the block content, re-hashed
// until it collides with nothing inside the value.
function nonceFor(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let nonce = (h & 0xffff).toString(16).padStart(4, "0");
  while (value.includes(`${CLOSE}${nonce}`)) {
    h = Math.imul(h ^ 0x9e3779b9, 0x01000193) >>> 0;
    nonce = (h & 0xffff).toString(16).padStart(4, "0");
  }
  return nonce;
}

// ─── Schema (ADR-0016 schema-as-parity, ADR-0019 schema-typed decode) ──
//
// When a schema is supplied, value types come from the schema, not from
// value-shape inference: bare `null` under a required `to:s` is the string
// "null", `priority=2` under `priority:s` is the string "2". This removes
// the wrap-when-literal ambiguity class — the dominant fidelity failure in
// every model harness run — by construction. Bare `null` under an optional
// field (`note:s?`) is JSON null; the tagged form (`note:s=null`) is always
// the string. `n`/`b` values must parse or surface a validation error — the
// interpreter never coerces (ADR-0004).

export type SchemaType = "s" | "n" | "b" | "t" | "o";

export interface SchemaNode {
  type?: SchemaType;
  optional: boolean;
  element?: SchemaNode; // declared with `[]`
  children?: Map<string, SchemaNode>; // nested object fields
}

export interface RaifSchema {
  root: SchemaNode;
}

// Sentinel for "anything goes from here down": a node declared `:o` accepts
// arbitrary children with inferred types — distinct from `undefined`, which
// means "not in the schema" and is a validation error.
const OPEN_NODE: SchemaNode = { optional: true };

// Parse a schema declaration — the inner lines of a `<schema>` block, which
// is also accepted verbatim (the wrapper tags are ignored):
//   to:s            string field        priority:n      number
//   tags[]:s        array of strings    items[].id:n    field of each element
//   user.handle:s   nested path         note:s?         optional / nullable
//   items[]:o       array of open objects
//   <<<a.b>>>:s     pathological key (wrapped, consistent with the wire form)
export function parseSchema(decl: string): RaifSchema {
  const root: SchemaNode = { optional: false, children: new Map() };
  const lines = decl.replace(/<\/?schema>/g, "").split("\n");
  for (const [idx, rawLine] of lines.entries()) {
    const line = stripCR(rawLine).trim();
    if (line.length === 0) continue;
    const at = (msg: string) => new Error(`schema line ${idx + 1}: ${msg}`);
    const sep = findTopLevelChar(line, ":");
    if (sep === -1) throw at(`missing ':' in '${line}'`);
    const tm = line.slice(sep + 1).trim().match(/^([sntbo])(\?)?$/);
    if (!tm) throw at(`bad type '${line.slice(sep + 1).trim()}'`);
    const segs = parseSchemaPath(line.slice(0, sep).trim(), at);
    let node = root;
    let field = root;
    for (const seg of segs) {
      node.children ??= new Map();
      let child = node.children.get(seg.name);
      if (!child) {
        child = { optional: false };
        node.children.set(seg.name, child);
      }
      field = child;
      node = child;
      for (let a = 0; a < seg.arrays; a++) {
        node.element ??= { optional: false };
        node = node.element;
      }
    }
    node.type = tm[1] as SchemaType;
    if (tm[2]) field.optional = true; // `?` marks the field, not the element
  }
  return { root };
}

function parseSchemaPath(
  path: string,
  at: (msg: string) => Error,
): { name: string; arrays: number }[] {
  const segs: { name: string; arrays: number }[] = [];
  let i = 0;
  while (i < path.length) {
    let name: string;
    if (path.startsWith(OPEN, i)) {
      const end = path.indexOf(CLOSE, i + OPEN.length);
      if (end === -1) throw at(`unterminated <<< in '${path}'`);
      name = path.slice(i + OPEN.length, end);
      i = end + CLOSE.length;
    } else {
      let j = i;
      while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
      name = path.slice(i, j);
      i = j;
    }
    if (name.length === 0) throw at(`empty segment in '${path}'`);
    let arrays = 0;
    while (path.startsWith("[]", i)) {
      arrays++;
      i += 2;
    }
    if (i < path.length) {
      if (path[i] !== ".") throw at(`malformed path '${path}'`);
      i++;
      if (i === path.length) throw at(`trailing '.' in '${path}'`);
    }
    segs.push({ name, arrays });
  }
  if (segs.length === 0) throw at("empty path");
  return segs;
}

function toSchema(schema?: RaifSchema | string): SchemaNode | undefined {
  if (schema === undefined) return undefined;
  return typeof schema === "string" ? parseSchema(schema).root : schema.root;
}

// Walk a parsed leaf path through the schema. Returns the resolved node,
// OPEN_NODE for anything below an undeclared point inside an `:o` boundary
// (declared children of an `o` node are still honored — `o` means "extra
// fields allowed", not "ignore the declarations"), or undefined for paths
// the schema does not admit.
function resolveNode(node: SchemaNode | undefined, segs: PathSegment[]): SchemaNode | undefined {
  let cur: SchemaNode | undefined = node;
  for (const seg of segs) {
    if (cur === undefined) return undefined;
    if (cur === OPEN_NODE) return OPEN_NODE;
    const next = seg.kind === "key" ? cur.children?.get(seg.name) : cur.element;
    if (next === undefined && cur.type === "o") return OPEN_NODE;
    cur = next;
  }
  return cur;
}

// Child node for a named cell (inline-object pair or table column).
function childNode(node: SchemaNode | undefined, key: string): SchemaNode | undefined {
  if (node === undefined) return undefined;
  if (node === OPEN_NODE) return OPEN_NODE;
  const child = node.children?.get(key);
  if (child === undefined && node.type === "o") return OPEN_NODE;
  return child;
}

// After assembly: every non-optional declared field must be present.
function checkRequired(node: SchemaNode, value: JSONValue, path: string, missing: string[]): void {
  if (value === null || node === OPEN_NODE) return;
  if (node.children && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, child] of node.children) {
      const p = path === "" ? k : `${path}.${k}`;
      const v = safeGet(value as JSONObject, k);
      if (v === undefined) {
        if (!child.optional) missing.push(p);
        continue;
      }
      checkRequired(child, v, p, missing);
    }
  }
  if (node.element && Array.isArray(value)) {
    value.forEach((v, i) => checkRequired(node.element!, v, `${path}[${i}]`, missing));
  }
}

// ─── Decoder ──────────────────────────────────────────────────────────

export type Repair = { kind: string; detail?: string };

export type DecodeResult =
  | { ok: true; value: JSONObject; repairs: Repair[] }
  | { ok: false; error: string; repairs: Repair[] };

export type FixResult =
  | { ok: true; canonical: string; repairs: Repair[] }
  | { ok: false; error: string; repairs: Repair[] };

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export type LeafError = { line?: number; key?: string; error: string };

export type LenientDecodeResult = {
  value: JSONObject;
  errors: LeafError[];
  repairs: Repair[];
  // True when the input shows truncation signatures: a `<raif>` opener with
  // no closer, or a multiline block / array literal closed at EOF. The final
  // recovered leaves should be treated as suspect.
  truncated: boolean;
};

const TRUNCATION_REPAIRS = new Set([
  "missing_close_marker",
  "unterminated_block_closed_at_eof",
  "unterminated_array_closed_at_eof",
]);

// Internal pipeline shared by `decode`, `fix`, and `validate`. Runs every
// repair phase (TIER 1 surface + TIER 1A/1B + TIER 2 A/B/C/D) and returns
// both the JSON projection and the canonical re-emission so callers can take
// whichever they need without re-running the pipeline.
//
// The state's `repairs` array is mutated in-place by phase functions; callers
// receive it back unchanged in shape. Throws on unrepairable input — callers
// wrap in try/catch and convert to a result type.
function fixInternal(
  input: string,
  repairs: Repair[],
  schema?: SchemaNode,
): { json: JSONObject; canonical: string } {
  const text = prepareText(input, repairs);
  let leaves = parseLeaves(text, repairs);
  leaves = repairRepeatedKeys(leaves, repairs);
  const json = assemble(leaves, repairs, undefined, schema);
  const canonical = encode(json);
  return { json, canonical };
}

// Surface pre-passes shared by strict and lenient decoding. Line-ending
// handling (ADR-0018): only document-wide CRLF is treated as structural and
// stripped here — a global `\r` → `\n` rewrite would corrupt `\r` bytes
// inside multiline block content and single-line values. Stray trailing `\r`
// on individual structural lines is stripped during parsing instead, where
// block content can be excluded.
function prepareText(input: string, repairs: Repair[]): string {
  let text = input;
  const stripped = stripMarkdownFences(text);
  if (stripped !== text) {
    repairs.push({ kind: "markdown_stripped" });
    text = stripped;
  }
  const lines = text.split("\n");
  if (lines.length > 1 && lines.slice(0, -1).every((l) => l.endsWith("\r"))) {
    repairs.push({ kind: "line_endings_normalized" });
    text = lines.map(stripCR).join("\n");
  }
  text = stripModeMarkers(text, repairs);
  text = text.replace(/^\s+|\s+$/g, "");
  text = flattenMultilineBraces(text, repairs);
  return text;
}

// TIER 2-B (ADR-0015): repeated-key auto-indexing.
//
// When the same leaf key appears two or more times at the same scope and no
// conflicting indexed form (`key[N]`) or table header (`key::`) already
// claims the same prefix, rewrite the repeated leaves' keys to `key[0]`,
// `key[1]`, … in encounter order. Refuses to fire when any of the named
// conflicts are present — those are ambiguous and surface as the original
// path-collision error.
//
// The body kind of each rewritten leaf is preserved; this repair touches
// keys only, never values, in keeping with ADR-0004's syntax-not-values rule.
function repairRepeatedKeys(leaves: ParsedLeaf[], repairs: Repair[]): ParsedLeaf[] {
  const keyCount = new Map<string, number>();
  const indexedPrefixes = new Set<string>();
  const tableHeaderKeys = new Set<string>();
  for (const leaf of leaves) {
    if (leaf.body.kind === "table_header") {
      tableHeaderKeys.add(leaf.key);
      continue;
    }
    const m = leaf.key.match(/^(.+)\[\d+\]$/);
    if (m) indexedPrefixes.add(m[1]!);
    keyCount.set(leaf.key, (keyCount.get(leaf.key) ?? 0) + 1);
  }
  const repeatedKeys = new Set<string>();
  for (const [key, count] of keyCount) {
    if (count < 2) continue;
    if (indexedPrefixes.has(key)) continue;
    if (tableHeaderKeys.has(key)) continue;
    repeatedKeys.add(key);
  }
  if (repeatedKeys.size === 0) return leaves;
  const indexCounter = new Map<string, number>();
  const out = leaves.map((leaf) => {
    if (!repeatedKeys.has(leaf.key)) return leaf;
    const idx = indexCounter.get(leaf.key) ?? 0;
    indexCounter.set(leaf.key, idx + 1);
    return { ...leaf, key: `${leaf.key}[${idx}]` };
  });
  const sortedKeys = [...repeatedKeys].sort();
  repairs.push({ kind: "repeated_keys_indexed", detail: sortedKeys.join(",") });
  return out;
}

// JSON ↔ RAIF entry point. v0.4: composition `fix → parse → toJson`, but
// implemented as a single pipeline call that returns both projections so we
// don't pay the encode cost twice. With a schema (declaration text or a
// parsed RaifSchema), decoding is schema-typed per ADR-0019.
export function decode(input: string, schema?: RaifSchema | string): DecodeResult {
  const repairs: Repair[] = [];
  try {
    const { json } = fixInternal(input, repairs, toSchema(schema));
    return { ok: true, value: json, repairs };
  } catch (e) {
    return { ok: false, error: (e as Error).message, repairs };
  }
}

// Per-leaf recovery (spec §3.1/§11, ADR-0018): never throws. Bad leaves are
// skipped and reported; every leaf that parses lands in `value`. This is the
// entry point for agent runtimes that re-ask the model for only the broken
// fields instead of regenerating the whole object.
export function decodeLenient(input: string, schema?: RaifSchema | string): LenientDecodeResult {
  const repairs: Repair[] = [];
  const errors: LeafError[] = [];
  const text = prepareText(input, repairs);
  let leaves = parseLeaves(text, repairs, errors);
  leaves = repairRepeatedKeys(leaves, repairs);
  const value = assemble(leaves, repairs, errors, toSchema(schema));
  const truncated = repairs.some((r) => TRUNCATION_REPAIRS.has(r.kind));
  return { value, errors, repairs, truncated };
}

// RAIF → canonical RAIF. The pure repair/canonicalization operation. Output
// is byte-identical for any input that reduces to the same JSON value —
// including multiline nonces, which are content-derived (ADR-0018). ADR-0014.
export function fix(input: string, schema?: RaifSchema | string): FixResult {
  const repairs: Repair[] = [];
  try {
    const { canonical } = fixInternal(input, repairs, toSchema(schema));
    return { ok: true, canonical, repairs };
  } catch (e) {
    return { ok: false, error: (e as Error).message, repairs };
  }
}

// Pure read-only canonicality check. `ok: true` ⟺ the input is already
// canonical RAIF (and `fix(input).canonical === input`). Never mutates;
// errors carry the same messages the pipeline would surface. ADR-0014.
export function validate(input: string, schema?: RaifSchema | string): ValidationResult {
  const repairs: Repair[] = [];
  let canonical: string;
  try {
    const out = fixInternal(input, repairs, toSchema(schema));
    canonical = out.canonical;
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  if (repairs.length > 0) {
    return { ok: false, errors: [`non-canonical: ${repairs.length} repair(s) needed`] };
  }
  if (canonical !== input) {
    return { ok: false, errors: ["non-canonical: differs from canonical form"] };
  }
  return { ok: true };
}

function stripMarkdownFences(text: string): string {
  const fence = text.match(/^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/);
  if (fence) return fence[1]!;
  return text;
}

// Strip `<raif>` / `</raif>` mode markers and their special-token equivalents
// (`<|raif_start|>` / `<|raif_end|>`) — but only at the document edges, where
// runtime framing lives (spec §8). A marker-looking token elsewhere is value
// content; a global rewrite would corrupt it (same failure family as the
// brace-flattening bug fixed in ADR-0018). An opener with no closer is the
// truncation signature, recorded as `missing_close_marker`.
// Anchored to whole lines at the document edges: a marker token glued to
// other content (e.g. the value `s=</raif>` on the final line) is data.
const MODE_OPEN_EDGE_RE = /^\s*(?:<\|raif_start\|>|<raif>)(?:\n|$)/;
const MODE_CLOSE_EDGE_RE = /(?:^|\n)(?:<\|raif_end\|>|<\/raif>)\s*$/;

function stripModeMarkers(text: string, repairs: Repair[]): string {
  const opened = MODE_OPEN_EDGE_RE.test(text);
  const closed = MODE_CLOSE_EDGE_RE.test(text);
  if (!opened && !closed) return text;
  repairs.push({ kind: "mode_markers_stripped" });
  if (opened && !closed) repairs.push({ kind: "missing_close_marker" });
  return text.replace(MODE_OPEN_EDGE_RE, "").replace(MODE_CLOSE_EDGE_RE, "");
}

// Repair: multi-line JSON-style brace blocks → path-mode leaves.
//
// Small models emitting RAIF often fall back on JSON syntax for nested objects:
//
//   a={
//     b={
//       c=1
//     }
//   }
//
// The spec only knows single-line inline-object `a={b={c=1}}` (which we
// reject as nested anyway) and path-mode `a.b.c=1`. This pre-pass detects
// the multi-line shape, walks balanced `{ … }` with depth tracking, and
// rewrites each body leaf with the parent key path prepended. Indentation
// on body lines is stripped (the wire form doesn't carry it). Array literal
// blocks (`prefix=[ … ]`) inside a brace block are passed through verbatim —
// only the array opener key is prefixed; body rows are left untouched so the
// downstream array-literal parser (ADR-0013) sees them as elements.
//
// Strict per [ADR-0004]: the rewrite is purely structural. No value bytes
// are touched. Unbalanced blocks are left in place so the decoder surfaces
// the original error rather than silently swallowing data.
const BRACE_OPENER_LINE = /^(.+)=\{$/;
const ARRAY_OPENER_LINE = /^(.+)=\[$/;

function flattenMultilineBraces(text: string, repairs: Repair[]): string {
  if (!/={\s*$/m.test(text)) return text;
  const lines = text.split("\n");
  const result = flattenBraceBlock(lines, 0, lines.length, "");
  if (result.changed) repairs.push({ kind: "multiline_braces_flattened" });
  return result.lines.join("\n");
}

// Find the line index of the exact `>>>NONCE` closer for the multiline block
// opened at `idx`, or `end` when no closer exists (truncation — the rest of
// the region is block content). Used by the brace-flattening pre-pass so it
// never rewrites block content: those are value bytes, and repairs must not
// touch value bytes (ADR-0004 / ADR-0018).
function multilineBlockEnd(lines: string[], idx: number, end: number, nonce: string): number {
  for (let j = idx + 1; j < end; j++) {
    if (stripCR(lines[j]!) === `${CLOSE}${nonce}`) return j;
  }
  return end;
}

function flattenBraceBlock(
  lines: string[],
  start: number,
  end: number,
  prefix: string,
): { lines: string[]; changed: boolean } {
  const out: string[] = [];
  let changed = false;
  let arrDepth = 0;
  let i = start;
  while (i < end) {
    const raw = lines[i]!;
    const trimmed = stripCR(raw).trim();

    // Inside an array literal: pass through verbatim. Track nested arrays so
    // we don't close on a `]` that belongs to a deeper level.
    if (arrDepth > 0) {
      out.push(raw);
      if (trimmed === "]") arrDepth--;
      else if (ARRAY_OPENER_LINE.test(trimmed)) arrDepth++;
      i++;
      continue;
    }

    // Multiline `<<<` block: pass the opener (prefixed when inside a brace
    // body) and every content line through verbatim.
    const mlOpen = trimmed.match(NONCE_OPENER_RE);
    if (mlOpen) {
      const blockEnd = multilineBlockEnd(lines, i, end, mlOpen[2]!);
      out.push(prefix ? `${prefix}.${trimmed}` : raw);
      for (let k = i + 1; k <= blockEnd && k < end; k++) out.push(lines[k]!);
      i = Math.min(blockEnd + 1, end);
      continue;
    }

    const braceOpen = trimmed.match(BRACE_OPENER_LINE);
    if (braceOpen) {
      const innerKey = braceOpen[1]!.trim();
      const fullKey = prefix ? `${prefix}.${innerKey}` : innerKey;
      // Walk to the matching `}` at the same brace depth. While inside a
      // nested array literal, ignore braces — `]` is the only thing that
      // closes that sub-region. Multiline blocks are skipped wholesale so
      // content lines can't shift the depth count.
      let depth = 1;
      let innerArr = 0;
      let j = i + 1;
      while (j < end) {
        const t = stripCR(lines[j]!).trim();
        const tOpen = innerArr === 0 ? t.match(NONCE_OPENER_RE) : null;
        if (innerArr > 0) {
          if (t === "]") innerArr--;
          else if (ARRAY_OPENER_LINE.test(t)) innerArr++;
        } else if (tOpen) {
          j = multilineBlockEnd(lines, j, end, tOpen[2]!);
          if (j >= end) break;
        } else if (t === "}") {
          depth--;
          if (depth === 0) break;
        } else if (BRACE_OPENER_LINE.test(t)) {
          depth++;
        } else if (ARRAY_OPENER_LINE.test(t)) {
          innerArr = 1;
        }
        j++;
      }
      if (depth !== 0) {
        // Unbalanced — bail out for this block and let the decoder produce
        // a parse error pointing at the actual structure.
        out.push(raw);
        i++;
        continue;
      }
      const inner = flattenBraceBlock(lines, i + 1, j, fullKey);
      for (const l of inner.lines) out.push(l);
      changed = true;
      i = j + 1; // skip the closing `}`
      continue;
    }

    // Array literal opener: prefix the key when inside a brace body, then
    // pass-through every row of the literal until the closing `]`.
    const arrOpen = trimmed.match(ARRAY_OPENER_LINE);
    if (arrOpen) {
      out.push(prefix ? `${prefix}.${trimmed}` : raw);
      arrDepth = 1;
      i++;
      continue;
    }

    if (trimmed.length === 0) {
      out.push(raw);
    } else if (prefix) {
      out.push(`${prefix}.${trimmed}`);
    } else {
      out.push(raw);
    }
    i++;
  }
  return { lines: out, changed };
}

type LeafKind =
  | { kind: "bare"; raw: string }
  | { kind: "typed"; type: "s" | "n" | "b" | "t"; raw: string }
  | { kind: "multiline"; raw: string }
  | { kind: "table_header"; cols: string[] }
  | { kind: "table_row"; cells: string[] }
  // Rows stay raw at parse time; values are decoded during assembly, where
  // the schema (element types) is in scope. Parse = syntax, assemble = values.
  | { kind: "array_literal"; rows: string[] };

interface ParsedLeaf {
  key: string;
  body: LeafKind;
}

// Multiline opener: `key=<<<NONCE` where NONCE is a (possibly empty) hex string
// and the line ends immediately after. Empty nonce is the bare line-form
// `<<<\n...\n>>>` introduced in ADR-0011.
const NONCE_OPENER_RE = /^(.*?)=<<<([0-9a-fA-F]*)$/;

// Array-literal opener (ADR-0013): the line ends with `=[` and the value is
// exactly `[`. We use a non-greedy capture so the key matches as little as
// possible — same shape as the nonce opener.
const ARRAY_OPENER_RE = /^(.+)=\[$/;

function parseLeaves(text: string, repairs: Repair[], lenientErrors?: LeafError[]): ParsedLeaf[] {
  const lines = text.split("\n");
  const leaves: ParsedLeaf[] = [];
  const tableCols = new Map<string, string[]>(); // prefix → column list, set when we see a header
  // Strip a stray trailing `\r` from a line being read as structure (leaf,
  // opener, closer, row). Block content lines are never passed through here —
  // their bytes are data. Document-wide CRLF was already handled upstream.
  let crRepaired = false;
  const structural = (raw: string): string => {
    const s = stripCR(raw);
    if (s !== raw && !crRepaired) {
      crRepaired = true;
      repairs.push({ kind: "line_endings_normalized" });
    }
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = structural(lines[i]!);
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    // Array-literal opener: `key=[` at end of line. Consume subsequent lines
    // until a line equal to `]`. Each consumed line is one element. A missing
    // closer at end of input is the truncation signature — close at EOF and
    // record the repair (ADR-0018; supersedes the v0.3 hard error).
    const arrOpener = line.match(ARRAY_OPENER_RE);
    if (arrOpener) {
      const key = arrOpener[1]!;
      const rows: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const rowLine = structural(lines[j]!);
        if (rowLine === "]") {
          closed = true;
          break;
        }
        if (rowLine.trim().length > 0) rows.push(rowLine);
        j++;
      }
      if (!closed) {
        repairs.push({ kind: "unterminated_array_closed_at_eof", detail: `key '${key}'` });
      }
      leaves.push({ key, body: { kind: "array_literal", rows } });
      i = closed ? j + 1 : j;
      continue;
    }
    const opener = line.match(NONCE_OPENER_RE);
    if (opener) {
      const key = opener[1]!;
      const nonce = opener[2]!;
      const closer = `${CLOSE}${nonce}`;
      const content: string[] = [];
      let j = i + 1;
      while (j < lines.length && stripCR(lines[j]!) !== closer) {
        content.push(lines[j]!);
        j++;
      }
      if (j < lines.length) {
        structural(lines[j]!); // record the CR repair if the closer carried one
        leaves.push({ key, body: { kind: "multiline", raw: content.join("\n") } });
        i = j + 1;
        continue;
      }
      // No exact-match closer. Recovery ladder:
      //   (a) exactly one `>>>…` line downstream (mismatched-nonce typo),
      //       with a same-length tie-break among several;
      //   (b) a closer with fewer `>`s but the matching nonce (TIER 1B);
      //   (c) no closer-like line at all → truncation; close at EOF
      //       (ADR-0018). Multiple ambiguous candidates still refuse.
      const candidates = closerCandidates(lines, i + 1);
      let recovered: number | null = null;
      if (candidates.length === 1) {
        recovered = candidates[0]!;
      } else if (candidates.length > 1 && nonce.length > 0) {
        const sameLen = candidates.filter(
          (k) => stripCR(lines[k]!).length === CLOSE.length + nonce.length,
        );
        if (sameLen.length === 1) recovered = sameLen[0]!;
      }
      if (recovered !== null) {
        repairs.push({ kind: "mismatched_nonce_recovered", detail: `nonce ${nonce}` });
        const body: string[] = [];
        for (let k = i + 1; k < recovered; k++) body.push(lines[k]!);
        leaves.push({ key, body: { kind: "multiline", raw: body.join("\n") } });
        i = recovered + 1;
        continue;
      }
      const relaxed = findRelaxedCloser(lines, i, nonce);
      if (relaxed !== null) {
        repairs.push({
          kind: "delimiter_count_repaired",
          detail: `opener=<×3 closer=>×${relaxed.closerCount}`,
        });
        const body: string[] = [];
        for (let k = i + 1; k < relaxed.line; k++) body.push(lines[k]!);
        leaves.push({ key, body: { kind: "multiline", raw: body.join("\n") } });
        i = relaxed.line + 1;
        continue;
      }
      if (candidates.length === 0) {
        repairs.push({ kind: "unterminated_block_closed_at_eof", detail: `key '${key}'` });
        leaves.push({ key, body: { kind: "multiline", raw: content.join("\n") } });
        i = lines.length;
        continue;
      }
      const err = new Error(
        `unterminated multiline block at line ${i + 1} (nonce ${nonce || "<none>"}): ambiguous closers`,
      );
      if (!lenientErrors) throw err;
      lenientErrors.push({ line: i + 1, key, error: err.message });
      i++;
      continue;
    }
    // Relaxed multiline opener: `key=<<` or `key=<` at end of line. Only
    // accepted when (a) a `>{1,3}NONCE` closer line exists downstream and
    // (b) at least one line between opener and closer does NOT look like
    // an ordinary leaf — so bare-string values such as `s=<<` followed by
    // a real leaf don't get hijacked. Repair recorded as
    // `delimiter_count_repaired`.
    const relaxedOpener = line.match(RELAXED_OPENER_RE);
    if (relaxedOpener) {
      const openerCount = relaxedOpener[2]!.length;
      const found = findRelaxedCloser(lines, i, relaxedOpener[3]!);
      if (found !== null) {
        const between = lines.slice(i + 1, found.line);
        const looksLikeMultilineContent = between.some((l) => !LEAF_LIKE.test(l));
        if (looksLikeMultilineContent || between.length === 0) {
          repairs.push({
            kind: "delimiter_count_repaired",
            detail: `opener=<×${openerCount} closer=>×${found.closerCount}`,
          });
          leaves.push({
            key: relaxedOpener[1]!,
            body: { kind: "multiline", raw: between.join("\n") },
          });
          i = found.line + 1;
          continue;
        }
      }
    }
    try {
      leaves.push(parseSingleLineLeaf(line, i + 1, tableCols, repairs));
    } catch (e) {
      if (!lenientErrors) throw e;
      lenientErrors.push({ line: i + 1, error: (e as Error).message });
    }
    i++;
  }
  return leaves;
}

// Relaxed opener: 1 or 2 `<` chars (strict 3 is handled by NONCE_OPENER_RE).
const RELAXED_OPENER_RE = /^(.*?)=(<{1,2})([0-9a-fA-F]*)$/;

// A line "looks like a leaf" when it has a top-level KV separator: `=`,
// `::` (table header), or `:[sntb]=` (typed leaf). Bare colons (e.g. in
// timestamps like `14:02` or "Root cause: …") don't match.
const LEAF_LIKE = /^[^=:]*(=|::|:[sntb]=)/;

function findRelaxedCloser(
  lines: string[],
  openerIdx: number,
  nonce: string,
): { line: number; closerCount: number } | null {
  for (let j = openerIdx + 1; j < lines.length; j++) {
    const cm = stripCR(lines[j]!).match(/^(>{1,3})([0-9a-fA-F]*)$/);
    if (cm && cm[2] === nonce) {
      return { line: j, closerCount: cm[1]!.length };
    }
  }
  return null;
}

// Indices of every downstream line shaped like a `>>>hex` closer — plausible
// mismatched-nonce closer candidates. The caller repairs only when the
// candidate is unambiguous (one candidate, or one same-length candidate);
// zero candidates means truncation, several mean refuse (ADR-0004).
function closerCandidates(lines: string[], from: number): number[] {
  const candidates: number[] = [];
  for (let k = from; k < lines.length; k++) {
    if (/^>>>[0-9a-fA-F]*$/.test(stripCR(lines[k]!))) candidates.push(k);
  }
  return candidates;
}

function parseSingleLineLeaf(
  line: string,
  lineNum: number,
  tableCols: Map<string, string[]>,
  repairs: Repair[],
): ParsedLeaf {
  // Find the first top-level `=` or `:`, skipping past any <<<...>>> ranges.
  let i = 0;
  let sepIndex = -1;
  let sepChar = "";
  let isDoubleColon = false;
  while (i < line.length) {
    if (line.startsWith(OPEN, i)) {
      const end = line.indexOf(CLOSE, i + OPEN.length);
      if (end === -1) break;
      i = end + CLOSE.length;
      continue;
    }
    const c = line[i]!;
    if (c === "=") {
      sepIndex = i;
      sepChar = "=";
      break;
    }
    if (c === ":") {
      if (line[i + 1] === ":") {
        sepIndex = i;
        sepChar = ":";
        isDoubleColon = true;
      } else {
        sepIndex = i;
        sepChar = ":";
      }
      break;
    }
    i++;
  }
  if (sepIndex === -1) {
    throw new Error(`no separator in leaf at line ${lineNum}: ${line}`);
  }
  const key = line.slice(0, sepIndex);
  const rest = isDoubleColon ? line.slice(sepIndex + 2) : line.slice(sepIndex + 1);

  if (isDoubleColon) {
    const cols = splitTopLevelCommas(rest);
    tableCols.set(key, cols);
    return { key, body: { kind: "table_header", cols } };
  }

  if (sepChar === ":") {
    // Typed leaf: prefix:s=value | :n=value | :b=value | :t=value
    const typed = rest.match(/^([sntb])=(.*)$/s);
    if (typed) {
      return {
        key,
        body: { kind: "typed", type: typed[1] as "s" | "n" | "b" | "t", raw: typed[2]! },
      };
    }
    // Repair: stray `:` used as the KV separator instead of `=`. Coerce when
    // unambiguous (the suffix does not look like a typed-leaf prefix).
    repairs.push({ kind: "separator_coerced", detail: `':' → '=' at line ${lineNum}` });
    const tableRow = key.match(/^(.+)\[\d+\]$/);
    if (tableRow && tableCols.has(tableRow[1]!)) {
      const cells = splitTopLevelCommas(rest);
      return { key, body: { kind: "table_row", cells } };
    }
    return { key, body: { kind: "bare", raw: rest } };
  }

  // sepChar === "=". Check whether this is a table-mode row (key is `prefix[N]`
  // and `prefix` has a registered table header).
  const tableRow = key.match(/^(.+)\[\d+\]$/);
  if (tableRow && tableCols.has(tableRow[1]!)) {
    const cells = splitTopLevelCommas(rest);
    return { key, body: { kind: "table_row", cells } };
  }

  return { key, body: { kind: "bare", raw: rest } };
}

// Split a string at top-level commas. "Top-level" skips two kinds of nesting:
//  - <<<...>>> ranges (raw string delimiters)
//  - {...} ranges (nested inline-object brackets) — added in v0.4 / TIER 2-C
//    so that an outer inline-object containing nested inline-objects parses
//    correctly. The bracket-aware skip is harmless for inputs that don't
//    contain nesting and unlocks the C repair for inputs that do.
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  let braceDepth = 0;
  while (i < s.length) {
    if (s.startsWith(OPEN, i)) {
      const end = s.indexOf(CLOSE, i + OPEN.length);
      if (end === -1) break;
      i = end + CLOSE.length;
      continue;
    }
    const c = s[i]!;
    if (c === "{") {
      braceDepth++;
      i++;
      continue;
    }
    if (c === "}") {
      if (braceDepth > 0) braceDepth--;
      i++;
      continue;
    }
    if (c === "," && braceDepth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(s.slice(start));
  return out;
}

const MISSING: unique symbol = Symbol("MISSING");
type Slot = JSONValue | typeof MISSING;

// Keys come from model output, so plain `obj[key] = v` is unsafe: assigning
// `__proto__` would rewrite the prototype instead of creating an own property
// (prototype pollution). Match JSON.parse semantics: always define an own
// property, always read own properties only.
function safeSet(obj: JSONObject, key: string, value: JSONValue): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function safeGet(obj: JSONObject, key: string): JSONValue | undefined {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function assemble(
  leaves: ParsedLeaf[],
  repairs?: Repair[],
  lenientErrors?: LeafError[],
  schema?: SchemaNode,
): JSONObject {
  const root: JSONObject = {};
  const tableColsByKey = new Map<string, string[]>();

  // Resolve a leaf key against the schema. Falls back to a literal root-field
  // match for pathological keys the model left unwrapped (`user.email=…`
  // where the schema declares the flat field `user.email`) — the
  // schema-as-parity recovery of ADR-0016. Without a schema every leaf is
  // untyped and unchecked.
  const resolveLeaf = (key: string): { path: PathSegment[]; node: SchemaNode | undefined } => {
    const path = parsePath(key);
    if (!schema) return { path, node: undefined };
    const node = resolveNode(schema, path);
    if (node !== undefined) return { path, node };
    if (path.length > 1) {
      const literal = schema.children?.get(key);
      if (literal !== undefined) {
        repairs?.push({ kind: "pathological_key_resolved", detail: key });
        return { path: [{ kind: "key", name: key }], node: literal };
      }
    }
    throw new Error(`schema: unknown field '${key}'`);
  };

  for (const leaf of leaves) {
    try {
      if (leaf.body.kind === "table_header") {
        tableColsByKey.set(leaf.key, leaf.body.cols);
        // Header itself doesn't produce an inserted value; it just configures
        // the subsequent rows.
        continue;
      }
      if (leaf.body.kind === "array_literal") {
        const { path, node } = resolveLeaf(leaf.key);
        if (node && node !== OPEN_NODE && !node.element && node.type !== "o") {
          throw new Error(`schema: '${leaf.key}' is not an array`);
        }
        const elemNode =
          node === OPEN_NODE || node?.type === "o" ? OPEN_NODE : node?.element;
        const elements = leaf.body.rows.map((row) => decodeBareValue(row, repairs, elemNode));
        insert(root, path, elements);
        continue;
      }
      if (leaf.body.kind === "table_row") {
        // Key is prefix[N]; map cells to columns using the registered header.
        const m = leaf.key.match(/^(.+)\[(\d+)\]$/);
        if (!m) throw new Error(`table row key not indexable: ${leaf.key}`);
        const cols = tableColsByKey.get(m[1]!);
        if (!cols) throw new Error(`table row before header for prefix: ${m[1]}`);
        const cells = leaf.body.cells;
        if (cells.length !== cols.length) {
          throw new Error(
            `table row column count mismatch at ${leaf.key}: expected ${cols.length}, got ${cells.length}`,
          );
        }
        const { path, node } = resolveLeaf(leaf.key);
        const rowObj: JSONObject = {};
        cols.forEach((c, idx) => {
          // ADR-0018 (supersedes TIER 2-D's "key absent" reading): a `null`
          // cell is the JSON null value, exactly as a bare `null` literal
          // decodes everywhere else.
          const cellNode = childNode(node, c);
          if (schema && node && node !== OPEN_NODE && cellNode === undefined) {
            throw new Error(`schema: unknown column '${c}' at '${leaf.key}'`);
          }
          safeSet(rowObj, c, decodeBareValue(cells[idx]!, repairs, cellNode));
        });
        insert(root, path, rowObj);
        continue;
      }
      const { path, node } = resolveLeaf(leaf.key);
      const value = decodeBody(leaf.body, repairs, node);
      insert(root, path, value);
    } catch (e) {
      if (!lenientErrors) throw e;
      lenientErrors.push({ key: leaf.key, error: (e as Error).message });
    }
  }
  if (lenientErrors) {
    pruneSparseArrays(root, lenientErrors, "");
  } else {
    validateNoMissing(root, "");
  }
  if (schema) {
    const missing: string[] = [];
    checkRequired(schema, root, "", missing);
    if (missing.length > 0) {
      const err = `schema: missing required field(s): ${missing.join(", ")}`;
      if (!lenientErrors) throw new Error(err);
      for (const m of missing) lenientErrors.push({ key: m, error: "schema: missing required field" });
    }
  }
  return root;
}

// Lenient-mode counterpart of validateNoMissing: drop any subtree containing
// a sparse array (its leaves were lost or never emitted) instead of failing
// the whole document, and record what was dropped.
function pruneSparseArrays(obj: JSONObject, errors: LeafError[], path: string): void {
  for (const [k, v] of Object.entries(obj)) {
    const p = path === "" ? k : `${path}.${k}`;
    if (Array.isArray(v)) {
      if (containsMissing(v)) {
        delete obj[k];
        errors.push({ key: p, error: `sparse array under '${p}' — subtree dropped` });
      }
    } else if (v !== null && typeof v === "object") {
      pruneSparseArrays(v as JSONObject, errors, p);
    }
  }
}

function containsMissing(node: JSONValue): boolean {
  if (node === (MISSING as never)) return true;
  if (Array.isArray(node)) return node.some(containsMissing);
  if (node !== null && typeof node === "object") {
    return Object.values(node).some(containsMissing);
  }
  return false;
}

// Decode a single bare value as it appears after `=` on a leaf or as a cell
// inside an inline-object / table row. With a schema node, the type comes
// from the schema (ADR-0019); otherwise from value-shape inference. The
// optional `repairs` parameter is threaded through so the TIER 2-C audit
// entry can be recorded when nested inline-objects are flattened.
function decodeBareValue(raw: string, repairs?: Repair[], node?: SchemaNode): JSONValue {
  if (node === undefined || node === OPEN_NODE) return decodeInferred(raw, repairs);
  // Nullability: a bare `null` under an optional field is JSON null. The
  // tagged (`:s=null`) and wrapped (`<<<null>>>`) forms are always the string;
  // they don't pass through here as bare `null`.
  if (raw === "null" && node.optional) return null;
  return decodeSchemaTyped(raw, node, repairs);
}

function decodeInferred(raw: string, repairs?: Repair[]): JSONValue {
  if (raw.startsWith(OPEN) && raw.endsWith(CLOSE) && raw.length >= OPEN.length + CLOSE.length) {
    return raw.slice(OPEN.length, raw.length - CLOSE.length);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw === "[]") return [];
  if (raw === "{}") return {};
  if (NUMBER_RE.test(raw)) {
    const n = JSON.parse(raw) as number;
    // `1e999` is in the JSON number grammar but overflows a double; surface
    // a clear error instead of letting Infinity crash the re-encoder later.
    if (!Number.isFinite(n)) throw new Error(`number out of double range: ${raw}`);
    return n;
  }
  if (raw.startsWith("{") && raw.endsWith("}")) {
    const obj = tryParseInlineObject(raw, repairs);
    if (obj !== null) return obj;
  }
  return raw;
}

// Schema-typed interpretation of one raw value (ADR-0019). Declared `s`/`t`
// take the bytes verbatim (a wrap still unwraps — it is transport, not type
// assertion); `n`/`b` must parse or surface a validation error — never
// coerced (ADR-0004). `o` and undeclared structure fall back to inference.
function decodeSchemaTyped(raw: string, node: SchemaNode, repairs?: Repair[]): JSONValue {
  const wrapped =
    raw.startsWith(OPEN) && raw.endsWith(CLOSE) && raw.length >= OPEN.length + CLOSE.length;
  const inner = wrapped ? raw.slice(OPEN.length, raw.length - CLOSE.length) : raw;
  switch (node.type) {
    case "s":
    case "t":
      return inner;
    case "n": {
      if (!NUMBER_RE.test(inner)) throw new Error(`schema: expected number, got '${raw}'`);
      const n = JSON.parse(inner) as number;
      if (!Number.isFinite(n)) throw new Error(`number out of double range: ${inner}`);
      return n;
    }
    case "b":
      if (inner === "true") return true;
      if (inner === "false") return false;
      throw new Error(`schema: expected boolean, got '${raw}'`);
    case "o":
      // Open structure without declarations: plain inference. With declared
      // children, fall through to the structured handling below (childNode
      // supplies OPEN_NODE for undeclared cells).
      if (!node.children) return decodeInferred(raw, repairs);
      break;
  }
  if (node.element) {
    if (!wrapped && raw === "[]") return [];
    throw new Error(`schema: expected array, got '${raw}'`);
  }
  if (node.children) {
    if (!wrapped && raw === "{}") return {};
    if (!wrapped && raw.startsWith("{") && raw.endsWith("}")) {
      const obj = tryParseInlineObject(raw, repairs, node);
      if (obj !== null) return obj;
    }
    throw new Error(`schema: expected object, got '${raw}'`);
  }
  return decodeInferred(raw, repairs);
}

// Parse `{k=v,k=v}` into a JSON object. Returns null if the input does not
// match the inline-object grammar (then the caller treats raw as a string).
// Pairs are separated by top-level commas (skipping `<<<...>>>` and `{...}`
// ranges). Keys may be wrapped in `<<<>>>` for pathological characters.
// Values follow the bare-value grammar with `,` and `}` as wrap triggers.
//
// TIER 2-C (ADR-0015): if any parsed value is itself a non-primitive (nested
// inline-object, nested array literal token like `[]`, etc.), record the
// `nested_inline_flattened` repair. The wire grammar (ADR-0010) only allows
// primitive cells; we accept the spec-violating form during decode and audit
// the deviation. The encoder never produces this shape.
function tryParseInlineObject(s: string, repairs?: Repair[], node?: SchemaNode): JSONObject | null {
  if (s === "{}") return {};
  if (!s.startsWith("{") || !s.endsWith("}") || s.length < 2) return null;
  const inner = s.slice(1, -1);
  if (inner.length === 0) return null;
  const pairs = splitTopLevelCommas(inner);
  const out: JSONObject = {};
  let sawNested = false;
  for (const pair of pairs) {
    const eq = findTopLevelChar(pair, "=");
    if (eq === -1) return null;
    const rawKey = pair.slice(0, eq);
    const key = rawKey.startsWith(OPEN) && rawKey.endsWith(CLOSE) && rawKey.length >= OPEN.length + CLOSE.length
      ? rawKey.slice(OPEN.length, rawKey.length - CLOSE.length)
      : rawKey;
    if (key.length === 0) return null;
    if (Object.prototype.hasOwnProperty.call(out, key)) return null;
    const cellNode = childNode(node, key);
    if (node && node !== OPEN_NODE && node.children && cellNode === undefined) {
      throw new Error(`schema: unknown field '${key}' in inline object`);
    }
    const value = decodeBareValue(pair.slice(eq + 1), repairs, cellNode);
    if (value !== null && typeof value === "object") sawNested = true;
    safeSet(out, key, value);
  }
  if (sawNested && repairs) {
    repairs.push({ kind: "nested_inline_flattened" });
  }
  return out;
}

// First top-level occurrence of `ch`, skipping `<<<…>>>` ranges.
function findTopLevelChar(s: string, ch: string): number {
  let i = 0;
  while (i < s.length) {
    if (s.startsWith(OPEN, i)) {
      const end = s.indexOf(CLOSE, i + OPEN.length);
      if (end === -1) return -1;
      i = end + CLOSE.length;
      continue;
    }
    if (s[i] === ch) return i;
    i++;
  }
  return -1;
}

type PathSegment = { kind: "key"; name: string } | { kind: "index"; idx: number };

function parsePath(key: string): PathSegment[] {
  const segs: PathSegment[] = [];
  let i = 0;
  while (i < key.length) {
    if (key.startsWith(OPEN, i)) {
      const end = key.indexOf(CLOSE, i + OPEN.length);
      if (end === -1) throw new Error(`unterminated quoted key segment in: ${key}`);
      segs.push({ kind: "key", name: key.slice(i + OPEN.length, end) });
      i = consumeSegmentBoundary(key, end + CLOSE.length);
      continue;
    }
    if (key[i] === "[") {
      const end = key.indexOf("]", i + 1);
      if (end === -1) throw new Error(`unterminated index segment in: ${key}`);
      const rawIdx = key.slice(i + 1, end);
      // Strict per the refuse-don't-guess posture: `a[01]`, `a[1x]`, `a[1e5]`
      // previously slid through parseInt as index 1.
      if (!/^(0|[1-9]\d*)$/.test(rawIdx)) throw new Error(`bad index '${rawIdx}' in: ${key}`);
      segs.push({ kind: "index", idx: Number.parseInt(rawIdx, 10) });
      i = consumeSegmentBoundary(key, end + 1);
      continue;
    }
    let j = i;
    while (j < key.length && key[j] !== "." && key[j] !== "[") j++;
    if (j === i) throw new Error(`empty path segment in: ${key}`);
    segs.push({ kind: "key", name: key.slice(i, j) });
    i = key[j] === "." ? consumeSegmentBoundary(key, j) : j;
  }
  if (segs.length === 0) throw new Error("empty path");
  return segs;
}

// After a path segment ends at `pos`, the next character must be `.`
// (followed by another segment), `[`, or end-of-key. `a[1]b` and `a.`
// previously parsed silently as `a[1].b` / `a`.
function consumeSegmentBoundary(key: string, pos: number): number {
  if (pos >= key.length || key[pos] === "[") return pos;
  if (key[pos] === ".") {
    if (pos + 1 >= key.length) throw new Error(`trailing '.' in path: ${key}`);
    return pos + 1;
  }
  throw new Error(`malformed path after segment in: ${key}`);
}

function decodeBody(body: LeafKind, repairs?: Repair[], node?: SchemaNode): JSONValue {
  switch (body.kind) {
    case "multiline":
      if (node && node !== OPEN_NODE && node.type !== "s" && node.type !== "t" && node.type !== "o") {
        throw new Error(`schema: multiline block where ${expectedKind(node)} expected`);
      }
      return body.raw;
    case "typed":
      // Schema wins over the wire tag (ADR-0019): the tag is the model's
      // assertion, the schema is ground truth. The tagged form never takes
      // the bare-null rule — `note:s=null` is always the string "null".
      if (node && node !== OPEN_NODE) {
        return decodeSchemaTyped(body.raw, node, repairs);
      }
      if (body.type === "s" || body.type === "t") {
        return unwrapDelim(body.raw);
      }
      if (body.type === "n") {
        if (!NUMBER_RE.test(body.raw)) throw new Error(`bad number: ${body.raw}`);
        const n = JSON.parse(body.raw) as number;
        if (!Number.isFinite(n)) throw new Error(`number out of double range: ${body.raw}`);
        return n;
      }
      if (body.raw === "true") return true;
      if (body.raw === "false") return false;
      throw new Error(`bad boolean: ${body.raw}`);
    case "bare":
      return decodeBareValue(body.raw, repairs, node);
    case "table_header":
    case "table_row":
    case "array_literal":
      // Handled in assemble(); should never reach here.
      throw new Error(`internal: decodeBody called on ${body.kind}`);
  }
}

const expectedKind = (node: SchemaNode): string =>
  node.element ? "array" : node.children ? "object" : node.type ?? "value";

function unwrapDelim(raw: string): string {
  if (raw.startsWith(OPEN) && raw.endsWith(CLOSE) && raw.length >= OPEN.length + CLOSE.length) {
    return raw.slice(OPEN.length, raw.length - CLOSE.length);
  }
  return raw;
}

function insert(root: JSONObject, path: PathSegment[], value: JSONValue): void {
  let cursor: JSONObject | JSONValue[] = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    const next = path[i + 1]!;
    const childInit: JSONObject | JSONValue[] = next.kind === "index" ? [] : {};
    if (seg.kind === "key") {
      if (Array.isArray(cursor)) throw new Error(`path collision: list expected dict-key '${seg.name}'`);
      const existing: JSONValue | undefined = safeGet(cursor as JSONObject, seg.name);
      if (existing === undefined) {
        safeSet(cursor as JSONObject, seg.name, childInit);
        cursor = childInit;
      } else if (Array.isArray(existing) && next.kind === "index") {
        cursor = existing;
      } else if (typeof existing === "object" && existing !== null && !Array.isArray(existing) && next.kind === "key") {
        cursor = existing as JSONObject;
      } else {
        throw new Error(`path collision at '${seg.name}'`);
      }
    } else {
      if (!Array.isArray(cursor)) throw new Error(`path collision: dict expected list-index ${seg.idx}`);
      while (cursor.length <= seg.idx) (cursor as Slot[]).push(MISSING as never);
      const existing: JSONValue = cursor[seg.idx]!;
      if (existing === (MISSING as never)) {
        cursor[seg.idx] = childInit;
        cursor = childInit;
      } else if (Array.isArray(existing) && next.kind === "index") {
        cursor = existing;
      } else if (typeof existing === "object" && existing !== null && !Array.isArray(existing) && next.kind === "key") {
        cursor = existing as JSONObject;
      } else {
        throw new Error(`path collision at index ${seg.idx}`);
      }
    }
  }
  const last = path[path.length - 1]!;
  if (last.kind === "key") {
    if (Array.isArray(cursor)) throw new Error(`path collision: list expected dict-key '${last.name}'`);
    if (safeGet(cursor as JSONObject, last.name) !== undefined) {
      throw new Error(`path collision: '${last.name}' already exists`);
    }
    safeSet(cursor as JSONObject, last.name, value);
  } else {
    if (!Array.isArray(cursor)) throw new Error(`path collision: dict expected list-index ${last.idx}`);
    while (cursor.length <= last.idx) (cursor as Slot[]).push(MISSING as never);
    if (cursor[last.idx] !== (MISSING as never)) {
      throw new Error(`path collision: index ${last.idx} already exists`);
    }
    cursor[last.idx] = value;
  }
}

function validateNoMissing(node: JSONValue, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      if (v === (MISSING as never)) {
        throw new Error(`sparse array at ${path}[${i}] — RAIF rejects sparse arrays`);
      }
      validateNoMissing(v, `${path}[${i}]`);
    });
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      validateNoMissing(v, path === "" ? k : `${path}.${k}`);
    }
  }
}
