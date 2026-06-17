// Synthesizes a soundtrack for the RAIF demo from a cue sheet. No samples, no
// mp3 — every sound is generated from oscillators written straight to a 16-bit
// PCM WAV.
//
//   bun run src/gen_audio.ts <cues.json> <out.wav> [offsetSeconds] [totalSeconds]
//
// Design: one light, soft arpeggiated melody (a gentle I-V-vi-IV loop) plus a
// soft bell chime on the moments that deserve attention (errors and the key
// successes). Nothing else makes a sound.

import { readFileSync, writeFileSync } from "node:fs";

const [, , cuePath, outPath, offsetArg, totalArg] = process.argv;
if (!cuePath || !outPath) {
  console.error("usage: bun run src/gen_audio.ts <cues.json> <out.wav> [offset] [total]");
  process.exit(1);
}
const OFFSET = offsetArg ? parseFloat(offsetArg) : 0.82;

const SR = 44100;
const sheet = JSON.parse(readFileSync(cuePath, "utf8")) as {
  dur: number;
  cues: Array<{ t: number; k: string }>;
};
const TOTAL = totalArg ? parseFloat(totalArg) : sheet.dur / 1000 + OFFSET + 2.5;
const N = Math.ceil(TOTAL * SR);
const buf = new Float32Array(N);
const clampIdx = (i: number) => i >= 0 && i < N;

// soft pluck / pad tone with attack + exponential release
function tone(atSec: number, freq: number, durSec: number, gain: number, attack = 0.01) {
  const start = Math.floor(atSec * SR);
  const len = Math.floor(durSec * SR);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (!clampIdx(idx)) continue;
    const tt = i / SR;
    const env = tt < attack ? tt / attack : Math.exp(-(tt - attack) / (durSec * 0.35));
    buf[idx]! += Math.sin(2 * Math.PI * freq * tt) * env * gain;
  }
}

// soft bell: fundamental + two gentle partials, medium decay
function _bell(atSec: number, freq: number, gain: number, durSec = 0.7) {
  const start = Math.floor(atSec * SR);
  const len = Math.floor(durSec * SR);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (!clampIdx(idx)) continue;
    const tt = i / SR;
    const env = tt < 0.006 ? tt / 0.006 : Math.exp(-(tt - 0.006) / (durSec * 0.3));
    const s =
      Math.sin(2 * Math.PI * freq * tt) +
      0.4 * Math.sin(2 * Math.PI * freq * 2.01 * tt) +
      0.16 * Math.sin(2 * Math.PI * freq * 3.0 * tt);
    buf[idx]! += s * env * gain;
  }
}

// ── the melody: a gentle I-V-vi-IV arpeggio in C, soft, with a low pad ────────
const C4 = 261.63,
  D5 = 587.33,
  E4 = 329.63,
  E5 = 659.25,
  F4 = 349.23,
  F5 = 698.46;
const G4 = 392.0,
  G5 = 783.99,
  A4 = 440.0,
  A5 = 880.0,
  B4 = 493.88,
  C5 = 523.25;
// each chord = four ascending chord tones to arpeggiate over
const PROG: number[][] = [
  [C4, E4, G4, C5], // C
  [G4, B4, D5, G5], // G
  [A4, C5, E5, A5], // Am
  [F4, A4, C5, F5], // F
];
const PAD_ROOTS = [130.81, 196.0, 220.0, 174.61]; // C3 G3 A3 F3
const PATTERN = [0, 1, 2, 3, 2, 1, 2, 3]; // gentle up-and-back
const BAR = 3.2; // seconds per chord
const STEP = BAR / PATTERN.length;

const melodyStart = OFFSET;
const melodyEnd = TOTAL - 0.3;
let bar = 0;
for (let t = melodyStart; t < melodyEnd; t += BAR, bar++) {
  const chord = PROG[bar % PROG.length]!;
  // soft sustained pad under the bar
  tone(t, PAD_ROOTS[bar % PAD_ROOTS.length]!, BAR, 0.03, 0.25);
  tone(t, PAD_ROOTS[bar % PAD_ROOTS.length]! * 1.5, BAR, 0.018, 0.25);
  // arpeggio
  for (let s = 0; s < PATTERN.length; s++) {
    const at = t + s * STEP;
    if (at >= melodyEnd) break;
    tone(at, chord[PATTERN[s]!]!, 0.62, 0.05, 0.012);
  }
}

// ── gentle global fade in/out, soft-clip, write WAV ───────────────────────────
const fadeIn = OFFSET + 1.4;
const fadeOut = TOTAL - 2.5;
for (let i = 0; i < N; i++) {
  const tt = i / SR;
  let g = 1;
  if (tt < fadeIn) g = Math.max(0, (tt - OFFSET) / 1.4);
  if (tt > fadeOut) g = Math.max(0, (TOTAL - tt) / 2.5);
  buf[i]! *= g;
}

let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(buf[i]!));
const norm = peak > 0 ? Math.min(1, 0.4 / peak) : 1; // keep it soft and a touch quieter
const pcm = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) {
  const s = Math.tanh(buf[i]! * norm * 1.05);
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);
writeFileSync(outPath, Buffer.concat([header, pcm]));
console.log(`wrote ${outPath}  (${TOTAL.toFixed(1)}s, background melody only, ${bar} bars)`);
