// Property-style tests beyond corpus round-trip. Run with: bun test
// Uses Bun's built-in test runner — no extra deps.

import { test, expect, describe } from "bun:test";
import { encode, decode, decodeLenient, fix, validate, type JSONObject } from "./raif.ts";

function roundTrip(obj: JSONObject): JSONObject {
  const raif = encode(obj);
  const r = decode(raif);
  if (!r.ok) throw new Error(`decode failed: ${r.error}\nraif was:\n${raif}`);
  return r.value;
}

describe("encoder shape choices", () => {
  test("null uses =null, not :z", () => {
    const out = encode({ x: null });
    expect(out).toBe("x=null");
  });

  test("empty array uses =[], not :l", () => {
    const out = encode({ x: [] });
    expect(out).toBe("x=[]");
  });

  test("empty object uses ={}, not :o", () => {
    const out = encode({ x: {} });
    expect(out).toBe("x={}");
  });

  test("nested empty container also uses literal form", () => {
    const out = encode({ user: { tags: [] } });
    expect(out).toBe("user.tags=[]");
  });

  test("plain ASCII string goes bare", () => {
    expect(encode({ s: "hello" })).toBe("s=hello");
  });

  test("string with spaces goes bare (no wrap)", () => {
    expect(encode({ s: "hello world" })).toBe("s=hello world");
  });

  test("string with comma goes bare (ADR-0007)", () => {
    expect(encode({ s: "a,b,c" })).toBe("s=a,b,c");
  });

  test("string with colon goes bare (ADR-0007)", () => {
    expect(encode({ s: "key:value" })).toBe("s=key:value");
  });

  test("string with brackets goes bare (ADR-0007)", () => {
    expect(encode({ s: "[not an array]" })).toBe("s=[not an array]");
  });

  test("string with braces goes bare (ADR-0007)", () => {
    expect(encode({ s: "{not an object}" })).toBe("s={not an object}");
  });

  // Literal-lookalike strings use the type-tag form `key:s=value` — canonical
  // per spec §3.6 (shorter of tag vs wrap) since ADR-0018. Each must decode
  // back to the string, never the literal.
  test("string literally '[]' uses the :s= tag (collides with empty-array literal)", () => {
    expect(encode({ s: "[]" })).toBe("s:s=[]");
    expect(decode("s:s=[]")).toEqual({ ok: true, value: { s: "[]" }, repairs: [] });
  });

  test("string literally '{}' uses the :s= tag", () => {
    expect(encode({ s: "{}" })).toBe("s:s={}");
    expect(decode("s:s={}")).toEqual({ ok: true, value: { s: "{}" }, repairs: [] });
  });

  test("string literally 'null' uses the :s= tag", () => {
    expect(encode({ s: "null" })).toBe("s:s=null");
    expect(decode("s:s=null")).toEqual({ ok: true, value: { s: "null" }, repairs: [] });
  });

  test("string literally 'true' uses the :s= tag", () => {
    expect(encode({ s: "true" })).toBe("s:s=true");
    expect(decode("s:s=true")).toEqual({ ok: true, value: { s: "true" }, repairs: [] });
  });

  test("string that's a JSON number uses the :s= tag", () => {
    expect(encode({ id: "42" })).toBe("id:s=42");
    expect(decode("id:s=42")).toEqual({ ok: true, value: { id: "42" }, repairs: [] });
  });

  test("string with leading whitespace must wrap (tag form is trim-unsafe)", () => {
    expect(encode({ s: " padded" })).toBe("s=<<< padded>>>");
  });

  test("empty string uses the :s= tag", () => {
    expect(encode({ s: "" })).toBe("s:s=");
    expect(decode("s:s=")).toEqual({ ok: true, value: { s: "" }, repairs: [] });
  });

  test("multiline string with no `>>>` line uses bare-delim (no nonce) — ADR-0011", () => {
    const out = encode({ body: "line1\nline2" });
    expect(out).toBe("body=<<<\nline1\nline2\n>>>");
  });

  test("single-line string with embedded `>>>` uses the :s= tag (typed parser takes rest of line verbatim)", () => {
    const out = encode({ s: "abc>>>def" });
    expect(out).toBe("s:s=abc>>>def");
    expect(decode(out)).toEqual({ ok: true, value: { s: "abc>>>def" }, repairs: [] });
    // The wrapped form remains accepted as input: outermost-slice unwrap.
    expect(decode("s=<<<abc>>>def>>>")).toEqual({ ok: true, value: { s: "abc>>>def" }, repairs: [] });
  });

  test("multiline string where a line literally equals `>>>` uses nonce form", () => {
    const out = encode({ body: "line1\n>>>\nline3" });
    expect(out).toMatch(/^body=<<<[0-9a-f]+\nline1\n>>>\nline3\n>>>[0-9a-f]+$/);
  });
});

describe("encoder table mode", () => {
  test("homogeneous array of many objects emits table header + rows", () => {
    // Crossover with the array-literal form (ADR-0013) is around 6 rows for
    // 2 short cols; we test well past it so the assertion stays stable.
    const out = encode({
      items: [
        { id: 1, name: "foo" },
        { id: 2, name: "bar" },
        { id: 3, name: "baz" },
        { id: 4, name: "qux" },
        { id: 5, name: "quux" },
        { id: 6, name: "corge" },
        { id: 7, name: "grault" },
      ],
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("items::id,name");
    expect(lines[1]).toBe("items[0]=1,foo");
    expect(lines[2]).toBe("items[1]=2,bar");
  });

  test("array of 1 object picks inline-object form over path expansion — ADR-0012", () => {
    // Single-row arrays still pick a single-leaf inline form when shorter than
    // path expansion; table mode is unavailable below N=2.
    const out = encode({ items: [{ id: 1, name: "foo" }] });
    expect(out).toBe("items[0]={id=1,name=foo}");
    expect(out).not.toContain("items::");
  });

  test("heterogeneous array uses the array-literal form when shortest — ADR-0013", () => {
    // Three rows × mixed fields. Cost-aware selector picks the array-literal
    // form: opener + 3 row lines + closer = 5 lines, but no per-row prefix.
    const out = encode({
      mixed: [
        { kind: "user", name: "alice" },
        { kind: "group", members: 5 },
        { kind: "user", name: "bob", role: "admin" },
      ],
    });
    expect(out).not.toContain("mixed::");
    expect(out.startsWith("mixed=[\n")).toBe(true);
    expect(out.endsWith("\n]")).toBe(true);
    expect(out).toContain("{kind=user,name=alice}");
  });

  test("tiny heterogeneous array picks the cheapest mode (path or literal) — ADR-0012", () => {
    // 2 rows × 1 short field each. Path and array-literal are roughly tied;
    // the selector locks in whichever is shorter by byte length. The test
    // accepts either as long as it round-trips and isn't inline-object.
    const original: JSONObject = { mixed: [{ a: 1 }, { b: 2 }] };
    const out = encode(original);
    expect(out).not.toContain("={a=1}"); // inline-object per row would be more verbose here
    expect(roundTrip(original)).toEqual(original);
  });

  test("array containing multiline value falls back to path mode", () => {
    const out = encode({
      logs: [
        { msg: "line one", id: 1 },
        { msg: "first\nsecond", id: 2 },
      ],
    });
    expect(out).not.toContain("logs::");
  });

  test("table cell with comma wraps with <<<>>>", () => {
    // Longer column names ensure table mode beats the array-literal form
    // because the keys amortize via the table header instead of being repeated
    // on every row. Cols emit alphabetically: count, description.
    const out = encode({
      items: [
        { description: "no commas", count: 1 },
        { description: "has, comma", count: 2 },
        { description: "another row", count: 3 },
        { description: "last row", count: 4 },
      ],
    });
    expect(out).toContain("items::count,description");
    expect(out).toContain("items[1]=2,<<<has, comma>>>");
  });

  test("table cell with literal '[]' wraps", () => {
    const out = encode({
      items: [
        { description: "[]", count: 1 },
        { description: "plain", count: 2 },
        { description: "third", count: 3 },
        { description: "fourth", count: 4 },
      ],
    });
    expect(out).toContain("items::count,description");
    expect(out).toContain("items[0]=1,<<<[]>>>");
  });
});

describe("decoder behavior", () => {
  test("rejects sparse arrays", () => {
    // Construct an obviously sparse RAIF manually
    const raw = ["arr[0]=a", "arr[2]=c"].join("\n");
    const r = decode(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("sparse");
  });

  test("rejects path collision", () => {
    const raw = ["x=1", "x.y=2"].join("\n");
    const r = decode(raw);
    expect(r.ok).toBe(false);
  });

  test("strips markdown fence and decodes", () => {
    const raw = "```\nx=1\ny=2\n```";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ x: 1, y: 2 });
      expect(r.repairs.some((rp) => rp.kind === "markdown_stripped")).toBe(true);
    }
  });

  test("typed leaf forces string interpretation", () => {
    const raw = "id:s=42";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe("42");
  });

  test("table-mode round-trips with mixed cell types", () => {
    const original: JSONObject = {
      items: [
        { id: 1, name: "foo", paid: true, note: null },
        { id: 2, name: "bar", paid: false, note: null },
      ],
    };
    expect(roundTrip(original)).toEqual(original);
  });
});

describe("inline-object form (ADR-0010)", () => {
  test("heterogeneous array round-trips through inline-object rows", () => {
    const original: JSONObject = {
      mixed: [
        { kind: "user", name: "alice" },
        { kind: "group", members: 5 },
        { kind: "user", name: "bob", role: "admin" },
      ],
    };
    expect(roundTrip(original)).toEqual(original);
  });

  test("inline-object cell with `,` wraps with <<<>>>", () => {
    // Heterogeneous key sets force inline-object mode (table mode is ineligible).
    const original: JSONObject = {
      mixed: [
        { note: "has, comma", id: 1 },
        { note: "plain", extra: true },
        { only: "another, comma" },
      ],
    };
    const out = encode(original);
    expect(out).toContain("note=<<<has, comma>>>");
    expect(roundTrip(original)).toEqual(original);
  });

  test("inline-object cell containing `}` wraps", () => {
    const original: JSONObject = {
      mixed: [
        { s: "weird }", id: 1 },
        { s: "plain", extra: true },
        { only: "{ also weird" },
      ],
    };
    const out = encode(original);
    expect(out).toContain("s=<<<weird }>>>");
    expect(roundTrip(original)).toEqual(original);
  });

  test("inline-object cell containing `=` round-trips (parser locks key first)", () => {
    const original: JSONObject = {
      mixed: [
        { k: "a=b", more: 1 },
        { k: "c=d", extra: true },
        { only: "no equals" },
      ],
    };
    expect(roundTrip(original)).toEqual(original);
  });

  test("pathological key inside inline-object round-trips with key wrap", () => {
    // Rows have different key sets → table mode is ineligible, so the inline
    // path is what's exercised here.
    const original: JSONObject = {
      mixed: [
        { "user.email": "x@y.z", role: "admin" },
        { "user.email": "a@b.c", group: "ops" },
        { "items[0]": "literal", id: 7 },
      ],
    };
    expect(roundTrip(original)).toEqual(original);
  });

  test("nested object collapses to inline-object form when shorter", () => {
    const out = encode({
      data: { user: { id: 7, handle: "egor", verified: true } },
    });
    expect(out).toContain("data.user={handle=egor,id=7,verified=true}");
  });

  test("nested object with sub-object stays in path mode (inline is flat-only)", () => {
    const out = encode({
      data: { user: { profile: { name: "egor" } } },
    });
    expect(out).toBe("data.user.profile.name=egor");
  });

  test("string that looks like an inline-object literal uses the :s= tag", () => {
    const out = encode({ s: "{a=1,b=2}" });
    expect(out).toBe("s:s={a=1,b=2}");
    expect(roundTrip({ s: "{a=1,b=2}" })).toEqual({ s: "{a=1,b=2}" });
  });

  test("string with braces but no `=` stays bare (not inline-object)", () => {
    expect(encode({ s: "{not an object}" })).toBe("s={not an object}");
  });
});

describe("array literal form (ADR-0013)", () => {
  test("heterogeneous array round-trips via array literal", () => {
    const original: JSONObject = {
      mixed: [
        { kind: "user", name: "alice" },
        { kind: "group", members: 5 },
        { kind: "user", name: "bob", role: "admin" },
      ],
    };
    const out = encode(original);
    expect(out.startsWith("mixed=[\n")).toBe(true);
    expect(out.endsWith("\n]")).toBe(true);
    expect(roundTrip(original)).toEqual(original);
  });

  test("primitive-array literal round-trips", () => {
    // Long primitive arrays benefit from prefix-sharing.
    const original: JSONObject = {
      ids: [101, 102, 103, 104, 105, 106, 107, 108],
    };
    expect(roundTrip(original)).toEqual(original);
  });

  test("encoder wraps single-char `[` string to avoid array-opener collision", () => {
    expect(encode({ s: "[" })).toBe("s=<<<[>>>");
    expect(roundTrip({ s: "[" })).toEqual({ s: "[" });
  });

  test("encoder wraps `]` strings inside array literal to avoid early close", () => {
    // Build inputs where the literal form is picked, then ensure a `]` value
    // round-trips by being wrapped.
    const original: JSONObject = { rows: ["plain", "]", "also plain", "more", "data"] };
    const out = encode(original);
    expect(out).toContain("<<<]>>>");
    expect(roundTrip(original)).toEqual(original);
  });

  test("unterminated array literal at EOF is closed and repaired (truncation recovery, ADR-0018)", () => {
    const raw = "mixed=[\n{a=1}\n{b=2}";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ mixed: [{ a: 1 }, { b: 2 }] });
      expect(r.repairs.some((rp) => rp.kind === "unterminated_array_closed_at_eof")).toBe(true);
    }
  });

  test("decoder ignores blank lines inside an array literal", () => {
    const raw = "ids=[\n1\n\n2\n\n3\n]";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ ids: [1, 2, 3] });
  });
});

describe("optional-nonce multiline (ADR-0011)", () => {
  test("plain multiline string skips the nonce", () => {
    expect(encode({ body: "a\nb\nc" })).toBe("body=<<<\na\nb\nc\n>>>");
  });

  test("multiline body round-trips through bare form", () => {
    const orig = { body: "line one\n\nline two\nline three" };
    expect(roundTrip(orig)).toEqual(orig);
  });

  test("multiline with a `>>>` line falls back to nonce form", () => {
    const out = encode({ body: "a\n>>>\nb" });
    expect(out).toMatch(/^body=<<<[0-9a-f]+\n/);
  });
});

describe("repair pass (spec §6)", () => {
  test("strips <raif>…</raif> mode markers", () => {
    const raw = "<raif>\nx=1\ny=2\n</raif>";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ x: 1, y: 2 });
      expect(r.repairs.some((rp) => rp.kind === "mode_markers_stripped")).toBe(true);
    }
  });

  test("strips <|raif_start|>…<|raif_end|> special-token markers", () => {
    const raw = "<|raif_start|>\nx=1\n<|raif_end|>";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ x: 1 });
  });

  test("coerces stray `:` separator to `=` when unambiguous", () => {
    const raw = "subject:hello\nto:client@example.com";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ subject: "hello", to: "client@example.com" });
      expect(r.repairs.some((rp) => rp.kind === "separator_coerced")).toBe(true);
    }
  });

  test("typed leaf (`:s=`, `:n=`, …) is not mis-coerced by repair", () => {
    const raw = "id:s=42";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ id: "42" });
      expect(r.repairs.every((rp) => rp.kind !== "separator_coerced")).toBe(true);
    }
  });

  test("recovers a mismatched-nonce multiline closer", () => {
    // Opener nonce `7f2a`, closer nonce `7f2b` (typo). Only one `>>>` closer
    // candidate in the stream, so repair accepts it.
    const raw = "body=<<<7f2a\nhello\n>>>7f2b";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ body: "hello" });
      expect(r.repairs.some((rp) => rp.kind === "mismatched_nonce_recovered")).toBe(true);
    }
  });

  test("refuses mismatched-nonce repair when multiple closers exist", () => {
    // Two `>>>` candidates → ambiguous → fail rather than guess.
    const raw = "body=<<<7f2a\nhello\n>>>7f2b\nother=1\n>>>9999";
    const r = decode(raw);
    expect(r.ok).toBe(false);
  });
});

describe("repair: multi-line JSON braces → path mode (TIER 1A)", () => {
  test("flattens simple 2-level brace block to path mode", () => {
    const raw = "a={\nb=1\n}";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ a: { b: 1 } });
      expect(r.repairs.some((rp) => rp.kind === "multiline_braces_flattened")).toBe(true);
    }
  });

  test("flattens deeply nested indented brace block", () => {
    // Same shape gemma3:4b emitted for deep_nesting.
    const raw = "a={\n  b={\n    c={\n      d={\n        e=deep\n      }\n    }\n  }\n}";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: { b: { c: { d: { e: "deep" } } } } });
  });

  test("leaves unbalanced braces alone so error is clear", () => {
    const raw = "a={\nb=1";
    const r = decode(raw);
    // Unbalanced isn't repaired — should not silently flatten/lose data.
    expect(r.repairs.some((rp) => rp.kind === "multiline_braces_flattened")).toBe(false);
  });

  test("passes through array literal inside brace block", () => {
    const raw = "data={\nposts=[\n{id=1}\n{id=2}\n]\n}";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ data: { posts: [{ id: 1 }, { id: 2 }] } });
  });

  test("single-line inline-object inside brace body round-trips", () => {
    const raw = "data={\nuser={id=7,handle=egor}\nflag=true\n}";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ data: { user: { id: 7, handle: "egor" }, flag: true } });
  });

  test("plain path-mode input does NOT trigger flattening", () => {
    const r = decode("a=1\nb=2");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repairs.some((rp) => rp.kind === "multiline_braces_flattened")).toBe(false);
  });
});

describe("repair: off-by-one multiline delimiter (TIER 1B)", () => {
  test("opener `<<` and closer `>>>` (model off-by-one on opener)", () => {
    const raw = "body=<<\nHi\nThere\n>>>";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ body: "Hi\nThere" });
      expect(r.repairs.some((rp) => rp.kind === "delimiter_count_repaired")).toBe(true);
    }
  });

  test("opener `<<<` and closer `>>` (model off-by-one on closer)", () => {
    const raw = "body=<<<\nHi\nThere\n>>";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ body: "Hi\nThere" });
      expect(r.repairs.some((rp) => rp.kind === "delimiter_count_repaired")).toBe(true);
    }
  });

  test("bare-string `s=<<` followed by real leaves is NOT hijacked", () => {
    // `s=<<` is a legal bare string with value `<<`. The relaxed opener
    // requires non-leaf-shaped content between the suspected opener and
    // closer; here every following line is leaf-shaped, so the relaxed
    // repair refuses to trigger.
    const raw = "s=<<\nb=1\nc=2";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ s: "<<", b: 1, c: 2 });
      expect(r.repairs.every((rp) => rp.kind !== "delimiter_count_repaired")).toBe(true);
    }
  });

  test("strict `<<<…>>>` (no off-by-one) does not record a repair", () => {
    const raw = "body=<<<\nHi\n>>>";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repairs.every((rp) => rp.kind !== "delimiter_count_repaired")).toBe(true);
  });
});

describe("TIER 2-A leading-zero number → string (ADR-0015)", () => {
  test("`02134` decodes as string (NUMBER_RE rejects leading zero)", () => {
    const r = decode("zipcode=02134");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ zipcode: "02134" });
  });

  test("plain `0` still decodes as number", () => {
    const r = decode("count=0");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ count: 0 });
  });

  test("`0.5` still decodes as number", () => {
    const r = decode("ratio=0.5");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ ratio: 0.5 });
  });
});

describe("TIER 2-B repeated-key auto-indexing (ADR-0015)", () => {
  test("repeated inline-object leaves become array elements", () => {
    const raw = "mixed={kind=user,name=alice}\nmixed={kind=group,members=5}\nmixed={kind=user,name=bob,role=admin}";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        mixed: [
          { kind: "user", name: "alice" },
          { kind: "group", members: 5 },
          { kind: "user", name: "bob", role: "admin" },
        ],
      });
      expect(r.repairs.some((rp) => rp.kind === "repeated_keys_indexed")).toBe(true);
    }
  });

  test("repeated bare leaves become array elements", () => {
    const raw = "tag=ai\ntag=infra\ntag=ops";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ tag: ["ai", "infra", "ops"] });
  });

  test("repeated nested-path keys become indexed", () => {
    const raw = "data.tag=a\ndata.tag=b";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ data: { tag: ["a", "b"] } });
  });

  test("refuses when a conflicting indexed form already exists", () => {
    // `mixed=...` and `mixed[3]=...` together — refuse to auto-index because
    // we'd collide with the explicit `[3]` slot.
    const raw = "mixed={kind=user}\nmixed={kind=group}\nmixed[3]={kind=admin}";
    const r = decode(raw);
    expect(r.ok).toBe(false);
  });

  test("refuses when a table header claims the same prefix", () => {
    const raw = "mixed::kind\nmixed[0]=user\nmixed={kind=group}";
    const r = decode(raw);
    // Repeated `mixed=` would collide with the table-form `mixed` array.
    // We refuse to auto-index; either parse fails or surfaces the collision.
    if (r.ok) {
      expect(r.repairs.every((rp) => rp.kind !== "repeated_keys_indexed")).toBe(true);
    }
  });

  test("single occurrence is not indexed", () => {
    const r = decode("mixed={kind=user}");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ mixed: { kind: "user" } });
      expect(r.repairs.every((rp) => rp.kind !== "repeated_keys_indexed")).toBe(true);
    }
  });
});

describe("TIER 2-C nested inline-object flattening (ADR-0015)", () => {
  test("two-level nested inline-object parses correctly", () => {
    const r = decode("data={user={id=7,handle=egor},meta={has_more=false}}");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        data: {
          user: { id: 7, handle: "egor" },
          meta: { has_more: false },
        },
      });
      expect(r.repairs.some((rp) => rp.kind === "nested_inline_flattened")).toBe(true);
    }
  });

  test("three-level nesting parses correctly", () => {
    const r = decode("a={b={c={d=deep}}}");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: { b: { c: { d: "deep" } } } });
  });

  test("non-nested inline-object does not record the repair", () => {
    const r = decode("data={id=7,handle=egor}");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ data: { id: 7, handle: "egor" } });
      expect(r.repairs.every((rp) => rp.kind !== "nested_inline_flattened")).toBe(true);
    }
  });
});

describe("table null cells decode as JSON null (ADR-0018, supersedes TIER 2-D 'key absent')", () => {
  test("null cells are the JSON null value, exactly like a bare null literal", () => {
    const raw = "mixed::kind,members,name,role\nmixed[0]=user,null,alice,null\nmixed[1]=group,5,null,null";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        mixed: [
          { kind: "user", members: null, name: "alice", role: null },
          { kind: "group", members: 5, name: null, role: null },
        ],
      });
    }
  });

  test("v0.3 table semantics preserved: null cell round-trips through table mode", () => {
    const original: JSONObject = {
      items: [
        { id: 1, name: "foo", note: null },
        { id: 2, name: "bar", note: null },
      ],
    };
    expect(roundTrip(original)).toEqual(original);
  });
});

describe("v0.4 API surface (ADR-0014)", () => {
  test("fix(canonical) is idempotent and equals the input", () => {
    const canonical = encode({ b: 2, a: 1 });
    const r = fix(canonical);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonical).toBe(canonical);
      expect(r.repairs.length).toBe(0);
    }
  });

  test("fix(non-canonical) produces canonical RAIF + repairs", () => {
    const r = fix("```\nb=2\na=1\n```");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonical).toBe("a=1\nb=2");
      expect(r.repairs.length).toBeGreaterThan(0);
    }
  });

  test("validate(canonical) returns ok", () => {
    const canonical = encode({ a: 1, b: 2 });
    expect(validate(canonical)).toEqual({ ok: true });
  });

  test("validate(non-canonical) returns ok=false", () => {
    expect(validate("```\nb=2\na=1\n```").ok).toBe(false);
  });

  test("validate(unparseable) returns ok=false with error", () => {
    const v = validate("@#$invalid");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.length).toBeGreaterThan(0);
  });

  test("decode(input) and fix(input) agree on the JSON projection", () => {
    const raw = "mixed=a\nmixed=b\nmixed=c";
    const d = decode(raw);
    const f = fix(raw);
    expect(d.ok).toBe(true);
    expect(f.ok).toBe(true);
    if (d.ok && f.ok) {
      const reDecoded = decode(f.canonical);
      expect(reDecoded.ok).toBe(true);
      if (reDecoded.ok) expect(reDecoded.value).toEqual(d.value);
    }
  });
});

describe("encoder rejects out-of-scope inputs", () => {
  test("rejects top-level array", () => {
    expect(() => encode([1, 2, 3] as unknown as JSONObject)).toThrow();
  });

  test("rejects top-level null", () => {
    expect(() => encode(null as unknown as JSONObject)).toThrow();
  });

  test("rejects NaN", () => {
    expect(() => encode({ x: NaN })).toThrow();
  });

  test("rejects Infinity", () => {
    expect(() => encode({ x: Infinity })).toThrow();
  });
});

// ─── ADR-0018 hardening regressions ───────────────────────────────────

describe("repair pre-pass never mutates multiline value bytes (F1)", () => {
  test("multiline string whose content looks like a brace block round-trips untouched", () => {
    const original: JSONObject = { s: "a={\nb=1\n}" };
    const r = decode(encode(original));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(original);
      expect(r.repairs).toEqual([]);
    }
  });

  test("brace-flatten still fires around a multiline block without touching its content", () => {
    const raw = "a={\nb=1\n}\nbody=<<<\nx={\ny=2\n}\n>>>";
    const r = decode(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ a: { b: 1 }, body: "x={\ny=2\n}" });
      expect(r.repairs.some((rp) => rp.kind === "multiline_braces_flattened")).toBe(true);
    }
  });
});

describe("opener-tail values cannot hijack neighboring leaves (F2)", () => {
  test("value ending in `=<<<` round-trips and does not swallow a multiline sibling", () => {
    const original: JSONObject = { s: "foo=<<<", t: "x\ny" };
    expect(roundTrip(original)).toEqual(original);
  });

  test("value `<<` round-trips next to a multiline sibling", () => {
    const original: JSONObject = { a: "<<", z: "x\ny" };
    expect(roundTrip(original)).toEqual(original);
  });

  test("value ending in `=[` round-trips (would otherwise open an array literal)", () => {
    const original: JSONObject = { s: "foo=[", next: "safe" };
    expect(roundTrip(original)).toEqual(original);
  });

  test("value `[` still round-trips", () => {
    expect(roundTrip({ s: "[" })).toEqual({ s: "[" });
  });
});

describe("cell wrap rules close the comma-splitter hazards (F3/F4)", () => {
  test("inline-object cell with unbalanced `{` keeps sibling keys", () => {
    const original: JSONObject = { mixed: [{ k: "a{b", m: 2 }, { q: 1 }] };
    expect(roundTrip(original)).toEqual(original);
  });

  test("table cell that looks like an inline object stays a string", () => {
    const original: JSONObject = {
      items: [
        { description: "{a=1}", count: 1 },
        { description: "plain", count: 2 },
        { description: "third row", count: 3 },
        { description: "fourth row", count: 4 },
      ],
    };
    expect(roundTrip(original)).toEqual(original);
  });

  test("cell containing a bare `<<<` mid-string keeps neighboring cells", () => {
    const original: JSONObject = { mixed: [{ x: "a<<<b", c: 2 }, { y: 1 }] };
    expect(roundTrip(original)).toEqual(original);
  });
});

describe("`\\r` bytes in values are data, structural CRLF is repaired (F6)", () => {
  test("lone `\\r` inside a single-line value round-trips byte-exactly", () => {
    const original: JSONObject = { s: "a\rb" };
    const r = decode(encode(original));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(original);
      expect(r.repairs).toEqual([]);
    }
  });

  test("`\\r\\n` inside a multiline value round-trips byte-exactly", () => {
    const original: JSONObject = { s: "a\r\nb" };
    const r = decode(encode(original));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(original);
      expect(r.repairs).toEqual([]);
    }
  });

  test("trailing `\\r` on a value round-trips via the wrap form", () => {
    expect(roundTrip({ s: "x\r" })).toEqual({ s: "x\r" });
  });

  test("document-wide CRLF input is normalized with a repair", () => {
    const r = decode("a=1\r\nb=2\r\n");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ a: 1, b: 2 });
      expect(r.repairs.some((rp) => rp.kind === "line_endings_normalized")).toBe(true);
    }
  });

  test("a stray CRLF leaf line in an otherwise-LF document is repaired", () => {
    const r = decode("a=1\r\nb=2");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ a: 1, b: 2 });
      expect(r.repairs.some((rp) => rp.kind === "line_endings_normalized")).toBe(true);
    }
  });
});

describe("canonical order is UTF-8 byte order (F9)", () => {
  test("astral-plane key sorts after U+FFFD (UTF-16 sort would invert)", () => {
    const out = encode({ "😀": 1, "�": 2 });
    const lines = out.split("\n");
    expect(lines[0]).toBe("�=2");
    expect(lines[1]).toBe("😀=1");
  });

  test("astral-plane inline-object key order matches", () => {
    const original: JSONObject = { o: { "😀": 1, "�": 2 } };
    const out = encode(original);
    expect(out).toBe("o={�=2,😀=1}");
    expect(roundTrip(original)).toEqual(original);
  });
});

describe("canonical form is deterministic; validate∘encode holds (F10)", () => {
  test("encode is byte-deterministic across calls, including nonce blocks", () => {
    const obj: JSONObject = { body: "a\n>>>\nb" };
    expect(encode(obj)).toBe(encode(obj));
  });

  test("validate(encode(x)) is ok for nonce-bearing documents", () => {
    const canonical = encode({ body: "a\n>>>\nb", x: 1 });
    expect(validate(canonical)).toEqual({ ok: true });
  });

  test("fix is byte-idempotent on nonce-bearing documents", () => {
    const canonical = encode({ body: "a\n>>>\nb" });
    const r = fix(canonical);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonical).toBe(canonical);
  });
});

describe("strict paths and numbers (F7)", () => {
  test("malformed array indices are rejected, not coerced", () => {
    for (const raw of ["a[01]=1", "a[1x]=1", "a[1e5]=1", "a[1]b=1", "a.=1"]) {
      const r = decode(raw);
      expect(r.ok).toBe(false);
    }
  });

  test("a JSON number that overflows a double surfaces a clear error", () => {
    const r = decode("x=1e999");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("out of double range");
  });
});

describe("truncation recovery vs ambiguity refusal (ADR-0018)", () => {
  test("unterminated multiline block at EOF is closed with a repair", () => {
    const r = decode("a=1\nbody=<<<\nline one\nline two");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ a: 1, body: "line one\nline two" });
      expect(r.repairs.some((rp) => rp.kind === "unterminated_block_closed_at_eof")).toBe(true);
    }
  });

  test("multiple plausible closers still refuse (no guessing)", () => {
    const r = decode("body=<<<aaaa\nx\n>>>bbbb\ny\n>>>cccccc");
    expect(r.ok).toBe(false);
  });
});

describe("lenient decode: per-leaf recovery (spec §3.1/§11, F8)", () => {
  test("garbage line between good leaves keeps the neighbors", () => {
    const r = decodeLenient("good=1\n@@@garbage\nalso=2");
    expect(r.value).toEqual({ good: 1, also: 2 });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.line).toBe(2);
  });

  test("a bad table row is skipped; the rest of the table survives", () => {
    const r = decodeLenient("items::id,name\nitems[0]=1,foo\nitems[1]=2\nitems[2]=3,baz");
    expect(r.errors.length).toBeGreaterThan(0);
    // Row 1 is lost, so the array is sparse there — pruned with an error.
    // Rows 0 and 2 were parsed; whether the array survives pruning is a
    // policy choice — what must hold: no throw, errors name the problem.
    expect(r.errors.some((e) => e.error.includes("column count mismatch"))).toBe(true);
  });

  test("path collision is reported, first leaf wins", () => {
    const r = decodeLenient("a=1\na.b=2");
    expect(r.value).toEqual({ a: 1 });
    expect(r.errors.length).toBe(1);
  });

  test("clean canonical input produces no errors and no repairs", () => {
    const r = decodeLenient(encode({ a: 1, s: "x" }));
    expect(r.errors).toEqual([]);
    expect(r.repairs).toEqual([]);
    expect(r.value).toEqual({ a: 1, s: "x" });
  });
});

describe("hostile keys cannot pollute prototypes", () => {
  test("`__proto__` path decodes to an own property, never the prototype", () => {
    const r = decode("__proto__.polluted=1");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.prototype.hasOwnProperty.call(r.value, "__proto__")).toBe(true);
      expect((r.value as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  test("`__proto__` round-trips as a plain key", () => {
    const original: JSONObject = {};
    Object.defineProperty(original, "__proto__", {
      value: 7, enumerable: true, writable: true, configurable: true,
    });
    const out = encode(original);
    expect(out).toBe("__proto__=7");
    const r = decode(out);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.prototype.hasOwnProperty.call(r.value, "__proto__")).toBe(true);
  });

  test("`__proto__` inside an inline object stays an own property", () => {
    const r = decode("o={__proto__=1,x=2}");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const o = (r.value as { o: JSONObject }).o;
      expect(Object.prototype.hasOwnProperty.call(o, "__proto__")).toBe(true);
      expect(o.x).toBe(2);
    }
  });
});

describe("seeded round-trip property (the fuzz net)", () => {
  // mulberry32 — deterministic; failures reproduce by seed.
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const STRINGS = [
    "", " ", "a", "hello world", "null", "true", "false", "42", "-0.5", "1e3",
    "0123", "[]", "{}", "[", "]", "{", "}", "a,b", "a{b", "a}b", "{a=1}",
    "{a=1,b=2}", "a=<<<", "x=[", "<", "<<", "<<<", "a>>>b", "<<<x>>>",
    "line1\nline2", "a\rb", "a\r\nb", "x\r", ">>>", "a\n>>>\nb", "<<<\n",
    ">>>4f2a", "café", "😀emoji", "�text", "a=b", "k:v", ":s=1", "12:30",
    "foo=", "=bar", " lead", "trail ", "tab\there", "a=<x", "v=<<",
    "<raif>", "</raif>", "<|raif_start|>", "a <raif> b",
  ];
  const KEYS = [
    "a", "b2", "key", "user.name", "items[0]", "with space", "café", "😀",
    ".lead", "trail.", "a,b", "a=b", "a:b", "0", "00", "{a}", "[0]", "a.b.c",
    "__proto__", "constructor", "a<b", "a>b",
  ];

  function pick<T>(r: () => number, arr: T[]): T {
    return arr[Math.floor(r() * arr.length)]!;
  }

  function genValue(r: () => number, depth: number): ReturnType<typeof genObject> | string | number | boolean | null | unknown[] {
    const roll = r();
    if (roll < 0.30) return pick(r, STRINGS);
    if (roll < 0.45) {
      const n = r();
      if (n < 0.25) return Math.floor(r() * 2000) - 1000;
      if (n < 0.5) return r() * 2e6 - 1e6;
      if (n < 0.75) return 0;
      return -1.5e-7;
    }
    if (roll < 0.55) return r() < 0.5;
    if (roll < 0.62) return null;
    if (depth <= 0) return pick(r, STRINGS);
    if (roll < 0.82) {
      const len = Math.floor(r() * 6);
      const out: unknown[] = [];
      for (let i = 0; i < len; i++) out.push(genValue(r, depth - 1));
      return out;
    }
    return genObject(r, depth - 1);
  }

  function genObject(r: () => number, depth: number): JSONObject {
    const n = Math.floor(r() * 5);
    const out: JSONObject = {};
    for (let i = 0; i < n; i++) {
      const k = pick(r, KEYS) + (r() < 0.3 ? String(Math.floor(r() * 10)) : "");
      Object.defineProperty(out, k, {
        value: genValue(r, depth), enumerable: true, writable: true, configurable: true,
      });
    }
    return out;
  }

  function deepEq(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (typeof a !== "object") return false;
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) =>
      deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }

  test("decode∘encode is identity; validate and fix agree; lenient is clean — 500 seeds", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed * 2654435761);
      const obj = genObject(r, 3);
      const raif = encode(obj);
      const ctx = () => `seed=${seed}\njson=${JSON.stringify(obj)}\nraif:\n${raif}`;

      const dec = decode(raif);
      if (!dec.ok) throw new Error(`decode failed: ${dec.error}\n${ctx()}`);
      if (!deepEq(dec.value, obj)) {
        throw new Error(`round-trip mismatch\ngot=${JSON.stringify(dec.value)}\n${ctx()}`);
      }
      if (dec.repairs.length > 0) {
        throw new Error(`repairs on canonical input: ${JSON.stringify(dec.repairs)}\n${ctx()}`);
      }

      const v = validate(raif);
      if (!v.ok) throw new Error(`validate(encode(x)) failed: ${JSON.stringify(v)}\n${ctx()}`);

      const f = fix(raif);
      if (!f.ok || f.canonical !== raif) {
        throw new Error(`fix not idempotent on canonical input\n${ctx()}`);
      }

      const len = decodeLenient(raif);
      if (len.errors.length > 0 || len.truncated || !deepEq(len.value, obj)) {
        throw new Error(`lenient decode diverged: ${JSON.stringify(len.errors)}\n${ctx()}`);
      }

      const gen = encode(obj, { profile: "generation", markers: true });
      const gdec = decode(gen);
      if (!gdec.ok || !deepEq(gdec.value, obj)) {
        throw new Error(`generation-profile round-trip failed\ngen:\n${gen}\n${ctx()}`);
      }
      if (gdec.repairs.some((rp) => rp.kind !== "mode_markers_stripped")) {
        throw new Error(`unexpected repairs on generation output: ${JSON.stringify(gdec.repairs)}\n${ctx()}`);
      }
    }
  });
});

// ─── ADR-0019: schema-typed decode mode ───────────────────────────────

describe("schema-typed decode: types come from the schema, not value shape", () => {
  test("bare `null`/number/boolean under `s` decode as strings", () => {
    const schema = "placeholder:s\npriority:s\nflag:s";
    const r = decode("flag=true\nplaceholder=null\npriority=2", schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ placeholder: "null", priority: "2", flag: "true" });
  });

  test("inline-object-lookalike under `s` stays a string", () => {
    const r = decode("s={a=1,b=2}", "s:s");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ s: "{a=1,b=2}" });
  });

  test("wrapped values under `s` still unwrap (wrap is transport, not type)", () => {
    const r = decode("s=<<<hello, world>>>", "s:s");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ s: "hello, world" });
  });

  test("`n` field must parse as a number — no coercion, clear error", () => {
    const ok = decode("count=42", "count:n");
    expect(ok).toEqual({ ok: true, value: { count: 42 }, repairs: [] });
    const bad = decode("count=high", "count:n");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("expected number");
  });

  test("`b` field accepts only true/false", () => {
    const bad = decode("on=yes", "on:b");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("expected boolean");
  });

  test("schema wins over a wrong wire tag", () => {
    const r = decode("id:n=42", "id:s");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ id: "42" });
  });

  test("bare `null` under optional `s?` is JSON null; tagged `:s=null` is the string", () => {
    const r = decode("note=null", "note:s?");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ note: null });
    const r2 = decode("note:s=null", "note:s?");
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toEqual({ note: "null" });
  });

  test("array element types apply in literal rows and path mode", () => {
    const schema = "tags[]:s";
    const lit = decode("tags=[\ntrue\n42\nnull\n]", schema);
    expect(lit.ok).toBe(true);
    if (lit.ok) expect(lit.value).toEqual({ tags: ["true", "42", "null"] });
    const path = decode("tags[0]=true\ntags[1]=07", schema);
    expect(path.ok).toBe(true);
    if (path.ok) expect(path.value).toEqual({ tags: ["true", "07"] });
  });

  test("table cells are typed by `items[].col` declarations", () => {
    const schema = "items[].id:n\nitems[].note:s";
    const raw = "items::id,note\nitems[0]=1,null\nitems[1]=2,true";
    const r = decode(raw, schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        items: [
          { id: 1, note: "null" },
          { id: 2, note: "true" },
        ],
      });
    }
  });

  test("inline-object cells are typed by nested declarations", () => {
    const r = decode("user={id=7,tag=42}", "user.id:n\nuser.tag:s");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ user: { id: 7, tag: "42" } });
  });

  test("`o` declares open structure: children decode by inference", () => {
    const r = decode("mixed=[\n{kind=user,n=5}\n{kind=group}\n]", "mixed[]:o");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ mixed: [{ kind: "user", n: 5 }, { kind: "group" }] });
  });

  test("multiline block under `t` decodes; under `n` errors", () => {
    const ok = decode("body=<<<\nline1\nline2\n>>>", "body:t");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toEqual({ body: "line1\nline2" });
    const bad = decode("count=<<<\nx\n>>>", "count:n");
    expect(bad.ok).toBe(false);
  });
});

describe("schema validation: required, unknown, structure", () => {
  test("missing required field is an error; optional may be absent", () => {
    const bad = decode("to=a@b.c", "to:s\nsubject:s");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("missing required field");
    const ok = decode("to=a@b.c", "to:s\nnote:s?");
    expect(ok.ok).toBe(true);
  });

  test("unknown field is an error", () => {
    const r = decode("to=a@b.c\nextra=1", "to:s");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown field");
  });

  test("scalar where the schema declares an object is an error", () => {
    const r = decode("user=5", "user.id:n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("expected object");
  });

  test("required check applies inside array elements", () => {
    const r = decode("items=[\n{id=1}\n]", "items[].id:n\nitems[].name:s");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("missing required field");
  });

  test("decodeLenient reports schema errors per leaf and keeps the rest", () => {
    const r = decodeLenient("to=a@b.c\ncount=high", "to:s\ncount:n");
    expect(r.value).toEqual({ to: "a@b.c" });
    expect(r.errors.some((e) => e.error.includes("expected number"))).toBe(true);
  });
});

describe("schema-as-parity: pathological key recovery (ADR-0016)", () => {
  test("unwrapped dotted key resolves to the declared flat field, with a repair", () => {
    const r = decode("user.email=x@y.z", "<<<user.email>>>:s");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ "user.email": "x@y.z" });
      expect(r.repairs.some((rp) => rp.kind === "pathological_key_resolved")).toBe(true);
    }
  });

  test("nested interpretation wins when the schema declares the nested shape", () => {
    const r = decode("user.email=x@y.z", "user.email:s");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ user: { email: "x@y.z" } });
  });
});

// ─── ADR-0019: generation profile ─────────────────────────────────────

describe("generation profile: deterministic modes, truncation-optimal order", () => {
  test("uniform object array always uses table mode (no cost comparison)", () => {
    // 2 short rows: canonical picks the cheaper array literal; generation
    // must still pick table — fixed precedence, learnable by a model.
    const obj: JSONObject = { items: [{ id: 1, name: "a" }, { id: 2, name: "b" }] };
    const gen = encode(obj, { profile: "generation" });
    expect(gen.startsWith("items::id,name\n")).toBe(true);
    expect(decode(gen)).toEqual({ ok: true, value: obj, repairs: [] });
  });

  test("nested flat object uses path mode, never the collapsed inline form", () => {
    const obj: JSONObject = { meta: { a: 1, b: 2 } };
    const gen = encode(obj, { profile: "generation" });
    expect(gen).toBe("meta.a=1\nmeta.b=2");
  });

  test("multiline blocks are emitted last, single-line leaves first", () => {
    const obj: JSONObject = { body: "line1\nline2", to: "a@b.c", subject: "hi" };
    const gen = encode(obj, { profile: "generation" });
    const lines = gen.split("\n");
    expect(lines[0]).toBe("subject=hi");
    expect(lines[1]).toBe("to=a@b.c");
    expect(lines[2]).toBe("body=<<<");
    expect(decode(gen)).toEqual({ ok: true, value: obj, repairs: [] });
  });

  test("generation output is decode-identical to canonical for every corpus-style shape", () => {
    const obj: JSONObject = {
      to: "client@example.com",
      body: "Hi,\nready.",
      priority: 2,
      tags: ["billing", "urgent"],
      metadata: { tracking_id: "abc-123", retry_count: 0 },
      scheduled_at: null,
      attachments: [],
      mixed: [{ kind: "user", name: "alice" }, { kind: "group", members: 5 }],
    };
    const r = decode(encode(obj, { profile: "generation" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(obj);
  });

  test("markers frame the document; decode strips them with a repair", () => {
    const obj: JSONObject = { a: 1 };
    const out = encode(obj, { profile: "generation", markers: true });
    expect(out).toBe("<raif>\na=1\n</raif>");
    const r = decode(out);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(obj);
      expect(r.repairs).toEqual([{ kind: "mode_markers_stripped" }]);
    }
  });

  test("empty object with markers round-trips", () => {
    const out = encode({}, { markers: true });
    expect(decode(out)).toEqual({
      ok: true,
      value: {},
      repairs: [{ kind: "mode_markers_stripped" }],
    });
  });
});

describe("truncation detection via markers (ADR-0019)", () => {
  test("missing close marker sets `truncated` in decodeLenient", () => {
    const full = encode({ a: 1, b: 2 }, { markers: true });
    const cut = full.slice(0, full.length - "\n</raif>".length);
    const r = decodeLenient(cut);
    expect(r.truncated).toBe(true);
    expect(r.value).toEqual({ a: 1, b: 2 });
  });

  test("complete marker-framed document is not flagged", () => {
    const r = decodeLenient(encode({ a: 1 }, { markers: true }));
    expect(r.truncated).toBe(false);
  });

  test("EOF-closed multiline block sets `truncated` even without markers", () => {
    const r = decodeLenient("a=1\nbody=<<<\ncut off here");
    expect(r.truncated).toBe(true);
  });

  test("marker-looking strings inside values survive (edge-only stripping)", () => {
    const obj: JSONObject = { s: "<raif>", t: "a </raif> b", body: "x\n<raif>\ny" };
    expect(roundTrip(obj)).toEqual(obj);
  });
});

describe("schema `o` with declared children: typed where declared, open elsewhere", () => {
  test("declared element fields are typed; undeclared ones are allowed", () => {
    const schema = "mixed[]:o\nmixed[].id:s\nmixed[].extra:n?";
    const r = decode("mixed=[\n{id=42,other=true}\n]", schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ mixed: [{ id: "42", other: true }] });
  });

  test("heterogeneous elements with optional fields pass the required check", () => {
    const schema = "mixed[]:o\nmixed[].kind:s\nmixed[].name:s?\nmixed[].members:n?";
    const r = decode("mixed=[\n{kind=user,name=alice}\n{kind=group,members=5}\n]", schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        mixed: [{ kind: "user", name: "alice" }, { kind: "group", members: 5 }],
      });
    }
  });

  test("array literal under an `o?` field decodes openly", () => {
    const r = decode("extra=[\n1\ntwo\n]", "extra:o?");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ extra: [1, "two"] });
  });
});
