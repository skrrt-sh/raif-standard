import { decode as detok, encode as tok } from "gpt-tokenizer/encoding/cl100k_base";
import { jsonrepair } from "jsonrepair";
import { decodeLenient, encode } from "../src/index.ts";
import { corpus } from "./corpus.ts";

function leaves(v: unknown, p = ""): Map<string, unknown> {
  const m = new Map<string, unknown>();
  if (v !== null && typeof v === "object") {
    const entries = Array.isArray(v)
      ? v.map((x, i) => [`[${i}]`, x] as const)
      : Object.entries(v).map(([k, x]) => [`.${k}`, x] as const);
    if (entries.length === 0) {
      m.set(p, Array.isArray(v) ? "[]" : "{}");
      return m;
    }
    for (const [k, x] of entries) for (const [kk, vv] of leaves(x, p + k)) m.set(kk, vv);
    return m;
  }
  m.set(p, v);
  return m;
}
function recovered(orig: Map<string, unknown>, got: unknown): number {
  const g = leaves(got);
  let ok = 0;
  for (const [k, v] of orig) if (g.has(k) && Object.is(g.get(k), v)) ok++;
  return ok / orig.size;
}
function reorder(raif: string): string {
  const lines = raif.split("\n");
  const singles: string[] = [],
    blocks: string[][] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const ml = l.match(/^(.*?)=<<<([0-9a-fA-F]*)$/);
    if (ml) {
      const closer = `>>>${ml[2]}`;
      let j = i + 1;
      while (j < lines.length && lines[j] !== closer) j++;
      blocks.push(lines.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const al = l.match(/^(.+)=\[$/);
    if (al) {
      let j = i + 1;
      while (j < lines.length && lines[j] !== "]") j++;
      blocks.push(lines.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    singles.push(l);
    i++;
  }
  return [...singles, ...blocks.flat()].join("\n");
}
const cutAt = (s: string, k: number) => detok(tok(s).slice(0, k));

let rc = 0,
  ro = 0,
  jr = 0,
  n = 0;
for (const c of corpus) {
  const obj = c.json;
  const orig = leaves(obj);
  const raif = encode(obj);
  const rord = reorder(raif);
  const json = JSON.stringify(obj);
  const budget = tok(json).length; // same absolute token budgets for all formats
  for (let f = 1; f <= 9; f++) {
    const k = Math.floor((budget * f) / 10);
    rc += recovered(orig, decodeLenient(cutAt(raif, k)).value);
    ro += recovered(orig, decodeLenient(cutAt(rord, k)).value);
    try {
      jr += recovered(orig, JSON.parse(jsonrepair(cutAt(json, k))));
    } catch {}
    n++;
  }
}
console.log(`mean leaf recovery, EQUAL TOKEN budgets (10%..90% of JSON's length):`);
console.log(`  JSON + jsonrepair:            ${((jr / n) * 100).toFixed(1)}%`);
console.log(`  RAIF compact (today):         ${((rc / n) * 100).toFixed(1)}%`);
console.log(`  RAIF compact, scalars-first:  ${((ro / n) * 100).toFixed(1)}%`);
