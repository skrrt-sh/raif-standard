// Smoke test — sanity-check the encoder/decoder on every corpus entry.
// Fails fast (exit 1) on the first broken round-trip. Run with: bun run check

import { encode, decode } from "./raif.ts";
import { corpus } from "./corpus.ts";

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

let failures = 0;
for (const entry of corpus) {
  try {
    const raif = encode(entry.json);
    const result = decode(raif);
    if (!result.ok) {
      console.error(`✗ ${entry.name}: decode failed — ${result.error}`);
      console.error(`  encoded RAIF was:\n${raif}\n`);
      failures++;
      continue;
    }
    if (!deepEqual(result.value, entry.json)) {
      console.error(`✗ ${entry.name}: round-trip mismatch`);
      console.error(`  source : ${JSON.stringify(entry.json)}`);
      console.error(`  result : ${JSON.stringify(result.value)}`);
      console.error(`  raif   :\n${raif}\n`);
      failures++;
      continue;
    }
    console.log(`✓ ${entry.name}`);
  } catch (e) {
    console.error(`✗ ${entry.name}: encode threw — ${(e as Error).message}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} failures.`);
  process.exit(1);
}
console.log(`\nall ${corpus.length} cases round-trip cleanly.`);
