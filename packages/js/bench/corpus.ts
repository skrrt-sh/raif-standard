// A small corpus of representative JSON objects for the benchmark.
// Each entry isolates one shape from the spec so a failure points at one rule.

import type { JSONObject } from "../src/raif.ts";

export interface CorpusEntry {
  name: string;
  description: string;
  json: JSONObject;
}

export const corpus: CorpusEntry[] = [
  {
    name: "short_tool_call",
    description: "3-field tool call, all short ASCII strings",
    json: {
      to: "client@example.com",
      subject: "Invoice ready",
      body: "Hello there",
    },
  },
  {
    name: "scalars_mixed",
    description: "All primitive types in one object",
    json: {
      str: "hello",
      num: 42,
      float: 3.14,
      neg: -17,
      bigish: 12345678901234,
      flag: true,
      off: false,
      nada: null,
    },
  },
  {
    name: "nested_object",
    description: "2-level nesting via path mode",
    json: {
      user: { id: 123, name: "Egor", email: "e@example.com" },
      tracking_id: "abc-123",
    },
  },
  {
    name: "array_of_objects",
    description: "Array of homogeneous objects",
    json: {
      items: [
        { id: 1, name: "foo", qty: 2 },
        { id: 2, name: "bar", qty: 5 },
        { id: 3, name: "baz", qty: 1 },
      ],
    },
  },
  {
    name: "text_with_specials",
    description: "Strings containing quotes, braces, commas, equals",
    json: {
      title: 'has "quotes" and {braces}',
      query: "a=1,b=2",
      slug: "name with spaces",
      emoji: "fire emoji 🔥 inline",
    },
  },
  {
    name: "multiline_body",
    description: "Multiline string requires nonce-bounded form",
    json: {
      to: "ops@example.com",
      subject: "Postmortem",
      body: 'Hi,\n\nThe outage started at 14:02 and recovered at 14:37.\n\nRoot cause: a stale "config_cache" entry.\n\nThanks,\nEgor',
    },
  },
  {
    name: "null_and_empties",
    description: "Sentinels for null, empty array, empty object",
    json: {
      scheduled_at: null,
      attachments: [],
      metadata: {},
      tags: ["billing", "urgent"],
    },
  },
  {
    name: "pathological_keys",
    description: "Keys containing path-significant characters",
    json: {
      "user.email": "literal-dot-in-key@example.com",
      "items[0]": "literal-bracket-key",
      normal_key: "ordinary value",
    },
  },
  {
    name: "numeric_string_ambiguity",
    description: "String values that look like numbers/literals",
    json: {
      zipcode: "02134",
      version_tag: "true",
      placeholder: "null",
      actual_num: 42,
      actual_bool: true,
      actual_null: null,
    },
  },
  {
    name: "deep_nesting",
    description: "Five-level nesting via path",
    json: {
      a: { b: { c: { d: { e: "deep" } } } },
    },
  },
  {
    name: "json_heavy",
    description: "Realistic API response shape",
    json: {
      status: "ok",
      code: 200,
      request_id: "req_abc123",
      data: {
        user: { id: 7, handle: "egor", verified: true },
        posts: [
          { id: 1, title: "First", likes: 12 },
          { id: 2, title: "Second", likes: 5 },
        ],
        meta: { next_cursor: null, has_more: false },
      },
    },
  },
  {
    name: "large_table",
    description: "10-row homogeneous table — exercises table mode hard",
    json: {
      orders: [
        { id: 1, customer: "Acme", total: 199.99, paid: true },
        { id: 2, customer: "Beta", total: 49.0, paid: false },
        { id: 3, customer: "Gamma", total: 1500.0, paid: true },
        { id: 4, customer: "Delta", total: 12.5, paid: true },
        { id: 5, customer: "Epsilon", total: 0, paid: false },
        { id: 6, customer: "Zeta", total: 999.99, paid: true },
        { id: 7, customer: "Eta", total: 75.25, paid: false },
        { id: 8, customer: "Theta", total: 3.0, paid: true },
        { id: 9, customer: "Iota", total: 250, paid: true },
        { id: 10, customer: "Kappa", total: 42.42, paid: false },
      ],
    },
  },
  {
    name: "heterogeneous_array",
    description: "Array of objects with different key sets — must fall back to path mode",
    json: {
      mixed: [
        { kind: "user", name: "alice" },
        { kind: "group", members: 5 },
        { kind: "user", name: "bob", role: "admin" },
      ],
    },
  },
  {
    name: "literal_strings",
    description: "String values that literally equal '[]', '{}', or contain commas/braces",
    json: {
      empty_brackets: "[]",
      empty_braces: "{}",
      csv_chunk: "a,b,c",
      braced: "{not an object}",
      bracketed: "[not an array]",
      keyish: "key:value",
    },
  },
  {
    name: "wide_heterogeneous_array",
    description: "5-element array, mixed key sets — exercises inline-object mode hard",
    json: {
      events: [
        { type: "click", target: "button#submit", at: 1715600000 },
        { type: "view", page: "/pricing", at: 1715600045 },
        { type: "click", target: "a.cta", at: 1715600101 },
        { type: "submit", form: "checkout", value: 4999, at: 1715600145 },
        { type: "view", page: "/thanks", referrer: "/checkout", at: 1715600200 },
      ],
    },
  },
  {
    name: "flat_inline_object",
    description: "Wide-but-flat nested object — exercises inline-object form for non-array nesting",
    json: {
      response: {
        user_id: 7,
        handle: "egor",
        verified: true,
        plan: "pro",
        seats: 12,
        renewed_at: "2026-04-01",
      },
    },
  },
  {
    name: "deep_array_literal",
    description: "Array at a deep path — array-literal form (ADR-0013) shares the long prefix once",
    json: {
      data: {
        session: {
          actions: [
            { type: "click", target: "button#submit" },
            { type: "view", page: "/pricing" },
            { type: "click", target: "a.cta" },
            { type: "scroll", depth: 80 },
            { type: "view", page: "/thanks" },
          ],
        },
      },
    },
  },
  {
    name: "long_primitive_array",
    description: "Long array of primitives — array-literal shines vs `prefix[N]=value` per row",
    json: {
      timestamps: [
        1715600000, 1715600015, 1715600030, 1715600045, 1715600060, 1715600075, 1715600090,
        1715600105, 1715600120, 1715600135,
      ],
    },
  },
];
