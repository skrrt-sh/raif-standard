import { encode as toonEncode } from "@toon-format/toon";
import { encode as cl100k } from "gpt-tokenizer/encoding/cl100k_base";
import { encode as o200k } from "gpt-tokenizer/encoding/o200k_base";
import { stringify as yamlStringify } from "yaml";
import { encode } from "../src/raif.ts";
import { corpus } from "./corpus.ts";

const toks = { cl100k, o200k } as const;
for (const [tname, tok] of Object.entries(toks)) {
  const tot = { json: 0, raif: 0, toon: 0, yaml: 0 };
  const rows: string[] = [];
  for (const c of corpus) {
    const obj = c.json;
    const enc = {
      json: JSON.stringify(obj),
      raif: encode(obj),
      toon: toonEncode(obj),
      yaml: yamlStringify(obj).trimEnd(),
    };
    const n = Object.fromEntries(Object.entries(enc).map(([k, v]) => [k, tok(v).length])) as Record<
      string,
      number
    >;
    for (const k of Object.keys(tot)) tot[k as keyof typeof tot] += n[k]!;
    const d = (x: number) => `${((x / n.json! - 1) * 100).toFixed(0).padStart(4)}%`;
    rows.push(
      `${c.name.padEnd(26)} json=${String(n.json).padStart(4)}  raif=${d(n.raif!)}  toon=${d(n.toon!)}  yaml=${d(n.yaml!)}`,
    );
  }
  console.log(`\n=== ${tname} ===`);
  for (const r of rows) console.log(r);
  const d = (x: number) => `${((x / tot.json - 1) * 100).toFixed(1)}%`;
  console.log(
    `TOTAL json=${tot.json}  raif=${tot.raif} (${d(tot.raif)})  toon=${tot.toon} (${d(tot.toon)})  yaml=${tot.yaml} (${d(tot.yaml)})`,
  );
}
console.log(
  "\ndelimiter check o200k:",
  JSON.stringify(["<<<", ">>>", "::", "=["].map((s) => o200k(s).length)),
);
