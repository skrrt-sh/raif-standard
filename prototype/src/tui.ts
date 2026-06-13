// Throwaway TUI: pick a corpus entry, see JSON / RAIF / decoded side by side.
// Run with: bun run tui

import { encode, decode } from "./raif.ts";
import { corpus } from "./corpus.ts";
import { encode as bpeEncode } from "gpt-tokenizer";

const B = "\x1b[1m";
const D = "\x1b[2m";
const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const RESET = "\x1b[0m";

let cursor = 0;

function render(): void {
  console.clear();
  const entry = corpus[cursor]!;
  const json = entry.json;
  const jsonStr = JSON.stringify(json, null, 2);
  const jsonCompact = JSON.stringify(json);

  let raif = "";
  let decoded: ReturnType<typeof decode> = { ok: false, error: "not run", repairs: [] };
  let encodeError: string | null = null;
  try {
    raif = encode(json);
    decoded = decode(raif);
  } catch (e) {
    encodeError = (e as Error).message;
  }

  const jTok = bpeEncode(jsonCompact).length;
  const rTok = raif ? bpeEncode(raif).length : 0;
  const delta = raif ? `${Math.round(((rTok - jTok) / jTok) * 100)}%` : "—";

  console.log(`${B}RAIF v0.2 prototype${RESET}  ${D}[${cursor + 1}/${corpus.length}]${RESET}`);
  console.log("");
  console.log(`${B}case:${RESET} ${entry.name}`);
  console.log(`${D}${entry.description}${RESET}`);
  console.log("");
  console.log(`${B}JSON (pretty):${RESET}`);
  console.log(jsonStr);
  console.log("");
  console.log(`${B}RAIF:${RESET}`);
  if (encodeError) {
    console.log(`  ${R}encode error: ${encodeError}${RESET}`);
  } else {
    console.log(raif);
  }
  console.log("");
  console.log(`${B}decode:${RESET}`);
  if (decoded.ok) {
    const eq = deepEqual(decoded.value, json);
    console.log(`  ${eq ? G + "round-trip ✓" : R + "round-trip ✗"}${RESET}`);
    if (!eq) {
      console.log(`  expected: ${JSON.stringify(json)}`);
      console.log(`  got:      ${JSON.stringify(decoded.value)}`);
    }
    if (decoded.repairs.length > 0) {
      console.log(`  ${Y}repairs: ${decoded.repairs.map((r) => r.kind).join(", ")}${RESET}`);
    }
  } else {
    console.log(`  ${R}decode error: ${decoded.error}${RESET}`);
  }
  console.log("");
  console.log(`${B}tokens:${RESET}  JSON-compact: ${jTok}   RAIF: ${rTok}   ${rTok < jTok ? G : R}Δ ${delta}${RESET}`);
  console.log("");
  console.log(`${D}[n] next  [p] prev  [q] quit${RESET}`);
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

async function main(): Promise<void> {
  render();
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    const key = String(chunk);
    if (key === "q" || key === "") {
      process.stdin.setRawMode?.(false);
      process.exit(0);
    }
    if (key === "n" || key === "[C") {
      cursor = (cursor + 1) % corpus.length;
      render();
    } else if (key === "p" || key === "[D") {
      cursor = (cursor - 1 + corpus.length) % corpus.length;
      render();
    }
  }
}

main();
