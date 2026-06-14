// Animated terminal demo for RAIF. A short slide deck that shows, against the
// real library, why a repairable format beats JSON for LLM output.
//
//   bun run demo            paced for screen recording
//   DEMO_FAST=1 bun run demo   no animation (for iterating)
//
// When DEMO_CUES=<path> is set, it also writes a timestamped cue sheet of sound
// events (transitions, keystrokes, errors, ticks) so a soundtrack can be
// synthesized and muxed onto the recording. See src/gen_audio.ts.

import { encode, decode, decodeLenient } from "../src/raif.ts";
import { corpus } from "./corpus.ts";
import { encode as cl100k } from "gpt-tokenizer/encoding/cl100k_base";
import { writeFileSync } from "node:fs";

const FAST = !!process.env.DEMO_FAST;

// ── cue sheet (for the soundtrack) ───────────────────────────────────────────
const CUE_PATH = process.env.DEMO_CUES;
const CUES: Array<{ t: number; k: string }> = [];
let T0 = 0;
const now = () => performance.now();
const cue = (k: string) => {
  if (CUE_PATH) CUES.push({ t: now() - T0, k });
};

// ── tiny animation kit ───────────────────────────────────────────────────────
const out = (s: string) => process.stdout.write(s);
const nl = (n = 1) => out("\n".repeat(n));
const clear = () => out("\x1b[2J\x1b[3J\x1b[H");
const sleep = (ms: number) => (FAST ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
async function type(text: string, ms = 20) {
  if (FAST) return out(text);
  for (const ch of text) {
    out(ch);
    await sleep(ms);
  }
}
// like type(), but emits a cue per character (for keystroke sounds)
async function typeKeys(text: string, ms = 20, k = "key") {
  if (FAST) return out(text);
  for (const ch of text) {
    out(ch);
    if (ch !== " ") cue(k);
    await sleep(ms);
  }
}
async function typeln(text: string, ms = 20) {
  await type(text, ms);
  nl();
}
const padR = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length));
const padL = (s: string, w: number) => (s.length >= w ? s : " ".repeat(w - s.length) + s);

// truecolor palette (matches the neon banner)
const paint = (r: number, g: number, b: number) => (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
const blue = paint(96, 165, 250);
const cyan = paint(34, 211, 238);
const green = paint(74, 222, 128);
const red = paint(248, 113, 113);
const amber = paint(251, 191, 36);
const purple = paint(167, 139, 250);
const gray = paint(120, 128, 140);
const white = paint(231, 233, 238);
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const chip = (n: string) => `\x1b[1m\x1b[38;2;12;18;32m\x1b[48;2;96;165;250m ${n} \x1b[0m`;
const PAD = "   ";

// the RAIF wordmark, colored as a vertical gradient
const WORDMARK = [
  "██████╗  █████╗ ██╗███████╗",
  "██╔══██╗██╔══██╗██║██╔════╝",
  "██████╔╝███████║██║█████╗  ",
  "██╔══██╗██╔══██║██║██╔══╝  ",
  "██║  ██║██║  ██║██║██║     ",
  "╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝     ",
];
const GRADIENT = [
  paint(96, 165, 250), paint(99, 152, 251), paint(120, 140, 250),
  paint(140, 130, 250), paint(160, 130, 250), paint(167, 139, 250),
];
async function wordmark() {
  for (let i = 0; i < WORDMARK.length; i++) {
    out(PAD + GRADIENT[i]!(WORDMARK[i]!));
    nl();
    cue("thunk");
    await sleep(70);
  }
}

async function slide(n: string, title: string, desc: string) {
  clear();
  cue("transition");
  nl(2);
  out(PAD + chip(n) + "  ");
  await typeKeys(bold(white(title)), 24);
  nl(2);
  await typeln(PAD + gray(desc), 12);
  nl();
  await sleep(500);
}

// the running example: a get_forecast tool call
const call = { city: "Oslo", units: "metric", days: 3, hourly: true, alerts: false };

// ── slides ───────────────────────────────────────────────────────────────────
async function intro() {
  clear();
  cue("transition");
  nl(2);
  await wordmark();
  nl();
  await typeKeys(PAD + gray("The format that reads what models actually write."), 16);
  nl(2);
  await sleep(1700);
}

async function slideJsonBreaks() {
  await slide("01", "LLMs don't write perfect JSON", "Your model wrapped a tool call in a code fence. Again.");
  const lines = ["```json", ...JSON.stringify(call, null, 2).split("\n"), "```"];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (ln.startsWith("```")) {
      const note = i === 0 ? gray("   the model added these backticks, JSON has no idea what they are") : "";
      out(PAD + "  " + bold(amber(ln)) + note + "\n");
    } else {
      out(PAD + "  " + gray(ln) + "\n");
    }
    await sleep(60);
  }
  nl();
  out(PAD + "  " + cyan("JSON.parse(output)"));
  await sleep(900);
  nl(2);
  try {
    JSON.parse(lines.join("\n"));
  } catch (e) {
    cue("error");
    out(PAD + "  " + red("✗ " + (e as Error).message) + gray("   ← that stray backtick") + "\n");
    nl();
    await type(PAD + gray("One character the model didn't mean to add, and the whole call is gone."), 14);
  }
  await sleep(2200);
}

async function slideRaifRepairs() {
  await slide("02", "RAIF repairs it in one call", "The same tool call in RAIF, fenced and fumbled. Run decode().");
  const brokenRaif = "```\n" + encode(call).replace(/^city=/m, "city:") + "\n```";

  const BW = 16; // before-column width
  out(PAD + "  " + gray(padR("before", BW)) + gray("after  ·  decode() repaired") + "\n");
  nl();
  await sleep(300);

  const rows: Array<{ b: string; bad?: boolean; k: "del" | "add" | "ctx"; t: string; note?: string }> = [
    { b: "```", bad: true, k: "del", t: "```", note: "code fence removed" },
    { b: "alerts=false", k: "ctx", t: "alerts=false" },
    { b: "city:Oslo", bad: true, k: "del", t: "city:Oslo" },
    { b: "", k: "add", t: "city=Oslo", note: "':' fixed to '='" },
    { b: "days=3", k: "ctx", t: "days=3" },
    { b: "hourly=true", k: "ctx", t: "hourly=true" },
    { b: "units=metric", k: "ctx", t: "units=metric" },
    { b: "```", bad: true, k: "del", t: "```", note: "code fence removed" },
  ];
  for (const r of rows) {
    const bcell = (r.bad ? amber : gray)(padR(r.b, BW));
    const sign = r.k === "del" ? "- " : r.k === "add" ? "+ " : "  ";
    const acolor = r.k === "del" ? red : r.k === "add" ? green : gray;
    let acell = acolor(sign + padR(r.t, 14));
    if (r.note) acell += gray("  " + r.note);
    out(PAD + "  " + bcell + acell + "\n");
    cue(r.k === "del" ? "diffdel" : r.k === "add" ? "diffadd" : "diffctx");
    await sleep(240);
  }

  const res = decode(brokenRaif);
  if (!res.ok) return;
  nl();
  cue("success");
  out(PAD + "  " + green("✓ ") + gray("repairs: ") + cyan(res.repairs.map((r) => r.kind).join(", ")) + "\n");
  out(PAD + "  " + green("✓ ") + gray("value:   ") + white(JSON.stringify(res.value)) + "\n");
  nl();
  await type(PAD + bold(amber("Syntax repaired. Your values, never touched.")), 16);
  await sleep(2600);
}

async function slideTruncation() {
  await slide("03", "Cut off mid-stream? Keep what arrived.", "The connection dropped partway through the response.");
  const framed = encode(call, { profile: "generation", markers: true });
  const cut = framed.slice(0, Math.floor(framed.length * 0.6));
  const jsonStr = JSON.stringify(call);
  const jsonCut = jsonStr.slice(0, Math.floor(jsonStr.length * 0.6));

  out(PAD + bold(gray("JSON")) + "\n");
  out(PAD + "  " + gray(jsonCut) + "\n");
  cue("error");
  out(PAD + "  " + red("✗ JSON.parse  total loss") + gray("   retry the call, pay for it twice") + "\n");
  await sleep(1700);
  nl();

  out(PAD + bold(green("RAIF")) + "\n");
  const l = decodeLenient(cut);
  for (const ln of cut.split("\n")) {
    if (ln === "<raif>") out(PAD + "  " + cyan(ln) + gray("   opener arrived") + "\n");
    else if (ln && !ln.includes("=")) out(PAD + "  " + amber(ln) + gray("   ← stream cut here, this field is half written") + "\n");
    else out(PAD + "  " + gray(ln) + "\n");
    cue("diffctx");
    await sleep(120);
  }
  const kept = Object.keys(l.value).length;
  cue("success");
  out(PAD + "  " + green(`✓ decodeLenient  recovered ${kept} complete fields  `) + bold(amber("[truncated]")) + "\n");
  out(PAD + "    " + gray("flagged because the closing ") + cyan("</raif>") + gray(" tag never arrived") + "\n");
  out(PAD + "  " + gray("value: ") + white(JSON.stringify(l.value)) + "\n");
  nl();
  await type(PAD + bold(amber("Keep every field that arrived. No retry, no wasted tokens.")), 14);
  await sleep(2400);
}

async function slideEconomy() {
  await slide("04", "Fewer tokens, every call", "Same payloads, counted with the GPT tokenizer.");
  const byName = new Map(corpus.map((e) => [e.name, e.json]));
  const examples = ["short_tool_call", "nested_object", "large_table"];
  out(PAD + "  " + gray(padR("a few payloads", 20) + padL("JSON", 5) + "   " + padL("RAIF", 4)) + "\n");
  for (const name of examples) {
    const obj = byName.get(name);
    if (!obj) continue;
    const j = cl100k(JSON.stringify(obj)).length;
    const r = cl100k(encode(obj)).length;
    const p = (((r - j) / j) * 100).toFixed(0);
    cue("blip");
    out(
      PAD + "  " + white(padR(name, 20)) + gray(padL(String(j), 5)) + gray("  → ") +
      green(padL(String(r), 3)) + green("   " + p + "%") + "\n",
    );
    await sleep(350);
  }
  nl();

  let jsonTok = 0;
  let raifTok = 0;
  for (const e of corpus) {
    jsonTok += cl100k(JSON.stringify(e.json)).length;
    raifTok += cl100k(encode(e.json)).length;
  }
  const pct = (((raifTok - jsonTok) / jsonTok) * 100).toFixed(1);
  const W = 28;
  const drawBar = async (label: string, len: number, value: number, color: (s: string) => string, tick: boolean) => {
    out(PAD + "  " + gray(padR(label, 5)) + " ");
    for (let i = 0; i < len; i++) {
      out(color("█"));
      if (tick) cue("tick");
      await sleep(20);
    }
    out("  " + white(String(value)) + gray(" tokens") + "\n");
    await sleep(250);
  };
  out(PAD + "  " + gray("across the full set") + "\n");
  await drawBar("JSON", W, jsonTok, red, false);
  await drawBar("RAIF", Math.round((raifTok / jsonTok) * W), raifTok, green, true);
  nl();
  cue("success");
  await type(PAD + "  " + bold(green(`${pct.replace("-", "")}% fewer tokens on average`)), 22);
  nl(2);
  await type(PAD + gray("Smaller calls. Lower bills. Faster responses."), 14);
  await sleep(2200);
}

async function outro() {
  clear();
  cue("chord");
  nl(2);
  await wordmark();
  nl();
  await typeln(PAD + gray("A model-agnostic format for LLM output."), 16);
  nl();
  out(PAD + cyan("github.com/skrrt-sh/raif-standard") + "\n");
  out(PAD + cyan("huggingface.co/skrrt-sh/raif-llama-3.2-3b-lora") + "\n");
  nl();
  await typeln(PAD + gray("Open source. Apache-2.0."), 16);
  nl();
  await sleep(2400);
}

async function main() {
  T0 = now();
  await intro();
  await slideJsonBreaks();
  await slideRaifRepairs();
  await slideTruncation();
  await slideEconomy();
  await outro();
  if (CUE_PATH) writeFileSync(CUE_PATH, JSON.stringify({ dur: now() - T0, cues: CUES }));
}

main();
