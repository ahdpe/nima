// How a body looks, from its genome. Shared by the ocean and the lab page.
import { MOD } from './render.js';

export function hsl(h, s, l) { const f = n => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); }; return [f(0), f(8), f(4)]; }
export const halos = [];
// Organ types 0–6 share their numbers with the renderer's kinds (MOD.PHOTO … MOD.FAT); the two
// newer organs do not, so they have their own names here.
const TENTACLE = 7, SPINE = 8;
// The colour of chloroplasts: green (pigment 0) through olive and brown to red (from .7), as in
// green, brown and red algae; a starving plant pales and yellows.
export function pigmentColor(pig, e, hue = 0) {
  // anchors: green (hue, saturation, lightness), olive-brown at .35, crimson-red from .7
  const G = [.27 + hue * .08, .62, .4], B = [.075, .42, .3], R = [-.03, .55, .3];
  const [a, b, k] = pig < .35 ? [G, B, pig / .35] : [B, R, Math.min(1, (pig - .35) / .35)];
  const h = a[0] + (b[0] - a[0]) * k, s = a[1] + (b[1] - a[1]) * k, l = a[2] + (b[2] - a[2]) * k;
  return hsl(((h - (1 - e) * .05) % 1 + 1) % 1, s * (.65 + .45 * e), l * (.7 + .45 * e));
}
// The artist's looks of species (from the chronicler): pattern, density, contrast, hue, lightness.
// They dress the body's surface only; what the body is made of still comes from its genes.
export const looks = new Map();
const NO_LOOK = [0, 0, 0, 0];
function decoOf(sp) { const l = looks.get(sp); return l ? [l.p + Math.min(.99, l.d * .99), l.c, l.h, l.l] : NO_LOOK; }
// A fixed number in [0, 1) for each creature and each purpose: its individual fingerprint.
export function hash(id, k) { const v = Math.sin(id * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); }
export function radius(body, scale) { let total = 0; for (const m of body.modules) total += m.s * scale; return 1.1 * Math.sqrt(.25 + total); }

// zoom is screen pixels per world unit: small organs are drawn only when they can be seen.
export function drawBody(r, body, id, x, y, heading, scale, energy, glow, flags, time, zoom) {
  if (!body) { r.push(x, y, 0, .8, .8, MOD.CORE, .3, .45, .55, .9, 0, 40.5); return; }
  const R = radius(body, scale), fine = zoom * R > 6;
  const ph = (id % 97) / 97 * 6.283;
  if (!body.acts) { // a plant grows in one of seven forms (see flora); heading is its fixed axis
    const deco = decoOf(body.sp);
    const f = flora(body), e = Math.max(0, Math.min(1, energy)), spin = f.spin + Math.sin(time * .45 + ph) * .05, Ro = R * 1.15;
    // Every plant is its own individual: a fixed fingerprint from its number shifts its shade, the
    // width and curve of each leaf, the number and sweep of fronds, the curve of a runner.
    const u1 = hash(id, 1), u2 = hash(id, 2), u3 = hash(id, 3);
    const leaf = pigmentColor(body.pig || 0, e, body.hue).map((v, k) => v * (.9 + .2 * hash(id, 4 + k))), edge = f.lobes + Math.min(.6, f.depth * (.8 + .4 * u2));
    const W = Math.max(.2, Math.min(1, f.width * (.88 + .24 * u1))), code = n => n + Math.floor(e * 31) / 32 + u3 * .99 / 32;
    if (f.form === 1) { // a filament lies across three field cells, as in the light it takes
      // Every filament has its own length, from a short chain of cells to a long strand (cells keep one size).
      const cells = Math.max(3, Math.round((4 + 11 * u1 * u1 + 2 * u3) * (.45 + .55 * scale))), h = .45, A = 1.2 * cells;
      r.push(x, y, heading + (u2 - .5) * .35, A * h, h, MOD.FILAMENT, leaf[0], leaf[1], leaf[2], .95, ph, cells + Math.min(.99, e));
      return;
    }
    if (f.form === 3) { // kelp: three to five long ruffled fronds from a holdfast, floats at their base, streaming with the current
      const fronds = 3 + Math.floor(u1 * 3), L = R * (2.6 + 1.2 * scale) * (.85 + .3 * u2), stipe = hsl(.1, .35, .22 + .08 * e);
      for (let i = 0; i < fronds; i++) {
        const a = heading + (i - (fronds - 1) / 2) * (.38 + .2 * u3) + Math.sin(time * .35 + ph + i) * .08, l = L * (.8 + .4 * hash(id, 10 + i));
        r.push(x + Math.cos(a) * l / 2, y + Math.sin(a) * l / 2, a, l / 2, R * (.8 + .3 * hash(id, 60 + i)), MOD.FROND, leaf[0], leaf[1], leaf[2], .95, ph + i * 1.7, 10 + (hash(id, 20 + i) - .5) * 5, ...deco);
        if (fine) r.push(x + Math.cos(a) * R * .55, y + Math.sin(a) * R * .55, 0, R * .17, R * .17, MOD.FAT, ...leaf.map(v => Math.min(1, v * 1.5)), .9); // a gas float
      }
      r.push(x, y, 0, R * .3, R * .3, MOD.BULB, stipe[0], stipe[1], stipe[2], 1);
      return;
    }
    if (f.form === 4) { // runner: a creeping stolon across five cells with tufts of feathery leaflets at its nodes
      const stem = hsl(.2 + body.hue * .05, .4, .24 + .1 * e), half = 9.5 * (.7 + .3 * scale), nodes = 5, ch = Math.cos(heading), sh = Math.sin(heading);
      const at = t => { const along = t * half, side = Math.sin(t * 2.4 + u1 * 6) * 1.6 * (.5 + u2); return [x + along * ch - side * sh, y + along * sh + side * ch]; };
      for (let i = 0; i < 8; i++) {
        const [ax, ay] = at(-1 + i / 4), [bx, by] = at(-1 + (i + 1) / 4), a = Math.atan2(by - ay, bx - ax), l = Math.hypot(bx - ax, by - ay);
        r.push((ax + bx) / 2, (ay + by) / 2, a, l / 2 * 1.05, .16, MOD.STEM, stem[0], stem[1], stem[2], 1, ph + i);
      }
      for (let i = 0; i < nodes; i++) {
        const [nx, ny] = at(-.9 + 1.8 * i / (nodes - 1)), rr = Ro * (.42 + .16 * hash(id, 30 + i));
        r.push(nx, ny, spin + i * 1.3, rr, rr, MOD.ROSETTE, leaf[0], leaf[1], leaf[2], Math.max(.2, W * .7), 7 + .45, code(6), ...deco);
      }
      return;
    }
    if (f.form === 5) { // floating colony: a slowly turning sphere with daughter colonies, bobbing in the water
      const bob = Math.sin(time * .6 + ph) * .25, Rc = Ro * 1.1 * (.9 + .2 * u1);
      r.push(x, y + bob, 0, Rc * 1.5, Rc * 1.5, MOD.GLOW, leaf[0], leaf[1], leaf[2], .12 + .1 * e);
      r.push(x, y + bob, 0, Rc, Rc, MOD.COLONY, leaf[0], leaf[1], leaf[2], .95, ph, 2 + Math.floor(u2 * 3));
      return;
    }
    if (f.form === 6) { // diatom: a glass shell; narrow-leaved lineages are boat-shaped, broad ones discs
      const pennate = (body.leaf ?? .5) < .5, Rd = Ro * .72 * (.92 + .16 * u1); // small: a single cell in its shell
      r.push(x, y, heading + u2 * 6.28 * (pennate ? .1 : 1), pennate ? Rd * 1.6 : Rd, pennate ? Rd * .62 : Rd, MOD.DIATOM, leaf[0], leaf[1], leaf[2], .95, ph,
        (pennate ? 14 : 16) + Math.floor(u3 * 10) + (pennate ? .5 : 0));
      return;
    }
    if (f.form === 2 && fine) { // a bush: three branches fork into six twigs, each crowned by a small rosette
      const stem = hsl(.16 + body.hue * .06, .35, .26 + .1 * e);
      for (let i = 0; i < 3; i++) {
        const sw = Math.sin(time * .4 + ph + i) * .05, a = heading + i * 2.094 + .5 * (hash(id, 40 + i) - .5) + .35 * Math.sin(ph * 2 + i) + sw, L = R * (1.05 + .3 * hash(id, 50 + i));
        const bx = x + Math.cos(a) * L, by = y + Math.sin(a) * L;
        r.push(x + Math.cos(a) * L / 2, y + Math.sin(a) * L / 2, a, L / 2, .2, MOD.STEM, stem[0], stem[1], stem[2], 1, ph + i);
        for (const da of [-.55, .5]) {
          const b = a + da * (.8 + .4 * u1) + sw, l = L * .62, tx = bx + Math.cos(b) * l, ty = by + Math.sin(b) * l;
          r.push(bx + Math.cos(b) * l / 2, by + Math.sin(b) * l / 2, b, l / 2, .15, MOD.STEM, stem[0], stem[1], stem[2], 1, ph + i + da);
          r.push(tx, ty, spin + i + da, Ro * .45, Ro * .45, MOD.ROSETTE, leaf[0], leaf[1], leaf[2], W, edge, code(f.n), ...deco);
        }
      }
      if (f.spine > 0 || f.armor > 0) r.push(x, y, 0, Ro * .9, Ro * .9, MOD.SPINES, .84, .86, .78, .9, spin, f.n);
      r.push(x, y, spin, Ro * .45, Ro * .45, MOD.ROSETTE, leaf[0], leaf[1], leaf[2], W, edge, code(f.n), ...deco);
      return;
    }
    if (f.spine > 0) { const Rs = Ro * (1.3 + .6 * Math.min(1, f.spine)); r.push(x, y, 0, Rs, Rs, MOD.SPINES, .88, .9, .84, .9, spin + Math.PI / f.n, f.n); } // long stinging needles
    if (f.armor > 0) { const Rs = Ro * (.9 + .45 * Math.min(1, f.armor)); r.push(x, y, 0, Rs, Rs, MOD.SPINES, .8, .82, .72, .95, spin + Math.PI / f.n, f.armor > .5 ? f.n * 2 : f.n); }
    r.push(x, y, spin, Ro * (f.form === 2 ? 1.5 : 1), Ro * (f.form === 2 ? 1.5 : 1), MOD.ROSETTE, leaf[0], leaf[1], leaf[2], W, edge, code(f.n + (f.inner ? 10 : 0)), ...deco);
    if (!fine) return;
    for (let i = 0; i < f.drops; i++) { const a = spin + i * 2.4, d = Ro * .25; r.push(x + Math.cos(a) * d, y + Math.sin(a) * d, 0, Ro * .07, Ro * .07, MOD.FAT, .95, .66, .24, .95); }
    if (f.glow > 0) { const c = hsl((.45 + body.hue * .3) % 1, .9, .62); for (let i = 0; i < f.n; i++) { const a = spin + i * 2 * Math.PI / f.n, d = Ro * .9; r.push(x + Math.cos(a) * d, y + Math.sin(a) * d, 0, Ro * .06, Ro * .06, MOD.PHOTOPHORE, c[0], c[1], c[2], .75); } }
    return;
  }
  // An animal develops from its genes (see anatomy): bilateral, or radial with n rays; a chain of
  // segments repeats the whole cell, each following the one ahead along the path it swam. The segments
  // differ by place: the head has the mouth and eyes and no cilia (it is pulled along), the trunk rings
  // have the cilia, the last ring ends in a tail.
  const A = anatomy(body), k = body.seg || 1;
  if (k > 1) {
    // One body of k segments: the rings overlap like the plates of a worm, a soft sheath joins them,
    // the trunk rings taper towards the tail and carry no mouth or eyes (those are the head's).
    const hx0 = R * .58 * Math.sqrt(A.el), hy0 = R * .58 / Math.sqrt(A.el), gap = hx0 * (A.rays ? 1.7 : 1.2), links = chain(id, x, y, heading, gap, k, time);
    limitBend({ x, y, h: heading }, links, gap);
    const tone = hsl(body.hue, .68, .56), pts = [{ x, y, h: heading }, ...links];
    for (let i = k - 2; i >= 0; i--) {
      const a = pts[i], b = pts[i + 1], d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(a.y - b.y, a.x - b.x), w = 1 - .07 * (i + 1);
      r.push((a.x + b.x) / 2, (a.y + b.y) / 2, ang, d / 2 + hx0 * .35 * w, hy0 * (A.rays ? .8 : .68) * w, MOD.CORE, tone[0] * .9, tone[1] * .9, tone[2] * .9, .85, ph, 40 + Math.min(.99, energy), ...decoOf(body.sp));
      const s = links[i]; cell(r, body, A, s.x, s.y, s.h, scale * (1 - .07 * (i + 1)), energy, glow, flags, time, zoom, ph, i === k - 2 ? 'tail' : 'trunk');
    }
  }
  cell(r, body, A, x, y, heading, scale, energy, glow, flags, time, zoom, ph, k > 1 ? 'head' : 'single');
}
function cell(r, body, { el, tp, parts, rays, tent }, x, y, heading, scale, energy, glow, flags, time, zoom, ph, role) {
  const R = radius(body, scale), fine = zoom * R > 6, base = R * .58;
  const hx = base * Math.sqrt(el), hy = base / Math.sqrt(el), ch = Math.cos(heading), sh = Math.sin(heading);
  const at = (phi, k) => { const bx = hx * k * Math.cos(phi), by = hy * k * Math.sin(phi); return [x + bx * ch - by * sh, y + bx * sh + by * ch]; };
  const tone = hsl(body.hue, .68, .56), glowTone = hsl(body.hue, .8, .72), shape = rays ? 100 + rays : 40 + Math.round(tp * 40);
  if (fine) for (const m of parts) { // appendages, under the body: tentacles trail, spines radiate
    const s = m.s * scale;
    if (m.t === TENTACLE) { // every tentacle is as long as the body's reach in the world
      const L = .35 * R + TENTACLE_REACH * tent * scale, out = heading + m.a, back = heading + Math.PI;
      const dir = out + Math.atan2(Math.sin(back - out), Math.cos(back - out)) * (rays ? .3 : .4), [bx, by] = at(m.a, .85);
      r.push(bx + Math.cos(dir) * L / 2, by + Math.sin(dir) * L / 2, dir, L / 2, .35 + .35 * s, MOD.TENTACLE, glowTone[0], glowTone[1], glowTone[2], .85, ph + m.a * 3);
    } else if (m.t === SPINE) { // glassy needles; a big spine grows as a fan of three
      for (const [da, k] of s > .35 ? [[0, 1], [-.22, .7], [.22, .7]] : [[0, 1]]) {
        const L = (.25 * R + .6 + 1.5 * s) * k, dir = heading + m.a + da, [bx, by] = at(m.a + da, .9);
        r.push(bx + Math.cos(dir) * L / 2, by + Math.sin(dir) * L / 2, dir, L / 2, .1 + .05 * s, MOD.THORN, .86, .9, .84, .9);
      }
    }
  }
  if (role === 'tail' && fine) { // the last ring trails a slender, waving tail
    const L = hx * 2.6, bx = x - Math.cos(heading) * (hx * .85 + L / 2), by = y - Math.sin(heading) * (hx * .85 + L / 2);
    r.push(bx, by, heading + Math.PI, L / 2, hy * .5, MOD.FLAGELLUM, glowTone[0], glowTone[1], glowTone[2], .9, ph * 2);
  }
  if (fine && role !== 'head') for (const m of parts) if (m.t === MOD.FLAGELLUM) // a band of beating cilia on the cell wall (not on the head)
    r.push(x, y, heading, hx, hy, MOD.CILIA, glowTone[0], glowTone[1], glowTone[2], .9, m.a, shape + Math.min(1.5, (rays ? .15 : .3) + .55 * m.s * scale) / 3.2);
  if (fine) for (const m of parts) { // organelles inside the cell, seen through the membrane
    const s = Math.min(m.s * scale, hy * .9);
    if (m.t === MOD.PHOTO) { const [px, py] = at(m.a, .42), c = pigmentColor(body.pig || 0, .8); r.push(px, py, heading + m.a, s * .4, s * .27, MOD.FAT, c[0], c[1], c[2], .9); }
    else if (m.t === MOD.FAT) { const [px, py] = at(m.a, .36); r.push(px, py, 0, s * .38, s * .38, MOD.FAT, .98, .64, .2, .95); }
  }
  let [cr, cg, cb] = tone;
  if (flags & 1) { cr = Math.min(1.4, cr + .7); cg *= .5; cb *= .5; }     // just bitten
  if (flags & 2) { cg = Math.min(1, cg + .2); cb *= .45; }                // infected
  r.push(x, y, heading, hx, hy, MOD.CORE, cr, cg, cb, 1, ph, shape + Math.min(.99, energy), ...decoOf(body.sp));
  if (!fine && !parts.some(m => m.t === MOD.PHOTOPHORE)) return;
  const shell = hsl((body.hue + .55) % 1, .16, .55);
  for (const m of parts) {
    const s = m.s * scale, th = heading + m.a;
    if (!fine && m.t !== MOD.PHOTOPHORE) continue;
    if (m.t === MOD.ARMOR) r.push(x, y, heading, hx, hy, MOD.ARMOR, shell[0], shell[1], shell[2], .95, m.a, shape + Math.min(1.5, (rays ? .2 : .35) + .6 * s) / 3.2);
    else if (m.t === MOD.MOUTH) { if (role === 'trunk' || role === 'tail') continue; const [px, py] = at(m.a, rays ? .3 : .9); r.push(px, py, th, s * .5, s * .46, MOD.MOUTH, .78, .16, .22, 1); } // radial: lips round a central mouth
    else if (m.t === MOD.EYE) { if (role === 'trunk' || role === 'tail') continue; const [px, py] = at(m.a, rays ? .8 : .66), sz = Math.min(s * .36, hy * .45); r.push(px, py, th, sz, sz, MOD.EYE, .95, .35, .2, 1); }
    else if (m.t === MOD.PHOTOPHORE) {
      const [px, py] = at(m.a, .8), c = hsl((.5 + body.hue * .3) % 1, .95, .6);
      r.push(px, py, th, s * .36, s * .36, MOD.PHOTOPHORE, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, .5 + .5 * glow);
      if (glow > .05) halos.push([px, py, s * 4 * (.6 + glow), c, glow]);
    }
  }
}
// The path a segmented animal swam, kept per creature; segment i sits i gaps back along it.
const trails = new Map(); let sweptAt = 0;
function chain(id, x, y, heading, gap, k, time) {
  let t = trails.get(id);
  if (!t || Math.hypot(x - t.xs[t.xs.length - 1], y - t.ys[t.ys.length - 1]) > 30) trails.set(id, t = { xs: [x], ys: [y], seen: time }); // new, or wrapped round the world
  const n = t.xs.length;
  if (Math.hypot(x - t.xs[n - 1], y - t.ys[n - 1]) > gap * .2) { t.xs.push(x); t.ys.push(y); if (t.xs.length > 96) { t.xs.shift(); t.ys.shift(); } }
  t.seen = time;
  if (time - sweptAt > 10) { sweptAt = time; for (const [key, v] of trails) if (time - v.seen > 10) trails.delete(key); }
  const out = []; let px = x, py = y, j = t.xs.length - 1, dx = -Math.cos(heading), dy = -Math.sin(heading);
  for (let i = 1; i < k; i++) {
    const ax = px, ay = py; let rem = gap;
    while (rem > 1e-6) {
      if (j < 0) { px += dx * rem; py += dy * rem; break; } // beyond the remembered path: straight on
      const qx = t.xs[j], qy = t.ys[j], d = Math.hypot(qx - px, qy - py);
      if (d < 1e-6) { j--; continue; }
      dx = (qx - px) / d; dy = (qy - py) / d;
      if (d >= rem) { px += dx * rem; py += dy * rem; break; }
      px = qx; py = qy; rem -= d; j--;
    }
    out.push({ x: px, y: py, h: Math.atan2(ay - py, ax - px) });
  }
  return out;
}
// A body of segments bends only so far: each segment may turn at most ~30° from the one before it,
// so a head that swings round drags the neck with it instead of snapping the body at a right angle.
const MAX_BEND = .52, wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
function limitBend(head, links, gap) {
  let prev = head;
  for (const l of links) {
    const behind = prev.h + Math.PI, d = wrapA(Math.atan2(l.y - prev.y, l.x - prev.x) - behind), a = behind + Math.max(-MAX_BEND, Math.min(MAX_BEND, d));
    l.x = prev.x + Math.cos(a) * gap; l.y = prev.y + Math.sin(a) * gap; l.h = a + Math.PI; // facing forward, along the link
    prev = l;
  }
}
// Development: the genome lists organs with an angle and sets the body plan.
// A bilateral body is mirror-symmetric: an organ off the axis grows as a pair with half the
// area each, one on the axis stays single. A radial body with n rays repeats every organ n
// times round its centre, each copy 1/n of the area. Physics depends on an organ's angle only
// through its cosine (bilateral) or not at all (radial), so the drawing stays true to what the
// organs do. The length of a bilateral body is its own gene; the front narrows into a snout.
const TENTACLE_REACH = 2.2; // as in the server's physics
export function anatomy(body) {
  if (body.anat) return body.anat;
  const rays = body.sym > 0 ? body.sym : 0;
  let mass = .25, push = 0, fat = 0, tent = 0; const parts = [];
  for (const m of body.modules) {
    mass += m.s;
    if (m.t === MOD.FLAGELLUM) push += m.s * (.25 + .375 * (1 - Math.cos(m.a)));
    else if (m.t === MOD.FAT) fat += m.s;
    else if (m.t === TENTACLE) tent += m.s;
    if (rays) { const s = m.s / Math.sqrt(rays); for (let k = 0; k < rays; k++) parts.push({ t: m.t, s, a: m.a + k * 2 * Math.PI / rays }); continue; }
    const a = Math.atan2(Math.sin(m.a), Math.cos(m.a));
    if (Math.abs(Math.sin(a)) < .2) parts.push({ t: m.t, s: m.s, a: Math.abs(a) < 1.57 ? 0 : Math.PI });
    else { const s = m.s * Math.SQRT1_2; parts.push({ t: m.t, s, a: Math.abs(a) }, { t: m.t, s, a: -Math.abs(a) }); }
  }
  const el = rays ? 1 : Math.max(.7, Math.min(2.4, body.elong ?? 1.3));
  const tp = rays ? 0 : Math.max(.05, Math.min(.3, .1 + .5 * push / mass - .3 * fat / mass));
  return body.anat = { el, tp, parts, rays, tent };
}
// A plant does not move, so where its organs sit has no effect in the world; it grows by a
// rule instead: a radially symmetric rosette. The number of leaves and their shape are
// species traits (from the neutral colour genes); a second, younger whorl appears when the
// plant carries much chloroplast; armour grows as a ring of thorns, spines as long needles, fat as amber droplets
// at the heart, light organs at the leaf tips.
function flora(body) {
  if (body.flora) return body.flora;
  let photo = 0, armor = 0, fat = 0, glow = 0, leaves = 0, spine = 0;
  for (const m of body.modules) {
    if (m.t === MOD.PHOTO) { photo += m.s; leaves++; } else if (m.t === MOD.ARMOR) armor += m.s;
    else if (m.t === MOD.FAT) fat += m.s; else if (m.t === MOD.PHOTOPHORE) glow += m.s; else if (m.t === SPINE) spine += m.s;
  }
  // Leaf count and the edge of the leaves (smooth, lobed or feathery) come from the neutral colour
  // genes, so they mark kinship; the width of the leaves is a gene with an effect (see genome).
  const h = Math.floor(body.hue * 997), n = 5 + h % 4, leafGene = body.leaf ?? .5;
  const lobes = [0, 0, 3, 5, 8][Math.floor(body.hue * 53) % 5], depth = lobes ? .2 + .35 * ((body.hue * 131) % 1) : 0;
  return body.flora = { n, lobes, depth, form: body.form || 0, cells: Math.max(5, Math.min(10, 4 + Math.round(photo * 4))), inner: photo > .9 || leaves > 2,
    width: Math.max(.22, Math.min(1, (.3 + .85 * leafGene) * Math.min(1, 6.5 / n))),
    spin: body.modules[0]?.a || 0, armor, glow, spine, drops: fat > 0 ? Math.min(5, 1 + Math.round(fat * 4)) : 0 };
}
