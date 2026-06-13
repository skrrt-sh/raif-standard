// Batch benchmark: round-trip fidelity + token count comparison.
// Run with: bun run bench

import { encode, decode } from "./raif.ts";
import { corpus } from "./corpus.ts";
import { encode as bpeEncode } from "gpt-tokenizer";

interface Row {
  name: string;
  roundTripOk: boolean;
  idempotentOk: boolean;
  jsonTokens: number;
  jsonCompactTokens: number;
  raifTokens: number;
  saving: string;
  error?: string;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if ((a as unknown[]).length !== (b as unknown[]).length) return false;
    return (a as unknown[]).every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length) return false;
  if (!ka.every((k, i) => k === kb[i])) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function tokens(s: string): number {
  return bpeEncode(s).length;
}

function pct(a: number, b: number): string {
  const d = ((b - a) / b) * 100;
  const sign = d > 0 ? "-" : "+";
  return `${sign}${Math.abs(d).toFixed(0)}%`;
}

function run(): void {
  const rows: Row[] = [];

  for (const entry of corpus) {
    const json = entry.json;
    const jsonPretty = JSON.stringify(json, null, 2);
    const jsonCompact = JSON.stringify(json);

    try {
      const raif = encode(json);
      const decoded = decode(raif);
      if (!decoded.ok) {
        rows.push({
          name: entry.name,
          roundTripOk: false,
          idempotentOk: false,
          jsonTokens: tokens(jsonPretty),
          jsonCompactTokens: tokens(jsonCompact),
          raifTokens: tokens(raif),
          saving: "",
          error: `decode failed: ${decoded.error}`,
        });
        continue;
      }
      const roundTripOk = deepEqual(decoded.value, json);

      const raif2 = encode(decoded.value);
      // Idempotence excludes nonce-block content lines, since random nonces
      // differ run-to-run. Compare with nonces stripped.
      const idempotentOk = stripNonces(raif) === stripNonces(raif2);

      const jt = tokens(jsonCompact);
      const rt = tokens(raif);
      rows.push({
        name: entry.name,
        roundTripOk,
        idempotentOk,
        jsonTokens: tokens(jsonPretty),
        jsonCompactTokens: jt,
        raifTokens: rt,
        saving: pct(rt, jt),
      });
    } catch (e) {
      rows.push({
        name: entry.name,
        roundTripOk: false,
        idempotentOk: false,
        jsonTokens: tokens(jsonPretty),
        jsonCompactTokens: tokens(jsonCompact),
        raifTokens: 0,
        saving: "",
        error: `encode failed: ${(e as Error).message}`,
      });
    }
  }

  printTable(rows);
  printSummary(rows);
}

function stripNonces(raif: string): string {
  // Normalize nonce values so two runs of the encoder produce equal bytes
  // even though the random nonces differ. Matches <<<HEX and >>>HEX boundaries.
  return raif.replace(/<<<[0-9a-f]+$/gm, "<<<NONCE").replace(/^>>>[0-9a-f]+$/gm, ">>>NONCE");
}

function printTable(rows: Row[]): void {
  const headers = ["case", "rt", "idem", "JSON-min tok", "RAIF tok", "Δ vs JSON"];
  const widths = [22, 4, 5, 13, 9, 10];
  const sep = "─".repeat(widths.reduce((a, b) => a + b + 3, -3));
  console.log("");
  console.log(headers.map((h, i) => h.padEnd(widths[i]!)).join(" │ "));
  console.log(sep);
  for (const r of rows) {
    const rt = r.roundTripOk ? "✓" : "✗";
    const idem = r.idempotentOk ? "✓" : "✗";
    const cols = [
      r.name.padEnd(widths[0]!),
      rt.padEnd(widths[1]!),
      idem.padEnd(widths[2]!),
      String(r.jsonCompactTokens).padStart(widths[3]!),
      String(r.raifTokens).padStart(widths[4]!),
      r.saving.padStart(widths[5]!),
    ];
    console.log(cols.join(" │ "));
    if (r.error) {
      console.log(`  └─ \x1b[31m${r.error}\x1b[0m`);
    }
  }
  console.log("");
}

function printSummary(rows: Row[]): void {
  const total = rows.length;
  const rt = rows.filter((r) => r.roundTripOk).length;
  const idem = rows.filter((r) => r.idempotentOk).length;
  const totalJson = rows.reduce((s, r) => s + r.jsonCompactTokens, 0);
  const totalRaif = rows.reduce((s, r) => s + r.raifTokens, 0);
  console.log(`round-trip: ${rt}/${total}   idempotent: ${idem}/${total}`);
  console.log(`tokens  JSON-min: ${totalJson}   RAIF: ${totalRaif}   delta: ${pct(totalRaif, totalJson)}`);
  console.log("");
}

run();
