// Generative ambient for the ocean, synthesised with Web Audio. It works the same in a
// live AudioContext and in an OfflineAudioContext: tick(t, view) schedules everything
// that should sound in [t, t + AHEAD), so the caller just calls it a few times a second.
//
// view: { light 0..1.3, animals, predators, dark, species: [{ id, hue, size, glow, count, pan }] }

const AHEAD = 1.2; // the page calls tick about twice a second
const mtof = m => 440 * 2 ** ((m - 69) / 12);
const rng = seed => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// Harmony. Bright: D major with a Lydian lift; dark: D Aeolian/Dorian. Each chord has a
// voicing for the pad and the pitch classes a melody may use over it.
const BRIGHT = [
  { pad: [50, 57, 61, 64, 66], bass: 38, mel: [2, 4, 6, 9, 1, 11] },  // Dmaj9
  { pad: [47, 54, 57, 62, 64], bass: 35, mel: [11, 2, 4, 6, 9] },     // Bm11
  { pad: [43, 50, 54, 57, 61], bass: 31, mel: [11, 1, 2, 6, 9] },     // Gmaj9♯11
  { pad: [45, 52, 59, 62, 66], bass: 33, mel: [9, 11, 2, 4, 6] }      // A6sus
];
const DARK = [
  { pad: [50, 57, 60, 64, 65], bass: 38, mel: [2, 4, 5, 9, 0] },      // Dm9
  { pad: [46, 53, 57, 62, 64], bass: 34, mel: [2, 4, 5, 9, 10] },     // B♭maj9♯11
  { pad: [43, 50, 53, 57, 58], bass: 31, mel: [7, 9, 10, 2, 5] },     // Gm9
  { pad: [45, 52, 55, 62, 64], bass: 33, mel: [9, 2, 4, 7] }          // A7sus
];
// Nearest pitch of a pitch-class set at or above a MIDI note.
function fit(pcs, from) { for (let m = from; m < from + 12; m++) if (pcs.includes(((m % 12) + 12) % 12)) return m; return from; }
function scaleNote(pcs, base, step) { // step-th note of the set counting up from base
  const sorted = []; for (let m = base; sorted.length < 16; m++) if (pcs.includes(m % 12)) sorted.push(m);
  return sorted[Math.max(0, Math.min(15, step))];
}

export class Ambient {
  constructor(ctx, out, { variant = 'loops', seed = 7, pace = 1 } = {}) {
    this.ctx = ctx; this.variant = variant; this.r = rng(seed); this.pace = pace;
    this.parts = new Set(variant.split('+'));
    // Bus: dry and two sends (reverb, echo), a gentle compressor and the output.
    this.out = ctx.createGain(); this.out.gain.value = 0;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 3; comp.attack.value = .02; comp.release.value = .4;
    this.out.connect(comp).connect(out);
    this.dry = ctx.createGain(); this.dry.connect(this.out);
    this.verb = ctx.createConvolver(); this.verb.buffer = this.impulse(5.5); const wet = ctx.createGain(); wet.gain.value = .9; this.verb.connect(wet).connect(this.out);
    this.echo = this.makeEcho();
    this.chord = 0; this.chordAt = 0; this.dark = false; this.slots = new Map(); this.events = 0;
    this.nextBubble = 1; this.nextCall = 4; this.nextBar = .5; this.bar = 0; this.phrase = null;
    if (this.parts.has('loops') || this.parts.has('water')) this.waterBed(this.parts.has('water') ? .5 : .18);
  }
  fadeIn(t, d = 2) { this.out.gain.setValueAtTime(0, t); this.out.gain.linearRampToValueAtTime(.9, t + d); }
  fadeOut(t, d = 2) { this.out.gain.setValueAtTime(.9, t); this.out.gain.linearRampToValueAtTime(0, t + d); }

  // A reverb tail: decorrelated noise whose decay darkens over time, like deep water.
  impulse(seconds) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * seconds), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch); let lp = 0;
      for (let i = 0; i < n; i++) {
        const x = i / n, k = .6 - .55 * x;                              // the low-pass closes as the tail decays
        lp += k * ((this.r() * 2 - 1) - lp);
        d[i] = lp * Math.exp(-5.2 * x) * (i < ctx.sampleRate * .02 ? i / (ctx.sampleRate * .02) : 1);
      }
    }
    return b;
  }
  makeEcho() { // ping-pong delay with a darkening feedback loop
    const ctx = this.ctx, input = ctx.createGain(), l = ctx.createDelay(2), r = ctx.createDelay(2), fb = ctx.createGain(), lp = ctx.createBiquadFilter();
    l.delayTime.value = .54; r.delayTime.value = .81; fb.gain.value = .38; lp.type = 'lowpass'; lp.frequency.value = 2200;
    const merge = ctx.createChannelMerger(2);
    input.connect(l); l.connect(lp).connect(r); r.connect(fb).connect(l);
    l.connect(merge, 0, 0); r.connect(merge, 0, 1);
    const g = ctx.createGain(); g.gain.value = .5; merge.connect(g); g.connect(this.out); g.connect(this.verb);
    return input;
  }
  send(node, dry, verb, echo = 0) {
    const ctx = this.ctx;
    if (dry) { const g = ctx.createGain(); g.gain.value = dry; node.connect(g).connect(this.dry); }
    if (verb) { const g = ctx.createGain(); g.gain.value = verb; node.connect(g).connect(this.verb); }
    if (echo) { const g = ctx.createGain(); g.gain.value = echo; node.connect(g).connect(this.echo); }
  }
  noise(seconds, color = 'pink') {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * seconds), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = this.r() * 2 - 1;
      if (color === 'brown') { last = (last + .02 * w) / 1.02; d[i] = last * 3.5; }
      else { b0 = .99765 * b0 + w * .099046; b1 = .963 * b1 + w * .2965164; b2 = .57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * .1848) * .18; }
    }
    return b;
  }

  // Water: a low swell and a soft moving band, always on under everything else.
  waterBed(level) {
    const ctx = this.ctx, t = ctx.currentTime;
    const deep = ctx.createBufferSource(); deep.buffer = this.noise(6, 'brown'); deep.loop = true;
    const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 380;
    const dg = ctx.createGain(); dg.gain.value = .16 * level;
    const swell = ctx.createOscillator(), sg = ctx.createGain(); swell.frequency.value = .07; sg.gain.value = .05 * level;
    swell.connect(sg).connect(dg.gain);
    deep.connect(dlp).connect(dg); this.send(dg, .8, .3);
    const band = ctx.createBufferSource(); band.buffer = this.noise(5, 'pink'); band.loop = true;
    this.band = ctx.createBiquadFilter(); this.band.type = 'bandpass'; this.band.frequency.value = 700; this.band.Q.value = .8;
    const bg = ctx.createGain(); bg.gain.value = .05 * level;
    const sweep = ctx.createOscillator(), sw = ctx.createGain(); sweep.frequency.value = .045; sw.gain.value = 300;
    sweep.connect(sw).connect(this.band.frequency);
    band.connect(this.band).connect(bg); this.send(bg, .6, .5);
    for (const s of [deep, swell, band, sweep]) s.start(t);
    this.bedGain = dg;
  }

  // ---------- scheduling ----------
  tick(t, view) {
    const end = t + AHEAD;
    this.view = view;
    if (this.band) this.band.frequency.setTargetAtTime(450 + 700 * Math.min(1.2, view.light), t, 2);
    const harmonic = this.parts.has('loops') || this.parts.has('piano');
    if (harmonic) this.harmony(t, end, view);
    if (this.parts.has('loops')) this.loops(t, end, view);
    if (this.parts.has('water')) this.creatures(t, end, view);
    if (this.parts.has('piano')) this.pianist(t, end, view);
  }
  chords() { return this.dark ? DARK : BRIGHT; }
  harmony(t, end, view) {
    const span = (this.parts.has('piano') ? 5 : 10) * this.pace;
    if (this.chordAt > end) return;
    const at = Math.max(this.chordAt, t);
    this.dark = view.predators > 0 || view.dark;
    // Chords walk around the cycle, mostly forward.
    if (this.events++) this.chord = (this.chord + (this.r() < .8 ? 1 : 2)) % 4;
    const c = this.chords()[this.chord];
    if (this.parts.has('loops')) this.pad(at, span, c, view);
    this.current = c; this.chordAt = at + span;
  }
  // A warm pad: two detuned saws per note through a low-pass that opens with the light.
  pad(t, span, c, view) {
    const ctx = this.ctx, lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = 'lowpass'; lp.Q.value = .6; lp.frequency.value = (view.dark ? 380 : 520) + 900 * Math.min(1.2, view.light);
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = .11; lg.gain.value = 160; lfo.connect(lg).connect(lp.frequency);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.03, t + 3.5); g.gain.setValueAtTime(.03, t + span); g.gain.linearRampToValueAtTime(0, t + span + 5);
    for (const m of c.pad) for (const [type, cents, k] of [['triangle', -6, 1], ['triangle', 5, 1], ['sawtooth', 0, .25]]) {
      const o = ctx.createOscillator(), og = ctx.createGain(); o.type = type; o.frequency.value = mtof(m); o.detune.value = cents; og.gain.value = k;
      o.connect(og).connect(lp); o.start(t); o.stop(t + span + 5.2);
    }
    lfo.start(t); lfo.stop(t + span + 5.2);
    lp.connect(g); this.send(g, .7, .5);
  }
  // Eno's loops: every visible species owns a voice with its own period; the periods are
  // incommensurate, so the voices drift in and out of phase and never repeat exactly.
  loops(t, end, view) {
    const PERIODS = [6.7, 8.3, 9.7, 11.9, 13.1, 15.7];
    const live = new Set();
    for (const s of view.species.slice(0, 6)) {
      live.add(s.id);
      let v = this.slots.get(s.id);
      if (!v) { v = { next: t + this.r() * 3, period: PERIODS[s.id % PERIODS.length] * this.pace, step: Math.floor(s.hue * 97) % 5, ratio: [1, 2, 3, 4][Math.floor(s.hue * 4) % 4] }; this.slots.set(s.id, v); }
      v.s = s;
    }
    for (const [id, v] of this.slots) {
      if (!live.has(id)) { this.slots.delete(id); continue; }
      while (v.next < end) {
        const s = v.s, busy = Math.min(1, .45 + s.count / 8);
        if (this.r() < busy) {
          const base = s.size > 1.6 ? 60 : 67, pcs = this.current.mel;
          const m = scaleNote(pcs, base, v.step + (this.r() < .25 ? 1 : 0));
          this.bell(v.next, mtof(m), .1 + .06 * Math.min(1, s.glow + .3), v.ratio, s.pan);
        }
        v.next += v.period;
      }
    }
  }
  // FM bell: a sine carrier, a modulator at a harmonic ratio whose depth fades quickly.
  bell(t, f, amp, ratio, pan = 0) {
    const ctx = this.ctx, car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain(), p = ctx.createStereoPanner();
    car.frequency.value = f; mod.frequency.value = f * ratio;
    mg.gain.setValueAtTime(f * ratio * 1.6, t); mg.gain.exponentialRampToValueAtTime(f * ratio * .08, t + 1.4);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + .006); g.gain.exponentialRampToValueAtTime(amp * .3, t + .9); g.gain.exponentialRampToValueAtTime(.0001, t + 5.5);
    p.pan.value = Math.max(-.8, Math.min(.8, pan));
    mod.connect(mg).connect(car.frequency); car.connect(g).connect(p); this.send(p, .55, .55, .3);
    for (const o of [car, mod]) { o.start(t); o.stop(t + 5.6); }
  }

  // ---------- an underwater soundscape ----------
  creatures(t, end, view) {
    while (this.nextBubble < end) { // bubbles rise where animals feed
      const n = 2 + Math.floor(this.r() * 6);
      for (let i = 0; i < n; i++) this.bubble(this.nextBubble + this.r() * .6, 500 + this.r() * 1700, this.r() * 1.6 - .8);
      this.nextBubble += (1.5 + this.r() * 4) / Math.sqrt(1 + view.animals / 6);
    }
    while (this.nextCall < end) { // a distant call, lower and longer when hunters are near
      const low = view.predators > 0;
      this.call(this.nextCall, low ? 98 : 147, low ? 6.5 : 4.5, this.r() * 1.2 - .6);
      this.nextCall += 9 + this.r() * 9;
    }
  }
  bubble(t, f, pan) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner(), d = .035 + this.r() * .06;
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 1.5, t + d);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.09, t + .004); g.gain.exponentialRampToValueAtTime(.0001, t + d);
    p.pan.value = pan; o.connect(g).connect(p); this.send(p, .5, .35);
    o.start(t); o.stop(t + d + .02);
  }
  call(t, f, d, pan) {
    const ctx = this.ctx, o = ctx.createOscillator(), o2 = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner();
    const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 4.5; vg.gain.value = f * .012;
    o.type = 'triangle'; o2.type = 'sine';
    for (const [osc, k] of [[o, 1], [o2, 2.01]]) {
      osc.frequency.setValueAtTime(f * k, t); osc.frequency.linearRampToValueAtTime(f * 1.45 * k, t + d * .35);
      osc.frequency.linearRampToValueAtTime(f * 1.3 * k, t + d * .6); osc.frequency.linearRampToValueAtTime(f * .85 * k, t + d);
      vib.connect(vg).connect(osc.frequency); osc.connect(lp);
    }
    lp.type = 'lowpass'; lp.frequency.value = 700;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.11, t + d * .3); g.gain.linearRampToValueAtTime(.08, t + d * .7); g.gain.linearRampToValueAtTime(0, t + d);
    p.pan.value = pan; lp.connect(g).connect(p); this.send(p, .25, 1, .15);
    for (const s of [o, o2, vib]) { s.start(t); s.stop(t + d + .1); }
  }

  // ---------- a slow pianist, in 3/4 like a Gymnopédie ----------
  pianist(t, end, view) {
    const beat = 60 / 70;
    while (this.nextBar < end) {
      const b = this.nextBar, c = this.current, vel = .35 + .2 * Math.min(1, view.light);
      // left hand: a low root on the first beat, the chord in the middle on the second
      let low = c.bass; while (low < 40) low += 12;
      this.piano(b, low, vel * .9, 0);
      const mid = c.pad.slice(1, 4).map(m => m + (m < 55 ? 12 : 0));
      mid.forEach((m, i) => this.piano(b + beat + i * .012, m, vel * .55, -.15 + .15 * i));
      // right hand: phrases of a few bars and rests between them; busier water, more notes
      if (!this.phrase && this.r() < .5 + Math.min(.4, view.animals / 60)) this.phrase = { bars: 2 + Math.floor(this.r() * 3), at: 72 + Math.floor(this.r() * 5) };
      if (this.phrase) {
        const rhythm = [[0], [0, 2], [1, 2], [0, 1.5, 2], [0]][Math.floor(this.r() * 5)];
        for (const k of rhythm) {
          this.phrase.at += [-2, -1, -1, 0, 1, 1, 2][Math.floor(this.r() * 7)];
          this.phrase.at = Math.max(69, Math.min(86, this.phrase.at));
          const m = k === 0 ? fit(c.mel, this.phrase.at) : fit(c.mel.concat([4, 9, 11].filter(() => !this.dark)), this.phrase.at);
          this.piano(b + k * beat + (this.r() - .5) * .04, m, vel * (.75 + .2 * this.r()), .2);
        }
        if (--this.phrase.bars <= 0) this.phrase = null;
      }
      this.nextBar += beat * 3; this.bar++;
      if (this.bar % 2 === 0) this.chordAt = Math.min(this.chordAt, this.nextBar); // two bars per chord
    }
  }
  piano(t, m, vel, pan) {
    const ctx = this.ctx, f = mtof(m);
    if (!this.wave) { // a felt piano: string harmonics, softened
      const n = 10, re = new Float32Array(n), im = new Float32Array(n);
      for (let k = 1; k < n; k++) im[k] = (1 / k ** 1.4) * (k % 2 ? 1 : .7);
      this.wave = ctx.createPeriodicWave(re, im);
    }
    const lp = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner(), long = Math.max(2.2, Math.min(7, 7 - (m - 40) * .09));
    lp.type = 'lowpass'; lp.Q.value = .3;
    lp.frequency.setValueAtTime(Math.min(9000, f * 3 + 2600 * vel), t); lp.frequency.setTargetAtTime(f * 1.6 + 300, t + .02, .6);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * .16, t + .012);
    g.gain.setTargetAtTime(vel * .07, t + .02, .25); g.gain.setTargetAtTime(0, t + .5, long / 4);
    for (const cents of [-1.2, 1.1]) { const o = ctx.createOscillator(); o.setPeriodicWave(this.wave); o.frequency.value = f; o.detune.value = cents; o.connect(lp); o.start(t); o.stop(t + long + .5); }
    p.pan.value = pan; lp.connect(g).connect(p); this.send(p, .7, .45, .08);
  }
}
