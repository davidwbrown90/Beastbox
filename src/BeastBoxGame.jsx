import { useState, useRef, useEffect, useCallback } from "react";

// ============ SOUND ENGINE ============
// Formant-filtered synthesis through a shared reverb. Each voice: pitched
// source (vibrato, growl, pitch contour, soft-clip drive) + breath noise,
// through parallel band-pass "vocal tract" resonances. Per-play random
// variation keeps calls from sounding canned.

async function makeCtx(ref) {
  // Safari/WKWebView treats Web Audio as "ambient" by default, which the
  // hardware silent switch mutes. The AudioSession API (Safari-only) opts
  // into "playback" so sound comes through regardless of the switch.
  if ("audioSession" in navigator) {
    try { navigator.audioSession.type = "playback"; } catch (e) { /* unsupported */ }
  }
  if (!ref.current) {
    ref.current = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (ref.current.state !== "running") {
    try { await ref.current.resume(); } catch (e) { /* attempt anyway */ }
  }
  return ref.current;
}

// shared master bus: dry + small-room convolution reverb
function getMaster(ctx) {
  if (ctx._bbMaster) return ctx._bbMaster;
  const input = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 0.8;
  input.connect(dry).connect(ctx.destination);

  const dur = 1.1, len = Math.ceil(ctx.sampleRate * dur);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
  }
  const conv = ctx.createConvolver();
  conv.buffer = ir;
  const wet = ctx.createGain(); wet.gain.value = 0.22;
  input.connect(conv).connect(wet).connect(ctx.destination);

  ctx._bbMaster = input;
  return input;
}

function softClipCurve(amount) {
  const n = 1024, curve = new Float32Array(n), k = amount * 40 + 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function noiseBuffer(ctx, dur) {
  const len = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

const jit = (v, pct = 0.05) => v * (1 + (Math.random() * 2 - 1) * pct);

function playVoice(ctx, {
  t0, dur, type = "sawtooth",
  pitch = [[0, 200]],
  vibRate = 0, vibDepth = 0,
  growlRate = 0, growlDepth = 0,
  formants = [{ f: 800, q: 1, g: 1 }],
  noise = 0, noiseFreq = 1500, noiseQ = 1,
  vol = 0.3, attack = 0.04, release = 0.1,
  drive = 0, varyPitch = 0.05,
}) {
  const master = getMaster(ctx);
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t0);
  out.gain.linearRampToValueAtTime(vol, t0 + attack);
  out.gain.setValueAtTime(vol, t0 + Math.max(attack, dur - release));
  out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  out.connect(master);

  if (growlRate > 0) {
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = jit(growlRate, 0.1);
    lg.gain.value = vol * growlDepth;
    lfo.connect(lg).connect(out.gain);
    lfo.start(t0); lfo.stop(t0 + dur);
  }

  const detune = 1 + (Math.random() * 2 - 1) * varyPitch;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(20, pitch[0][1] * detune), t0);
  for (let i = 1; i < pitch.length; i++) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(20, pitch[i][1] * detune), t0 + pitch[i][0] * dur);
  }
  if (vibRate > 0) {
    const vib = ctx.createOscillator(), vg = ctx.createGain();
    vib.frequency.value = jit(vibRate, 0.1);
    vg.gain.value = vibDepth;
    vib.connect(vg).connect(osc.frequency);
    vib.start(t0); vib.stop(t0 + dur);
  }

  let src = osc;
  if (drive > 0) {
    const sh = ctx.createWaveShaper();
    sh.curve = softClipCurve(drive);
    osc.connect(sh); src = sh;
  }

  formants.forEach(({ f, fEnd, q = 5, g = 1 }) => {
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(jit(f, 0.03), t0);
    if (fEnd) bp.frequency.exponentialRampToValueAtTime(jit(fEnd, 0.03), t0 + dur);
    bp.Q.value = q;
    const fg = ctx.createGain(); fg.gain.value = g;
    src.connect(bp).connect(fg).connect(out);
  });

  if (noise > 0) {
    const ns = ctx.createBufferSource();
    ns.buffer = noiseBuffer(ctx, dur + 0.05);
    const nf = ctx.createBiquadFilter();
    nf.type = "bandpass"; nf.frequency.value = noiseFreq; nf.Q.value = noiseQ;
    const ng = ctx.createGain(); ng.gain.value = noise;
    ns.connect(nf).connect(ng).connect(out);
    ns.start(t0);
  }

  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function playNoiseHit(ctx, { t0, dur, vol = 0.4, freq = 600, freqEnd, q = 2, attack = 0 }) {
  const master = getMaster(ctx);
  const ns = ctx.createBufferSource();
  ns.buffer = noiseBuffer(ctx, dur + 0.02);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(jit(freq, 0.06), t0);
  if (freqEnd) bp.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
  bp.Q.value = q;
  const g = ctx.createGain();
  if (attack > 0) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
  } else {
    g.gain.setValueAtTime(vol, t0);
  }
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  ns.connect(bp).connect(g).connect(master);
  ns.start(t0);
}

// ============ THE ANIMALS (20) ============

const ANIMALS = [
  {
    name: "Cow", emoji: "🐮",
    play: (ctx) => {
      const t = ctx.currentTime;
      playVoice(ctx, {
        t0: t, dur: jit(1.6, 0.1), vol: 0.5, attack: 0.28, release: 0.5,
        pitch: [[0, 86], [0.3, 96], [1, 68]],
        vibRate: 5.5, vibDepth: 3, drive: 0.35,
        formants: [
          { f: 210, fEnd: 440, q: 6, g: 1.4 },
          { f: 580, fEnd: 870, q: 8, g: 0.7 },
          { f: 1700, q: 10, g: 0.1 },
        ],
        noise: 0.03, noiseFreq: 900,
      });
    },
  },
  {
    name: "Cat", emoji: "🐱",
    play: (ctx) => {
      const t = ctx.currentTime;
      playVoice(ctx, {
        t0: t, dur: jit(0.9, 0.12), vol: 0.35, attack: 0.09, release: 0.28,
        pitch: [[0, 470], [0.3, 730], [0.55, 640], [1, 290]],
        vibRate: 24, vibDepth: 14,
        formants: [
          { f: 1150, fEnd: 680, q: 6, g: 1 },
          { f: 2700, fEnd: 1050, q: 8, g: 0.85 },
          { f: 3400, q: 10, g: 0.2 },
        ],
        noise: 0.07, noiseFreq: 2500, noiseQ: 2,
      });
    },
  },
  {
    name: "Dog", emoji: "🐶",
    play: (ctx) => {
      const t = ctx.currentTime;
      const gaps = Math.random() < 0.5 ? [0, 0.32] : [0, 0.27, 0.58];
      gaps.forEach((off) => {
        playNoiseHit(ctx, { t0: t + off, dur: 0.07, vol: 0.45, freq: 900, freqEnd: 400, q: 1 });
        playVoice(ctx, {
          t0: t + off, dur: 0.16, vol: 0.55, attack: 0.012, release: 0.1,
          pitch: [[0, 330], [1, 92]],
          growlRate: 32, growlDepth: 0.5, drive: 0.55,
          formants: [
            { f: 460, fEnd: 240, q: 3, g: 1.3 },
            { f: 1100, fEnd: 700, q: 4, g: 0.5 },
          ],
          noise: 0.2, noiseFreq: 800,
        });
      });
    },
  },
  {
    name: "Wolf", emoji: "🐺",
    play: (ctx) => {
      const t = ctx.currentTime;
      // long lonesome howl: rises, hangs, slowly falls away
      playVoice(ctx, {
        t0: t, dur: jit(2.1, 0.1), vol: 0.42, attack: 0.4, release: 0.8,
        pitch: [[0, 240], [0.25, 450], [0.7, 430], [1, 290]],
        vibRate: 4.5, vibDepth: 6, drive: 0.15,
        formants: [
          { f: 440, fEnd: 620, q: 3, g: 1.25 },
          { f: 1100, q: 5, g: 0.3 },
        ],
        noise: 0.04, noiseFreq: 800,
      });
    },
  },
  {
    name: "Duck", emoji: "🦆",
    play: (ctx) => {
      const t = ctx.currentTime;
      [[0, 0.22, 270], [0.28, 0.18, 245], [0.52, 0.15, 222]].forEach(([off, d, f]) => {
        playVoice(ctx, {
          t0: t + off, dur: d, vol: 0.4, attack: 0.02, release: 0.07,
          pitch: [[0, f], [0.7, f * 0.92], [1, f * 0.74]],
          growlRate: 95, growlDepth: 0.55, drive: 0.4,
          formants: [
            { f: 1300, q: 4, g: 1.1 },
            { f: 2500, q: 6, g: 0.5 },
            { f: 600, q: 3, g: 0.6 },
          ],
          noise: 0.06, noiseFreq: 2000,
        });
      });
    },
  },
  {
    name: "Frog", emoji: "🐸",
    play: (ctx) => {
      const t = ctx.currentTime;
      playVoice(ctx, {
        t0: t, dur: 0.3, vol: 0.42, attack: 0.03, release: 0.08, type: "square",
        pitch: [[0, 84], [1, 102]],
        growlRate: 26, growlDepth: 0.85,
        formants: [{ f: 350, q: 4, g: 1.2 }, { f: 1200, q: 6, g: 0.4 }],
        noise: 0.04, noiseFreq: 700,
      });
      playVoice(ctx, {
        t0: t + 0.36, dur: 0.16, vol: 0.38, attack: 0.015, release: 0.06, type: "square",
        pitch: [[0, 110], [1, 225]],
        growlRate: 30, growlDepth: 0.6,
        formants: [{ f: 500, fEnd: 920, q: 5, g: 1.1 }, { f: 1500, q: 7, g: 0.35 }],
      });
    },
  },
  {
    name: "Sheep", emoji: "🐑",
    play: (ctx) => {
      const t = ctx.currentTime;
      playVoice(ctx, {
        t0: t, dur: jit(1.05, 0.1), vol: 0.42, attack: 0.06, release: 0.3,
        pitch: [[0, 295], [0.7, 262], [1, 200]],
        vibRate: 7, vibDepth: 26, growlRate: 7, growlDepth: 0.45,
        formants: [
          { f: 650, q: 5, g: 1.2 },
          { f: 1150, q: 6, g: 0.7 },
          { f: 2600, q: 9, g: 0.18 },
        ],
        noise: 0.05, noiseFreq: 1800,
      });
    },
  },
  {
    name: "Goat", emoji: "🐐",
    play: (ctx) => {
      const t = ctx.currentTime;
      // like the sheep's annoying cousin: higher, faster wobble, more nasal
      playVoice(ctx, {
        t0: t, dur: jit(0.85, 0.1), vol: 0.42, attack: 0.04, release: 0.22,
        pitch: [[0, 380], [0.6, 340], [1, 255]],
        vibRate: 11.5, vibDepth: 38, growlRate: 11.5, growlDepth: 0.5,
        drive: 0.25,
        formants: [
          { f: 900, q: 5, g: 1.1 },
          { f: 1650, q: 6, g: 0.7 },
          { f: 3000, q: 9, g: 0.2 },
        ],
        noise: 0.07, noiseFreq: 2200,
      });
    },
  },
  {
    name: "Owl", emoji: "🦉",
    play: (ctx) => {
      const t = ctx.currentTime;
      [[0, 0.32, 410, 380], [0.5, 0.55, 395, 295]].forEach(([off, d, f1, f2]) => {
        playVoice(ctx, {
          t0: t + off, dur: d, vol: 0.42, attack: 0.07, release: 0.2, type: "sine",
          pitch: [[0, f1 * 0.92], [0.2, f1], [1, f2]],
          formants: [{ f: 420, q: 2, g: 1.3 }],
          noise: 0.05, noiseFreq: 500, noiseQ: 1,
        });
      });
    },
  },
  {
    name: "Pig", emoji: "🐷",
    play: (ctx) => {
      const t = ctx.currentTime;
      [0, 0.38].forEach((off) => {
        playNoiseHit(ctx, { t0: t + off, dur: 0.16, vol: 0.42, freq: 1400, freqEnd: 480, q: 4 });
        playVoice(ctx, {
          t0: t + off + 0.02, dur: 0.22, vol: 0.4, attack: 0.02, release: 0.1,
          pitch: [[0, 150], [0.4, 108], [1, 72]],
          growlRate: 45, growlDepth: 0.7, drive: 0.55,
          formants: [
            { f: 380, fEnd: 240, q: 3, g: 1.2 },
            { f: 1100, fEnd: 780, q: 5, g: 0.5 },
          ],
          noise: 0.16, noiseFreq: 1000,
        });
      });
    },
  },
  {
    name: "Elephant", emoji: "🐘",
    play: (ctx) => {
      const t = ctx.currentTime;
      playVoice(ctx, {
        t0: t, dur: jit(1.25, 0.1), vol: 0.42, attack: 0.1, release: 0.35,
        pitch: [[0, 255], [0.25, 530], [0.7, 480], [1, 340]],
        vibRate: 7, vibDepth: 22, growlRate: 38, growlDepth: 0.3, drive: 0.85,
        formants: [
          { f: 800, fEnd: 1000, q: 3, g: 1.1 },
          { f: 1800, q: 5, g: 0.6 },
          { f: 3000, q: 8, g: 0.25 },
        ],
        noise: 0.08, noiseFreq: 2200,
      });
    },
  },
  {
    name: "Rooster", emoji: "🐓",
    play: (ctx) => {
      const t = ctx.currentTime;
      [
        [0, 0.16, [[0, 560], [1, 600]]],
        [0.19, 0.16, [[0, 700], [1, 745]]],
        [0.38, 0.16, [[0, 620], [1, 665]]],
        [0.58, 0.6, [[0, 820], [0.3, 905], [1, 470]]],
      ].forEach(([off, d, p]) => {
        playVoice(ctx, {
          t0: t + off, dur: d, vol: 0.36, attack: 0.02, release: d > 0.3 ? 0.25 : 0.05,
          pitch: p, growlRate: 60, growlDepth: 0.5, drive: 0.6,
          formants: [
            { f: 1300, q: 4, g: 1 },
            { f: 2700, q: 6, g: 0.55 },
            { f: 700, q: 3, g: 0.5 },
          ],
          noise: 0.07, noiseFreq: 3000,
        });
      });
    },
  },
  {
    name: "Horse", emoji: "🐴",
    play: (ctx) => {
      const t = ctx.currentTime;
      // whinny: high fluttering squeal tumbling down...
      playVoice(ctx, {
        t0: t, dur: 1.15, vol: 0.38, attack: 0.05, release: 0.25,
        pitch: [[0, 980], [0.45, 760], [1, 240]],
        vibRate: 14, vibDepth: 70, growlRate: 28, growlDepth: 0.3, drive: 0.45,
        formants: [
          { f: 950, fEnd: 520, q: 4, g: 1.05 },
          { f: 2300, fEnd: 1200, q: 6, g: 0.5 },
        ],
        noise: 0.1, noiseFreq: 2400,
      });
      // ...into a low lippy nicker
      playVoice(ctx, {
        t0: t + 1.1, dur: 0.4, vol: 0.32, attack: 0.03, release: 0.15,
        pitch: [[0, 130], [1, 85]],
        growlRate: 23, growlDepth: 0.85, drive: 0.3,
        formants: [{ f: 320, q: 3, g: 1.3 }, { f: 900, q: 5, g: 0.4 }],
        noise: 0.08, noiseFreq: 700,
      });
    },
  },
  {
    name: "Donkey", emoji: "🫏",
    play: (ctx) => {
      const t = ctx.currentTime;
      // EE-AW, EE-AW: squealing inhale, honking exhale
      [0, 0.78].forEach((cyc) => {
        playVoice(ctx, {
          t0: t + cyc, dur: 0.32, vol: 0.34, attack: 0.04, release: 0.06,
          pitch: [[0, 420], [1, 1150]],
          growlRate: 42, growlDepth: 0.4, drive: 0.7,
          formants: [
            { f: 1500, q: 3, g: 1 },
            { f: 3000, q: 5, g: 0.5 },
          ],
          noise: 0.28, noiseFreq: 2600, noiseQ: 1.5,
        });
        playVoice(ctx, {
          t0: t + cyc + 0.36, dur: 0.36, vol: 0.4, attack: 0.02, release: 0.1,
          pitch: [[0, 270], [1, 135]],
          growlRate: 30, growlDepth: 0.6, drive: 0.6,
          formants: [
            { f: 700, fEnd: 450, q: 3, g: 1.2 },
            { f: 1300, q: 4, g: 0.5 },
          ],
          noise: 0.12, noiseFreq: 1200,
        });
      });
    },
  },
  {
    name: "Lion", emoji: "🦁",
    play: (ctx) => {
      const t = ctx.currentTime;
      // deep chest roar with heavy rolling growl
      playVoice(ctx, {
        t0: t, dur: jit(1.7, 0.08), vol: 0.52, attack: 0.14, release: 0.6,
        pitch: [[0, 88], [0.3, 135], [1, 58]],
        growlRate: 27, growlDepth: 0.8, drive: 0.9,
        formants: [
          { f: 300, q: 2, g: 1.3 },
          { f: 700, q: 3, g: 0.8 },
          { f: 1500, q: 5, g: 0.3 },
        ],
        noise: 0.15, noiseFreq: 600, noiseQ: 0.8,
      });
    },
  },
  {
    name: "Crow", emoji: "🐦‍⬛",
    play: (ctx) => {
      const t = ctx.currentTime;
      // two harsh grating caws
      [0, 0.42].forEach((off) => {
        playVoice(ctx, {
          t0: t + off, dur: 0.3, vol: 0.38, attack: 0.02, release: 0.1,
          pitch: [[0, 640], [0.6, 590], [1, 410]],
          growlRate: 72, growlDepth: 0.6, drive: 0.9,
          formants: [
            { f: 1250, q: 3, g: 1 },
            { f: 2500, q: 5, g: 0.6 },
          ],
          noise: 0.2, noiseFreq: 1900, noiseQ: 2,
        });
      });
    },
  },
  {
    name: "Monkey", emoji: "🐵",
    play: (ctx) => {
      const t = ctx.currentTime;
      // accelerating "oo-oo-oo-AH-AH" hoots, rising in pitch and excitement
      const hoots = [
        [0, 0.16, 290, 0.3],
        [0.26, 0.16, 330, 0.32],
        [0.5, 0.15, 380, 0.34],
        [0.7, 0.18, 460, 0.38],
        [0.92, 0.22, 540, 0.4],
      ];
      hoots.forEach(([off, d, f, v], i) => {
        const open = i >= 3; // last two open up into "AH"
        playVoice(ctx, {
          t0: t + off, dur: d, vol: v, attack: 0.025, release: 0.06,
          pitch: [[0, f], [0.5, f * 1.22], [1, f * 1.05]],
          growlRate: open ? 40 : 0, growlDepth: open ? 0.35 : 0, drive: 0.35,
          formants: open
            ? [{ f: 950, q: 4, g: 1.1 }, { f: 1700, q: 5, g: 0.6 }]
            : [{ f: 480, q: 4, g: 1.2 }, { f: 1100, q: 6, g: 0.35 }],
          noise: 0.08, noiseFreq: 1400,
        });
      });
    },
  },
  {
    name: "Turkey", emoji: "🦃",
    play: (ctx) => {
      const t = ctx.currentTime;
      // the gobble: one breathless wild warble
      playVoice(ctx, {
        t0: t, dur: jit(0.95, 0.1), vol: 0.4, attack: 0.03, release: 0.18,
        pitch: [[0, 310], [0.8, 290], [1, 230]],
        vibRate: 16, vibDepth: 85, growlRate: 50, growlDepth: 0.4, drive: 0.5,
        formants: [
          { f: 1100, q: 3, g: 1 },
          { f: 2000, q: 5, g: 0.5 },
          { f: 520, q: 3, g: 0.7 },
        ],
        noise: 0.09, noiseFreq: 1800,
      });
    },
  },
  {
    name: "Snake", emoji: "🐍",
    play: (ctx) => {
      const t = ctx.currentTime;
      // pure menacing hiss: broadband noise swelling then tailing off
      playNoiseHit(ctx, {
        t0: t, dur: jit(1.3, 0.1), vol: 0.5, freq: 4600, freqEnd: 3200, q: 0.7,
        attack: 0.18,
      });
      playNoiseHit(ctx, {
        t0: t + 0.05, dur: 1.1, vol: 0.2, freq: 7500, q: 1,
        attack: 0.22,
      });
    },
  },
  {
    name: "Bird", emoji: "🐦",
    play: (ctx) => {
      const t = ctx.currentTime;
      // bright songbird: three quick chirps then a trill
      [[0, 2300, 3600], [0.16, 2600, 3300], [0.3, 2100, 3800]].forEach(([off, f1, f2]) => {
        playVoice(ctx, {
          t0: t + off, dur: 0.09, vol: 0.26, attack: 0.008, release: 0.04, type: "sine",
          pitch: [[0, f1], [1, f2]],
          formants: [{ f: 3000, q: 1, g: 1.4 }],
          varyPitch: 0.08,
        });
      });
      playVoice(ctx, {
        t0: t + 0.48, dur: 0.32, vol: 0.24, attack: 0.02, release: 0.1, type: "sine",
        pitch: [[0, 2900], [1, 2600]],
        vibRate: 24, vibDepth: 320,
        formants: [{ f: 3000, q: 1, g: 1.4 }],
        varyPitch: 0.08,
      });
    },
  },
];

// animals that sound alike — the game loves to offer these together
const CONFUSABLE = {
  Sheep: "Goat", Goat: "Sheep",
  Dog: "Wolf", Wolf: "Dog",
  Horse: "Donkey", Donkey: "Horse",
  Rooster: "Crow", Crow: "Rooster",
  Duck: "Turkey", Turkey: "Duck",
  Cat: "Lion", Lion: "Cat",
};

// ============ UI SOUND EFFECTS ============

function sfxCorrect(ctx, streak) {
  const t = ctx.currentTime;
  const base = 520 * Math.pow(1.06, Math.min(streak, 12));
  [0, 0.07].forEach((off, i) => {
    playVoice(ctx, {
      t0: t + off, dur: 0.12, vol: 0.18, attack: 0.005, release: 0.08, type: "sine",
      pitch: [[0, base * (i ? 1.5 : 1)]], formants: [{ f: 1200, q: 0.7, g: 1.4 }],
      varyPitch: 0,
    });
  });
}

function sfxWrong(ctx) {
  const t = ctx.currentTime;
  playVoice(ctx, {
    t0: t, dur: 0.25, vol: 0.16, attack: 0.005, release: 0.1, type: "square",
    pitch: [[0, 160], [1, 110]], formants: [{ f: 300, q: 1, g: 1.3 }],
    varyPitch: 0,
  });
}

function sfxGameOver(ctx) {
  const t = ctx.currentTime;
  [380, 320, 250].forEach((f, i) => {
    playVoice(ctx, {
      t0: t + i * 0.16, dur: 0.2, vol: 0.16, attack: 0.01, release: 0.1, type: "triangle",
      pitch: [[0, f]], formants: [{ f: 800, q: 0.7, g: 1.4 }], varyPitch: 0,
    });
  });
}

// ============ HIGH SCORES (persistent, on-device) ============
// Plain localStorage — works unmodified both in a regular browser and inside
// a Capacitor-wrapped iOS WebView, so no native storage plugin is needed.

const HS_KEY = "beastbox-highscores";

async function loadScores() {
  try {
    const raw = localStorage.getItem(HS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

async function saveScores(scores) {
  try {
    localStorage.setItem(HS_KEY, JSON.stringify(scores));
  } catch (e) { /* fall back to session-only */ }
}

// ============ GAME ============

const GAME_SECONDS = 60;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);

export default function BeastBoxGame() {
  const ctxRef = useRef(null);
  const [screen, setScreen] = useState("menu"); // menu | play | end
  const [timeLeft, setTimeLeft] = useState(GAME_SECONDS);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [round, setRound] = useState(null);
  const [locked, setLocked] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [popup, setPopup] = useState(null);
  const [highScores, setHighScores] = useState([]);
  const [scoresLoaded, setScoresLoaded] = useState(false);
  const [isNewBest, setIsNewBest] = useState(false);
  const [stats, setStats] = useState({ right: 0, wrong: 0 });

  const roundStart = useRef(0);
  const lastAnswer = useRef(null);
  const timerRef = useRef(null);
  const endedRef = useRef(false);

  useEffect(() => {
    loadScores().then((s) => { setHighScores(s); setScoresLoaded(true); });
    return () => clearInterval(timerRef.current);
  }, []);

  const multiplier = 1 + Math.min(Math.floor(streak / 3), 4); // x1..x5

  const playAnimal = useCallback(async (animal) => {
    const ctx = await makeCtx(ctxRef);
    animal.play(ctx);
  }, []);

  const nextRound = useCallback((delay = 350) => {
    setLocked(true);
    setTimeout(() => {
      let answer = pick(ANIMALS);
      while (answer.name === lastAnswer.current) answer = pick(ANIMALS);
      lastAnswer.current = answer.name;

      // build decoys — usually include the sound-alike partner if there is one
      const partnerName = CONFUSABLE[answer.name];
      let pool = ANIMALS.filter((a) => a.name !== answer.name);
      const decoys = [];
      if (partnerName && Math.random() < 0.75) {
        decoys.push(ANIMALS.find((a) => a.name === partnerName));
        pool = pool.filter((a) => a.name !== partnerName);
      }
      decoys.push(...shuffle(pool).slice(0, 3 - decoys.length));

      setRound({ answer, choices: shuffle([answer, ...decoys]) });
      setFeedback(null);
      setLocked(false);
      roundStart.current = Date.now();
      playAnimal(answer);
    }, delay);
  }, [playAnimal]);

  const endGame = useCallback(async (finalScore, finalBestStreak, finalStats) => {
    if (endedRef.current) return;
    endedRef.current = true;
    clearInterval(timerRef.current);
    const ctx = await makeCtx(ctxRef);
    sfxGameOver(ctx);

    const entry = {
      score: finalScore,
      streak: finalBestStreak,
      right: finalStats.right,
      wrong: finalStats.wrong,
      date: new Date().toISOString().slice(0, 10),
    };
    const prevBest = highScores[0]?.score ?? 0;
    const updated = [...highScores, entry]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    setHighScores(updated);
    setIsNewBest(finalScore > 0 && finalScore > prevBest);
    saveScores(updated);
    setScreen("end");
  }, [highScores]);

  const startGame = useCallback(async () => {
    await makeCtx(ctxRef); // unlock audio inside the tap
    endedRef.current = false;
    setScore(0); setStreak(0); setBestStreak(0);
    setStats({ right: 0, wrong: 0 });
    setIsNewBest(false);
    setTimeLeft(GAME_SECONDS);
    setScreen("play");
    lastAnswer.current = null;
    nextRound(150);

    const t0 = Date.now();
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const remaining = GAME_SECONDS - (Date.now() - t0) / 1000;
      setTimeLeft(Math.max(0, remaining));
    }, 100);
  }, [nextRound]);

  const scoreRef = useRef(0); scoreRef.current = score;
  const bestStreakRef = useRef(0); bestStreakRef.current = bestStreak;
  const statsRef = useRef(stats); statsRef.current = stats;
  useEffect(() => {
    if (screen === "play" && timeLeft <= 0) {
      endGame(scoreRef.current, bestStreakRef.current, statsRef.current);
    }
  }, [timeLeft, screen, endGame]);

  const handleChoice = useCallback(async (animal) => {
    if (locked || !round || timeLeft <= 0) return;
    const ctx = await makeCtx(ctxRef);
    const correct = animal.name === round.answer.name;

    if (correct) {
      const elapsed = (Date.now() - roundStart.current) / 1000;
      const speedBonus = elapsed < 1.5 ? 50 : elapsed < 3 ? 25 : 0;
      const gain = (100 + speedBonus) * multiplier;
      const newStreak = streak + 1;
      sfxCorrect(ctx, newStreak);
      setScore((s) => s + gain);
      setStreak(newStreak);
      setBestStreak((b) => Math.max(b, newStreak));
      setStats((st) => ({ ...st, right: st.right + 1 }));
      setFeedback({ name: animal.name, ok: true });
      setPopup({ text: `+${gain}${speedBonus ? " ⚡" : ""}`, key: Date.now() });
      nextRound(400);
    } else {
      sfxWrong(ctx);
      setStreak(0);
      setStats((st) => ({ ...st, wrong: st.wrong + 1 }));
      setFeedback({ name: animal.name, ok: false });
      setPopup({ text: "✗", key: Date.now() });
      nextRound(900);
    }
  }, [locked, round, timeLeft, streak, multiplier, nextRound]);

  const pct = (timeLeft / GAME_SECONDS) * 100;
  const urgent = timeLeft <= 10;
  const best = highScores[0]?.score ?? 0;

  return (
    <div style={styles.page}>
      <style>{css}</style>

      {screen === "menu" && (
        <div style={styles.center} className="fadeIn">
          <span style={styles.eyebrow}>The</span>
          <h1 style={styles.title}>Beast Box</h1>
          <p style={styles.sub}>Hear the noise. Tap the animal. 60 seconds. 20 beasts.</p>
          {scoresLoaded && best > 0 && (
            <div style={styles.bestBadge}>🏆 Best: {best.toLocaleString()}</div>
          )}
          <button className="bigBtn" style={styles.bigBtn} onClick={startGame}>
            START
          </button>
          {scoresLoaded && highScores.length > 0 && (
            <ScoreTable scores={highScores} />
          )}
          <p style={styles.hint}>
            Combos multiply points · fast answers earn ⚡ · beware the sound-alikes 🐑🐐
          </p>
        </div>
      )}

      {screen === "play" && round && (
        <div style={styles.playWrap}>
          <div style={styles.timerTrack}>
            <div
              className={urgent ? "pulse" : ""}
              style={{
                ...styles.timerFill,
                width: `${pct}%`,
                background: urgent ? "#E63946" : "#3D348B",
              }}
            />
          </div>

          <div style={styles.hud}>
            <div style={styles.hudScore}>{score.toLocaleString()}</div>
            <div style={{ ...styles.hudTime, color: urgent ? "#E63946" : "#1B1B1E" }}>
              {Math.ceil(timeLeft)}s
            </div>
            <div style={{ ...styles.hudCombo, opacity: multiplier > 1 ? 1 : 0.35 }}>
              x{multiplier} {streak > 0 && `🔥${streak}`}
            </div>
          </div>

          {popup && (
            <div key={popup.key} className="floatUp" style={styles.popup}>
              {popup.text}
            </div>
          )}

          <button
            className="replayBtn"
            style={styles.replayBtn}
            onClick={() => playAnimal(round.answer)}
            disabled={locked}
          >
            🔊 Play it again
          </button>

          <div style={styles.grid}>
            {round.choices.map((a) => {
              const isAnswer = a.name === round.answer.name;
              const picked = feedback?.name === a.name;
              let bg = "#FFF8EC", border = "#1B1B1E";
              if (feedback) {
                if (picked && feedback.ok) { bg = "#9EE493"; border = "#2A9D3A"; }
                else if (picked && !feedback.ok) { bg = "#FFB3AB"; border = "#E63946"; }
                else if (!feedback.ok && isAnswer) { bg = "#9EE493"; border = "#2A9D3A"; }
              }
              return (
                <button
                  key={a.name}
                  className="card"
                  style={{ ...styles.card, background: bg, borderColor: border }}
                  onClick={() => handleChoice(a)}
                  aria-label={a.name}
                >
                  <span style={styles.cardEmoji}>{a.emoji}</span>
                  <span style={styles.cardName}>{a.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {screen === "end" && (
        <div style={styles.center} className="fadeIn">
          {isNewBest && <div className="bounce" style={styles.newBest}>🎉 NEW HIGH SCORE!</div>}
          <span style={styles.eyebrow}>Time's up</span>
          <div style={styles.finalScore}>{score.toLocaleString()}</div>
          <div style={styles.endStats}>
            ✅ {stats.right} right · ❌ {stats.wrong} wrong · 🔥 best streak {bestStreak}
          </div>
          <button className="bigBtn" style={styles.bigBtn} onClick={startGame}>
            PLAY AGAIN
          </button>
          <ScoreTable scores={highScores} highlight={score} />
        </div>
      )}
    </div>
  );
}

function ScoreTable({ scores, highlight }) {
  let highlighted = false;
  return (
    <div style={styles.table}>
      <div style={styles.tableTitle}>HIGH SCORES</div>
      {scores.map((s, i) => {
        const isThis = !highlighted && highlight != null && s.score === highlight;
        if (isThis) highlighted = true;
        return (
          <div
            key={i}
            style={{
              ...styles.tableRow,
              background: isThis ? "#3D348B" : "transparent",
              color: isThis ? "#FFF8EC" : "#1B1B1E",
            }}
          >
            <span style={styles.tableRank}>{["🥇", "🥈", "🥉", "4.", "5."][i]}</span>
            <span style={styles.tableScore}>{s.score.toLocaleString()}</span>
            <span style={styles.tableMeta}>🔥{s.streak} · {s.date}</span>
          </div>
        );
      })}
    </div>
  );
}

// ============ STYLES ============

const css = `
  .bigBtn { transition: transform 0.08s ease, box-shadow 0.08s ease; }
  .bigBtn:hover { transform: translateY(-3px); }
  .bigBtn:active { transform: translateY(5px) scale(0.97); box-shadow: 0 2px 0 #7a1f00 !important; }
  .card { transition: transform 0.07s ease; }
  .card:active { transform: scale(0.94); }
  .replayBtn:active { transform: scale(0.95); }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  .fadeIn { animation: fadeIn 0.3s ease both; }
  @keyframes floatUp {
    0% { opacity: 0; transform: translateY(8px) scale(0.8); }
    25% { opacity: 1; transform: translateY(0) scale(1.15); }
    100% { opacity: 0; transform: translateY(-34px) scale(1); }
  }
  .floatUp { animation: floatUp 0.8s ease-out both; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
  .pulse { animation: pulse 0.6s infinite; }
  @keyframes bounce {
    0% { transform: scale(0.4); } 60% { transform: scale(1.15); } 100% { transform: scale(1); }
  }
  .bounce { animation: bounce 0.45s cubic-bezier(.2,1.6,.4,1) both; }
  @media (prefers-reduced-motion: reduce) {
    .fadeIn, .floatUp, .pulse, .bounce { animation: none; }
    .bigBtn, .card, .replayBtn { transition: none; }
  }
`;

const styles = {
  page: {
    minHeight: "100vh",
    background: "#FFD23F",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px 14px",
    fontFamily: "'Trebuchet MS', 'Segoe UI', sans-serif",
    color: "#1B1B1E",
    textAlign: "center",
  },
  center: { display: "flex", flexDirection: "column", alignItems: "center", gap: "14px", width: "100%", maxWidth: "420px" },
  eyebrow: { fontSize: "13px", letterSpacing: "0.35em", textTransform: "uppercase", fontWeight: 700, color: "#3D348B" },
  title: { margin: 0, fontSize: "clamp(44px, 10vw, 72px)", fontWeight: 900, letterSpacing: "-0.02em", textShadow: "4px 4px 0 #FF6B35" },
  sub: { margin: 0, fontSize: "16px", fontWeight: 600, opacity: 0.75 },
  bestBadge: { fontSize: "15px", fontWeight: 800, background: "#FFF8EC", border: "3px solid #1B1B1E", borderRadius: "999px", padding: "6px 18px" },
  bigBtn: {
    fontFamily: "inherit", fontSize: "clamp(22px, 5vw, 30px)", fontWeight: 900, letterSpacing: "0.08em",
    padding: "20px 58px", borderRadius: "999px", border: "4px solid #1B1B1E",
    background: "#FF6B35", color: "#FFF8EC", cursor: "pointer", boxShadow: "0 7px 0 #7a1f00",
    marginTop: "6px",
  },
  hint: { fontSize: "13px", fontWeight: 600, opacity: 0.55, margin: 0 },

  playWrap: { width: "100%", maxWidth: "440px", display: "flex", flexDirection: "column", gap: "12px", position: "relative" },
  timerTrack: { height: "14px", background: "rgba(27,27,30,0.15)", borderRadius: "999px", border: "2px solid #1B1B1E", overflow: "hidden" },
  timerFill: { height: "100%", borderRadius: "999px", transition: "width 0.1s linear" },
  hud: { display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 4px" },
  hudScore: { fontSize: "30px", fontWeight: 900 },
  hudTime: { fontSize: "22px", fontWeight: 900, fontVariantNumeric: "tabular-nums" },
  hudCombo: { fontSize: "17px", fontWeight: 800, color: "#3D348B" },
  popup: {
    position: "absolute", top: "86px", left: 0, right: 0, margin: "0 auto",
    fontSize: "26px", fontWeight: 900, color: "#2A9D3A", pointerEvents: "none", zIndex: 2,
  },
  replayBtn: {
    fontFamily: "inherit", fontSize: "15px", fontWeight: 800, alignSelf: "center",
    padding: "9px 22px", borderRadius: "999px", border: "3px solid #1B1B1E",
    background: "#FFF8EC", cursor: "pointer",
  },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" },
  card: {
    fontFamily: "inherit", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    gap: "6px", padding: "22px 8px", borderRadius: "20px", borderWidth: "4px", borderStyle: "solid",
    cursor: "pointer", boxShadow: "0 5px 0 rgba(27,27,30,0.35)",
  },
  cardEmoji: { fontSize: "56px", lineHeight: 1 },
  cardName: { fontSize: "15px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em" },

  newBest: { fontSize: "22px", fontWeight: 900, color: "#3D348B" },
  finalScore: { fontSize: "clamp(52px, 14vw, 80px)", fontWeight: 900, lineHeight: 1, textShadow: "4px 4px 0 #FF6B35" },
  endStats: { fontSize: "15px", fontWeight: 700, opacity: 0.75 },

  table: { width: "100%", background: "#FFF8EC", border: "3px solid #1B1B1E", borderRadius: "16px", padding: "12px 14px", marginTop: "4px" },
  tableTitle: { fontSize: "13px", fontWeight: 900, letterSpacing: "0.25em", marginBottom: "8px", color: "#3D348B" },
  tableRow: { display: "flex", alignItems: "baseline", gap: "10px", padding: "5px 8px", borderRadius: "8px", fontSize: "15px" },
  tableRank: { width: "26px", fontWeight: 900 },
  tableScore: { fontWeight: 900, fontVariantNumeric: "tabular-nums" },
  tableMeta: { marginLeft: "auto", fontSize: "12.5px", fontWeight: 600, opacity: 0.7 },
};
