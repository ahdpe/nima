// Procedural sound, synthesised in the browser (see ambient.js): every species the camera
// sees owns a bell loop over a slow pad and the sound of water; light opens the pad,
// nearby predators and meteor dust turn the harmony dark, feeding herds raise bubbles.
import { Ambient } from './ambient.js';

export class Sound {
  constructor() { this.ctx = null; this.on = false; }
  start() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.amb = new Ambient(this.ctx, this.ctx.destination, { variant: 'loops+water', seed: Date.now() % 100000 });
    }
    this.ctx.resume(); this.on = true;
    const t = this.ctx.currentTime; this.amb.out.gain.cancelScheduledValues(t); this.amb.fadeIn(t, 2.5);
  }
  stop() {
    if (!this.ctx) return; this.on = false;
    const t = this.ctx.currentTime; this.amb.out.gain.cancelScheduledValues(t); this.amb.out.gain.setValueAtTime(this.amb.out.gain.value, t); this.amb.out.gain.linearRampToValueAtTime(0, t + .8);
    setTimeout(() => { if (!this.on) this.ctx.suspend(); }, 1000);
  }
  // view: { light (0..1.3), voices: [{sp, size, hue, glow, pan}], predators (count near), dark (meteor dust) }
  update(view) {
    if (!this.on || !this.ctx) return;
    const groups = new Map();
    for (const v of view.voices) {
      const g = groups.get(v.sp) || { id: v.sp, hue: v.hue, size: 0, glow: 0, count: 0, pan: 0 };
      g.size += v.size; g.glow += v.glow; g.pan += v.pan; g.count++; groups.set(v.sp, g);
    }
    const species = [...groups.values()].map(g => ({ ...g, size: g.size / g.count, glow: g.glow / g.count, pan: g.pan / g.count })).sort((a, b) => b.count - a.count);
    this.amb.tick(this.ctx.currentTime, { light: view.light, animals: view.voices.length, predators: view.predators, dark: view.dark, species });
  }
}
