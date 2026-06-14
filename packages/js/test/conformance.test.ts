// Language-agnostic conformance suite. Loads the shared ground-truth corpus in
// `conformance/*.json` (generated from this exact reference implementation) and
// asserts that the library reproduces every case. Any port must pass the same
// corpus, so this guards against accidental behavioural drift.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Import through the package entry point (not raif.ts directly) so this suite
// doubles as a guard on the published public surface: if `src/index.ts` ever
// stops re-exporting one of these, the corpus run fails here.
import {
  decode,
  decodeLenient,
  encode,
  fix,
  type JSONObject,
  parseSchema,
  validate,
} from "../src/index.ts";

const CONFORMANCE_DIR = join(import.meta.dir, "../../../conformance");

function load<T>(name: string): { cases: T[] } {
  const path = join(CONFORMANCE_DIR, `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as { cases: T[] };
}

function repairKinds(repairs: { kind: string }[]): string[] {
  return repairs.map((r) => r.kind).sort();
}

// ── encode ──────────────────────────────────────────────────────────────────
describe("conformance: encode", () => {
  type EncodeCase = {
    name: string;
    input: JSONObject;
    opts?: { profile?: "canonical" | "generation" };
    expected: string;
  };
  const { cases } = load<EncodeCase>("encode");

  test("corpus is non-empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(c.name, () => {
      expect(encode(c.input, c.opts)).toBe(c.expected);
    });
  }
});

// ── decode ──────────────────────────────────────────────────────────────────
describe("conformance: decode", () => {
  type DecodeCase = {
    name: string;
    input: string;
    schema: string | null;
    expected?: JSONObject;
    repairs?: string[];
    error?: boolean;
  };
  const { cases } = load<DecodeCase>("decode");

  test("corpus is non-empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(c.name, () => {
      const r = decode(c.input, c.schema ?? undefined);
      if (c.error) {
        expect(r.ok).toBe(false);
        return;
      }
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toEqual(c.expected as JSONObject);
        if (c.repairs) {
          expect(repairKinds(r.repairs)).toEqual(c.repairs);
        }
      }
    });
  }
});

// ── lenient ─────────────────────────────────────────────────────────────────
describe("conformance: decodeLenient", () => {
  type LenientCase = {
    name: string;
    input: string;
    schema: string | null;
    expected: JSONObject;
    truncated: boolean;
    errorCount: number;
    repairs?: string[];
  };
  const { cases } = load<LenientCase>("lenient");

  test("corpus is non-empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(c.name, () => {
      const r = decodeLenient(c.input, c.schema ?? undefined);
      expect(r.value).toEqual(c.expected);
      expect(r.truncated).toBe(c.truncated);
      expect(r.errors.length).toBe(c.errorCount);
      if (c.repairs) {
        expect(repairKinds(r.repairs)).toEqual(c.repairs);
      }
    });
  }
});

// ── fix ─────────────────────────────────────────────────────────────────────
describe("conformance: fix", () => {
  type FixCase = {
    name: string;
    input: string;
    schema?: string | null;
    expected?: string;
    repairs?: string[];
    error?: boolean;
  };
  const { cases } = load<FixCase>("fix");

  test("corpus is non-empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(c.name, () => {
      const r = fix(c.input, c.schema ?? undefined);
      if (c.error) {
        expect(r.ok).toBe(false);
        return;
      }
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.canonical).toBe(c.expected as string);
        if (c.repairs) {
          expect(repairKinds(r.repairs)).toEqual(c.repairs);
        }
      }
    });
  }
});

// ── validate ────────────────────────────────────────────────────────────────
describe("conformance: validate", () => {
  type ValidateCase = {
    name: string;
    input: string;
    schema: string | null;
    valid: boolean;
  };
  const { cases } = load<ValidateCase>("validate");

  test("corpus is non-empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(c.name, () => {
      const r = validate(c.input, c.schema ?? undefined);
      expect(r.ok).toBe(c.valid);
    });
  }
});

// ── parseSchema (public surface guard) ───────────────────────────────────────
// The corpus passes schemas as strings; this guards the published parseSchema
// export and that a parsed RaifSchema object is accepted by decode.
describe("conformance: parseSchema", () => {
  test("a parsed schema pins types in decode", () => {
    const schema = parseSchema("priority:s\ncount:n");
    const r = decode("count=2\npriority=2", schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ count: 2, priority: "2" });
  });

  test("string and parsed schema decode identically", () => {
    const decl = "tags[]:s";
    const input = "tags[0]=1\ntags[1]=2";
    const viaString = decode(input, decl);
    const viaParsed = decode(input, parseSchema(decl));
    expect(viaString).toEqual(viaParsed);
  });
});
