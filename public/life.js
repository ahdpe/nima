// Life and death on screen. The world's events are real; their pace on screen is decoration:
// a newborn grows out of its parent in a second or two, sizes change smoothly instead of in
// steps, and a body that dies fades and crumbles into detritus. Births are the bodies the
// server announces after the first full set; deaths are bodies that vanish inside the view,
// not at its edge. Nothing here costs the server anything.
import { MOD } from './render.js';

const GROW = 1.3, SPROUT = 2.2, FADE = 1.6;

export class Lifecycle {
  constructor() { this.newborn = new Map(); this.shown = new Map(); this.seen = new Map(); this.next = new Map(); this.ghosts = []; this.ready = false; }
  // After a (re)connection the next bodies message is the full set of the living, not births.
  reset() { this.ready = false; this.newborn.clear(); }
  announced(ids, now) {
    if (!this.ready) { this.ready = true; return; }
    for (const id of ids) this.newborn.set(id, { at: now, t0: null, from: null });
  }
  // Where and how big to draw a body now; f is its opacity.
  view(id, x, y, h, s, e, plant, now, dt, W) {
    let shown = this.shown.get(id);
    shown = shown === undefined ? s : shown + (s - shown) * Math.min(1, dt * 2); // growth and grazing, smoothly
    this.shown.set(id, shown);
    let size = shown, f = 1;
    const b = this.newborn.get(id);
    if (b) {
      if (b.t0 === null) { b.t0 = now; b.from = this.parentOf?.(id, x, y, plant) || null; }
      const k = (now - b.t0) / (plant ? SPROUT : GROW);
      if (k >= 1) this.newborn.delete(id);
      else {
        const ease = 1 - (1 - k) ** 3;
        size *= plant ? .04 + .96 * ease : .2 + .8 * ease; f = Math.min(1, k * 2.5);
        if (b.from) { const wd = d => d > W / 2 ? d - W : d < -W / 2 ? d + W : d; x = b.from.x + wd(x - b.from.x) * ease; y = b.from.y + wd(y - b.from.y) * ease; }
      }
    }
    this.next.set(id, { x, y, h, s: size, e, plant });
    return { x, y, s: size, f };
  }
  // End of a frame: bodies drawn last frame and gone now, inside the view, have died.
  end(now, inView, bodies, movers) {
    for (const [id, rec] of this.seen) {
      if (this.next.has(id)) continue;
      if (!rec.plant && !movers) { this.next.set(id, rec); continue; } // no movers this frame: they did not die
      this.shown.delete(id);
      if (inView(rec.x, rec.y)) { const body = bodies.get(id); if (body) this.ghosts.push({ ...rec, id, body, t0: now }); }
    }
    this.seen = this.next; this.next = new Map();
    if (this.ghosts.length > 80) this.ghosts.splice(0, this.ghosts.length - 80);
    if (this.newborn.size > 200) for (const [id, b] of this.newborn) if (b.t0 === null ? now - b.at > 30 : now - b.t0 > 10) this.newborn.delete(id); // never seen, or left the view
  }
  // The dead: the body dims and shrinks, a cloud of detritus spreads and settles.
  drawGhosts(r, draw, now, zoom) {
    this.ghosts = this.ghosts.filter(g => now - g.t0 < FADE);
    for (const g of this.ghosts) {
      const k = (now - g.t0) / FADE, f = 1 - k, R = 1.1 * Math.sqrt(.25 + g.body.modules.reduce((a, m) => a + m.s, 0) * g.s);
      draw(faded(r, f * f), g.body, g.id, g.x, g.y, g.h, g.s * (1 - .35 * k), g.e * f, now, zoom);
      r.push(g.x, g.y, 0, R * (1 + 1.6 * k), R * (1 + 1.6 * k), MOD.GLOW, .5, .45, .32, .22 * f);
      for (let i = 0; i < 6; i++) {
        const a = g.id * 1.7 + i * 1.047, d = R * (.3 + 1.3 * k);
        r.push(g.x + Math.cos(a) * d, g.y + Math.sin(a) * d, 0, .14, .14, MOD.FAT, .55, .48, .34, .8 * f);
      }
    }
  }
}
// A renderer whose every part is drawn at a fraction of its opacity.
export function faded(r, f) { return f >= 1 ? r : { push: (...a) => { a[9] *= f; r.push(...a); } }; }
