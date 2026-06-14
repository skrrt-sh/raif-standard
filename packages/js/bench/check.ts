// Smoke test — sanity-check the encoder/decoder on every corpus entry.
// Fails fast (exit 1) on the first broken round-trip. Run with: bun run check

import { encode, decode } from "../src/raif.ts";
import { corpus } from "./corpus.ts";
import { deepEqual } from "./json_equal.ts";

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
