import { TEXT } from './i18n.js';
import { Renderer, MOD } from './render.js';
import { Sound } from './sound.js';
import { Timelapse } from './timelapse.js';
import { TreeOfLife } from './tree.js';
import { Museum, portraitMaker } from './museum.js';
import { Lifecycle, faded } from './life.js';
import { drawBody as drawBodyOf, radius, halos, looks } from './bodies.js';

// ---------- language ----------
let lang = (() => { try { return new URLSearchParams(location.search).get('lang') || localStorage.getItem('epochs-lang') || 'en'; } catch { return 'en'; } })();
if (!TEXT[lang]) lang = 'en';
const T = () => TEXT[lang];

// Deterministic pseudo-Latin names until the chronicler names species.
const GENUS = ['Phyt', 'Stom', 'Flagell', 'Thorac', 'Ocul', 'Lumin', 'Adip'], SUFFIX = ['ella', 'ops', 'ites', 'ina', 'aria', 'oides', 'ura', 'astrum'];
const EPITHET = ['velox', 'lenta', 'viridis', 'rubra', 'parva', 'magna', 'noctis', 'lucens', 'vorax', 'mitis', 'errans', 'fidelis', 'obscura', 'ferox', 'tenuis', 'aurea'];
const aiNames = new Map(), stories = new Map(); // names and stories from the chronicler, kept for the visit
function speciesName(s) {
  if (!s) return '—';
  const ai = aiNames.get(s.id); if (ai) return ai.latin;
  const count = new Array(7).fill(0); for (const m of s.modules || []) count[m]++;
  const dom = count.indexOf(Math.max(...count));
  return `${GENUS[dom]}${SUFFIX[s.id % SUFFIX.length]} ${EPITHET[(s.id * 7 + 3) % EPITHET.length]} · ${s.id}`;
}

// ---------- environment (the same formulas as the server) ----------
const DAY = 900, YEAR = 86400, CLIMATE = [11, 17, 29].map(d => d * 86400), AMP = [.17, .13, .11], TAU = Math.PI * 2;
function environment(t, s) {
  let climate = 1; for (let i = 0; i < 3; i++) climate += AMP[i] * Math.sin(TAU * t / CLIMATE[i] + (s.climatePhases?.[i] || 0));
  // Weather, as on the server: a storm darkens and stirs the water, a warm current is a bright band drifting across.
  const w = s.weather, W = s.world || 1024, k = w ? Math.max(0, Math.min(1, (t - w.at) / 1800, (w.until - t) / 1800)) : 0;
  const storm = w?.kind === 'storm' ? [k, Math.cos(w.dir), Math.sin(w.dir)] : null;
  const band = w?.kind === 'warm_current' ? [(((w.x0 + (t - w.at) / (w.until - w.at) * W) / W) % 1 + 1) % 1, 80 / W, k] : null;
  return { world: W, dayFrac: (t / DAY) % 1, beltFrac: .5 + .16 * Math.sin(TAU * t / YEAR), storm, band, weather: w?.kind,
    globalLight: climate * (s.dust ?? 1) * (.85 + .15 * Math.cos(TAU * t / YEAR * 2)) * (storm ? 1 - .35 * k : 1), climate };
}

// ---------- state ----------
const state = { world: 1024, bodies: new Map(), plants: [], frames: [], summary: null, offset: null, connected: false, selected: null, follow: false };
const species = new Map(), named = new Map(); // living species, and every species seen this visit
const life = new Lifecycle();
// A newborn grows out of the nearest member of its species (a parent or close kin): animals bud
// next to it, plants' seeds drift a little further.
life.parentOf = (id, x, y, plant) => {
  const sp = state.bodies.get(id)?.sp, W = state.world, lim = plant ? 16 : 8; let best = null, bd = lim * lim;
  const near = (oid, ox, oy) => { if (oid === id || state.bodies.get(oid)?.sp !== sp) return; const d = wrapD(ox - x, W) ** 2 + wrapD(oy - y, W) ** 2; if (d < bd && d > .01) { bd = d; best = { x: ox, y: oy }; } };
  if (plant) for (const p of state.plants) near(p.id, p.x, p.y);
  else { const f = state.frames.at(-1); if (f) for (let i = 0; i < f.ids.length; i++) near(f.ids[i], f.x[i], f.y[i]); }
  return best;
};
const canvas = document.getElementById('ocean');
let renderer;
try { renderer = new Renderer(canvas); } catch (e) { document.body.classList.add('no-webgl'); console.error(e); }
const cam = { x: 512, y: 512, zoom: 13, placed: false };
globalThis.epochs = { cam, state, life, select: id => select(id), get renderer() { return renderer; } }; // for inspection in the console

function parseHeader(dv) { return { kind: dv.getUint8(0), world: dv.getUint16(2, true), tick: dv.getUint32(4, true), t: dv.getFloat64(8, true), count: dv.getUint32(16, true), dust: dv.getFloat32(20, true) }; }
function onBinary(buf) {
  const dv = new DataView(buf), h = parseHeader(dv), W = h.world; state.world = W;
  const now = performance.now() / 1000;
  if (h.kind === 1) { // actors
    const n = h.count, f = { t: h.t, ids: new Uint32Array(n), x: new Float32Array(n), y: new Float32Array(n), a: new Float32Array(n), s: new Float32Array(n), e: new Float32Array(n), g: new Float32Array(n), fl: new Uint8Array(n), index: new Map() };
    let o = 24;
    for (let i = 0; i < n; i++, o += 12) {
      f.ids[i] = dv.getUint32(o, true); f.x[i] = dv.getUint16(o + 4, true) / 65536 * W; f.y[i] = dv.getUint16(o + 6, true) / 65536 * W;
      f.a[i] = dv.getUint8(o + 8) / 256 * TAU; f.s[i] = dv.getUint8(o + 9) / 255; f.e[i] = dv.getUint8(o + 10) / 255;
      const packed = dv.getUint8(o + 11); f.g[i] = (packed >> 3) / 31; f.fl[i] = packed & 7;
      f.index.set(f.ids[i], i);
    }
    state.frames.push(f); if (state.frames.length > 4) state.frames.shift();
    const est = h.t - now; state.offset = state.offset === null ? est : state.offset * .9 + est * .1;
    state.actorFrames = (state.actorFrames || 0) + 1;
    if (!cam.placed && n) placeCamera(f);
    document.body.classList.add('ready');
  } else if (h.kind === 7 || h.kind === 2) { // plants, with the axis they grow along (2: without it)
    const list = [], step = h.kind === 7 ? 11 : 10; let o = 24;
    for (let i = 0; i < h.count; i++, o += step) list.push({ id: dv.getUint32(o, true), x: dv.getUint16(o + 4, true) / 65536 * W, y: dv.getUint16(o + 6, true) / 65536 * W, s: dv.getUint8(o + 8) / 255, e: dv.getUint8(o + 9) / 255, a: step === 11 ? dv.getUint8(o + 10) / 256 * TAU : 0 });
    state.plants = list;
  } else if (h.kind === 3) { state.fields = { bytes: new Uint8Array(buf.slice(24)), n: h.count }; renderer?.setFields(state.fields.bytes, h.count); } // kept: the first view looks for light
  else if ((h.kind >= 4 && h.kind <= 6) || h.kind === 8) { // bodies: species, colour, diet, plan (symmetry, length, segments, growth form, pigment, leaf) and organs
    let o = 24; const plan = h.kind >= 5, more = h.kind >= 6, most = h.kind === 8, ids = [];
    for (let i = 0; i < h.count; i++) {
      const id = dv.getUint32(o, true), sp = dv.getUint32(o + 4, true), hue = dv.getUint8(o + 8) / 255, diet = dv.getUint8(o + 9) / 255, acts = dv.getUint8(o + 10), n = dv.getUint8(o + 11);
      const sym = plan ? dv.getUint8(o + 12) : 0, elong = plan ? dv.getUint8(o + 13) / 255 * 2.5 : 1.3, seg = more ? dv.getUint8(o + 14) : 1, form = more ? dv.getUint8(o + 15) : 0;
      const pig = most ? dv.getUint8(o + 16) / 255 : 0, leaf = most ? dv.getUint8(o + 17) / 255 : .5;
      o += most ? 18 : more ? 16 : plan ? 14 : 12; const modules = [];
      for (let k = 0; k < n; k++, o += 3) modules.push({ t: dv.getUint8(o), s: dv.getUint8(o + 1) / 255 * 1.5, a: dv.getUint8(o + 2) / 256 * TAU });
      state.bodies.set(id, { sp, hue, diet, acts, modules, sym, elong, seg, form, pig, leaf }); ids.push(id);
    }
    life.announced(ids.filter(id => !requested.delete(id)), performance.now() / 1000); // after the first full set, these are births (not bodies we asked for)
    if (state.bodies.size > 30000) { const alive = new Set([...state.plants.map(p => p.id), ...(state.frames.at(-1)?.ids || [])]); for (const id of state.bodies.keys()) if (!alive.has(id)) state.bodies.delete(id); }
  }
}
function onSummary(s) {
  if (s.build) { if (state.build && state.build !== s.build) return location.reload(); state.build = s.build; } // the server runs newer code
  state.summary = s; species.clear(); for (const sp of s.species) { species.set(sp.id, sp); named.set(sp.id, sp); }
  for (const [id, n] of Object.entries(s.names || {})) { aiNames.set(Number(id), n); if (n.look) looks.set(Number(id), n.look); } // the artist's look of each species
  for (const st of s.stories || []) stories.set(st.id, st);
  if (s.paper && !$('#paper-panel').hidden && (!papers.list || papers.at === papers.list.length - 1)) renderPaper(); // not while leafing back
  updateHud();
}
// Start where the animals are densest, so the first seconds show life.
// The first view: the liveliest lit place in the ocean. Every square of about 64 units is scored
// by the animals actually swimming in it (two frames show who moves), its species and plants,
// weighted by its light now and four minutes ahead, since the day moves on. The camera then
// centres on the swimmers and frames about thirty creatures.
function placeCamera(f) {
  const prev = state.frames.at(-2); if (!prev) return; // wait for a second frame
  if ((!state.fields || !state.plants.length) && state.actorFrames < 8) return; // and for plants and depth, up to about five seconds
  const W = state.world, g = Math.max(8, Math.round(W / 64)), sq = W / g, cells = new Map(), s = state.summary || {};
  const at = (x, y) => { const k = Math.floor(x / sq) * g + Math.floor(y / sq); let c = cells.get(k); if (!c) cells.set(k, c = { k, swim: 0, still: 0, plants: 0, sp: new Set(), sx: 0, sy: 0 }); return c; };
  for (let i = 0; i < f.ids.length; i++) {
    const j = prev.index.get(f.ids[i]), c = at(f.x[i], f.y[i]), b = state.bodies.get(f.ids[i]);
    const speed = j === undefined ? 0 : Math.hypot(wrapD(f.x[i] - prev.x[j], W), wrapD(f.y[i] - prev.y[j], W)) / Math.max(.1, f.t - prev.t);
    if (speed > .4) { c.swim++; c.sx += f.x[i]; c.sy += f.y[i]; } else c.still++;
    if (b) c.sp.add(b.sp);
  }
  for (const p of state.plants) at(p.x, p.y).plants++;
  const fl = state.fields, light = (e, x, y) => {
    const day = Math.max(0, Math.min(1, .2 + .8 * Math.cos(TAU * (x / W - e.dayFrac)))), belt = .12 + .88 * ((1 + Math.cos(TAU * (y / W - e.beltFrac))) / 2) ** 1.5;
    const shallow = fl ? fl.bytes[fl.n * fl.n + Math.min(fl.n - 1, Math.floor(y / W * fl.n)) * fl.n + Math.min(fl.n - 1, Math.floor(x / W * fl.n))] / 255 : .5;
    return day * belt * (.3 + .7 * shallow) * e.globalLight;
  };
  const now = environment(f.t, s), soon = environment(f.t + 240, s);
  let best = null, top = -1;
  for (const c of cells.values()) {
    const x = (Math.floor(c.k / g) + .5) * sq, y = (c.k % g + .5) * sq, lit = (light(now, x, y) + light(soon, x, y)) / 2;
    const score = (c.swim + .25 * c.still + .1 * c.plants + 3 * c.sp.size) * (.05 + lit) ** 1.5;
    if (score > top) { top = score; best = { c, x, y }; }
  }
  if (!best) return;
  const c = best.c, n = c.swim + c.still + c.plants, rect = canvas.getBoundingClientRect();
  cam.x = c.swim ? c.sx / c.swim : best.x; cam.y = c.swim ? c.sy / c.swim : best.y;
  cam.zoom = Math.max(6, Math.min(18, Math.sqrt(rect.width * rect.height * Math.max(1, n) / (sq * sq) / 30))); // about thirty in view
  cam.placed = true;
}

// ---------- connection ----------
let socket, retry = 1000;
function connect() {
  const url = new URL('ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
  socket.onopen = () => { life.reset(); state.connected = true; retry = 1000; document.body.classList.add('live'); $('#live-label').textContent = T().live; sentView = null; reportView(); };
  socket.onmessage = e => { if (typeof e.data === 'string') onSummary(JSON.parse(e.data)); else onBinary(e.data); };
  socket.onclose = () => { state.connected = false; document.body.classList.remove('live'); $('#live-label').textContent = T().connecting; setTimeout(connect, retry); retry = Math.min(15000, retry * 1.6); };
}
connect();
// Tell the server where the camera looks, so it sends this region in detail.
let sentView = null, viewAt = 0;
function reportView(now = performance.now()) {
  if (!socket || socket.readyState !== 1 || !cam.placed) return;
  const r = canvas.getBoundingClientRect(), hw = r.width / 2 / cam.zoom, hh = r.height / 2 / cam.zoom;
  const v = sentView, W = state.world;
  const moved = !v || Math.abs(wrapD(cam.x - v.x, W)) > hw * .15 || Math.abs(wrapD(cam.y - v.y, W)) > hh * .15 || Math.abs(Math.log(hw / v.hw)) > .18;
  if (!moved || now - viewAt < 250) return;
  sentView = { x: cam.x, y: cam.y, hw, hh }; viewAt = now;
  socket.send(JSON.stringify({ type: 'view', ...sentView }));
}

// ---------- interpolation ----------
const wrapD = (d, W) => d > W / 2 ? d - W : d < -W / 2 ? d + W : d;
function interpolated(renderT) {
  const fr = state.frames; if (!fr.length) return null;
  let a = fr[0], b = fr[fr.length - 1];
  for (let i = 0; i < fr.length - 1; i++) if (fr[i].t <= renderT && fr[i + 1].t >= renderT) { a = fr[i]; b = fr[i + 1]; break; }
  if (renderT > b.t) a = b;
  const k = b.t > a.t ? Math.min(1, Math.max(0, (renderT - a.t) / (b.t - a.t))) : 1;
  return { a, b, k };
}

// Creatures in view without a body description (it was dropped to save memory, or missed) are asked
// for again, a few dozen at a time, at most once a second.
let askedAt = 0; const requested = new Set(); // asked-for bodies are old creatures, not births
function askMissing(now, movers) {
  if (now - askedAt < 1.2 || socket?.readyState !== 1) return;
  const ids = [];
  for (const m of movers) if (!state.bodies.has(m[0]) && ids.length < 50) ids.push(m[0]);
  for (const p of state.plants) if (!state.bodies.has(p.id) && ids.length < 50) ids.push(p.id);
  if (requested.size > 2000) requested.clear();
  if (ids.length) { askedAt = now; for (const id of ids) requested.add(id); socket.send(JSON.stringify({ type: 'need', ids })); }
}
// ---------- body drawing (see bodies.js) ----------
function drawShadow(r, id, x, y, scale) { // soft dark ground under every body, drawn before all bodies
  const body = state.bodies.get(id); if (!body) return;
  const R = radius(body, scale); r.push(x, y, 0, R * 1.6, R * 1.6, MOD.HALO, 0, 0, 0, body.acts ? .5 : .35);
}
function drawBody(r, id, x, y, heading, scale, energy, glow, flags, time) { drawBodyOf(r, state.bodies.get(id), id, x, y, heading, scale, energy, glow, flags, time, cam.zoom); }

// ---------- frame loop ----------
let last = performance.now(), lastDrawn = 0, lastInput = 0;
for (const type of ['pointerdown', 'pointermove', 'wheel']) addEventListener(type, e => { if (type !== 'pointermove' || e.buttons) lastInput = performance.now(); }, { passive: true });
function frame(nowMs) {
  requestAnimationFrame(frame);
  if (!renderer || document.hidden || !$('#tree').hidden || !$('#museum').hidden || !$('#timelapse').hidden) return; // the ocean is covered: save the device's effort
  // 30 frames per second while watching, 60 while the camera is being moved.
  if (nowMs - lastInput > 2000 && nowMs - lastDrawn < 31) return;
  lastDrawn = nowMs;
  const now = nowMs / 1000, dt = Math.min(.1, (nowMs - last) / 1000); last = nowMs;
  adapt(dt);
  const renderT = state.offset === null ? 0 : now + state.offset - .8; // a little behind the newest frame, to interpolate
  const env = environment(renderT, state.summary || {});
  env.world = state.world;
  const r = renderer; r.begin(); halos.length = 0;
  const W = state.world;
  const ip = interpolated(renderT); let selPos = null;
  const movers = [];
  if (ip) {
    const { a, b, k } = ip;
    for (let i = 0; i < b.ids.length; i++) {
      const id = b.ids[i], j = a.index.get(id);
      let x = b.x[i], y = b.y[i], h = b.a[i];
      if (j !== undefined) {
        x = a.x[j] + wrapD(b.x[i] - a.x[j], W) * k; y = a.y[j] + wrapD(b.y[i] - a.y[j], W) * k;
        h = a.a[j] + Math.atan2(Math.sin(b.a[i] - a.a[j]), Math.cos(b.a[i] - a.a[j])) * k;
      }
      movers.push([id, x, y, h, b.s[i], b.e[i], b.g[i], b.fl[i]]);
      if (id === state.selected) selPos = { x, y, e: b.e[i], s: b.s[i], fl: b.fl[i] };
    }
  }
  // Births grow out of the parent, sizes change smoothly, the dead fade (see life.js).
  const pv = state.plants.map(p => life.view(p.id, p.x, p.y, p.a, p.s, p.e, true, now, dt, W));
  const mv = movers.map(m => life.view(m[0], m[1], m[2], m[3], m[4], m[5], false, now, dt, W));
  state.plants.forEach((p, i) => { const v = pv[i]; drawShadow(faded(r, v.f), p.id, v.x, v.y, v.s); });
  movers.forEach((m, i) => { const v = mv[i]; drawShadow(faded(r, v.f), m[0], v.x, v.y, v.s); });
  state.plants.forEach((p, i) => { const v = pv[i]; drawBody(faded(r, v.f), p.id, v.x, v.y, p.a, v.s, p.e, 0, 0, now); });
  movers.forEach((m, i) => { const v = mv[i]; drawBody(faded(r, v.f), m[0], v.x, v.y, m[3], v.s, m[5], m[6], m[7], now); });
  life.drawGhosts(r, (rr, body, id, x, y, h, s, e, t, z) => drawBodyOf(rr, body, id, x, y, h, s, e, 0, 0, t, z), now, cam.zoom);
  askMissing(now, movers);
  { const hw = canvas.clientWidth / 2 / cam.zoom * .92, hh = canvas.clientHeight / 2 / cam.zoom * .92;
    life.end(now, (x, y) => Math.abs(wrapD(x - cam.x, W)) < hw && Math.abs(wrapD(y - cam.y, W)) < hh, state.bodies, !!ip); }
  if (sound.on && now - lastSound > .5) { lastSound = now; listen(movers, env); }
  caption(now, movers, env);
  for (const [x, y, rad, c, g] of halos) r.push(x, y, 0, rad, rad, MOD.GLOW, c[0], c[1], c[2], .55 * g);
  if (selPos) {
    r.push(selPos.x, selPos.y, 0, 4.5, 4.5, MOD.GLOW, .75, .95, 1, .18); // a soft marker around the followed creature
    if (state.follow) { cam.x += wrapD(selPos.x - cam.x, W) * Math.min(1, dt * 3); cam.y += wrapD(selPos.y - cam.y, W) * Math.min(1, dt * 3); }
    updateCard(selPos);
  } else if (state.selected && ip) { hideCard(); }
  cam.x = (cam.x % W + W) % W; cam.y = (cam.y % W + W) % W;
  reportView(nowMs);
  r.draw(cam, env, now);
}
requestAnimationFrame(frame);
// Keep about 40+ frames per second by lowering the internal resolution on slow devices.
let slowSum = 0, slowN = 0;
function adapt(dt) {
  if (!renderer || document.hidden || globalThis.epochs?.fixedQuality) return;
  slowSum += dt; slowN++;
  if (slowN < 90) return;
  const avg = slowSum / slowN; slowSum = slowN = 0;
  const q = renderer.quality ?? 1;
  const target = performance.now() - lastInput > 2000 ? 1 / 26 : 1 / 38; // frames are paced at 30 when idle
  if (avg > target) renderer.quality = Math.max(.5, q * .85);
  else if (avg < target * .7 && q < 1) renderer.quality = Math.min(1, q * 1.08);
}

// ---------- sound: what the camera sees ----------
const sound = new Sound(); let lastSound = 0;
function listen(movers, env) {
  const rect = canvas.getBoundingClientRect(), hw = rect.width / 2 / cam.zoom, hh = rect.height / 2 / cam.zoom, W = state.world;
  const voices = []; let predators = 0;
  for (const m of movers) {
    const dx = wrapD(m[1] - cam.x, W), dy = wrapD(m[2] - cam.y, W);
    if (Math.abs(dx) > hw || Math.abs(dy) > hh) continue;
    const body = state.bodies.get(m[0]); if (!body) continue;
    if (species.get(body.sp)?.role === 'predator') predators++;
    if (voices.length < 40) voices.push({ sp: body.sp, size: radius(body, m[4]), hue: body.hue, glow: m[6], pan: dx / hw });
  }
  const fx = (cam.x / W) % 1, fy = (cam.y / W) % 1;
  const light = Math.max(0, Math.min(1, .2 + .8 * Math.cos(TAU * (fx - env.dayFrac)))) * (.12 + .88 * ((1 + Math.cos(TAU * (fy - env.beltFrac))) / 2) ** 1.5) * env.globalLight;
  sound.update({ light, voices, predators, dark: (state.summary?.dust ?? 1) < .9 });
}

// ---------- camera input ----------
const pointers = new Map(); let dragged = 0, pinch = null;
canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); dragged = 0; if (pointers.size === 2) pinch = spread(); });
canvas.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId); if (!p) return;
  if (pointers.size === 1) { cam.x -= (e.clientX - p.x) / cam.zoom; cam.y += (e.clientY - p.y) / cam.zoom; dragged += Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y); if (dragged > 6) state.follow = false; }
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2 && pinch) { const s = spread(); zoomBy(s / pinch); pinch = s; dragged += 10; }
});
const up = e => { const was = pointers.has(e.pointerId); pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (was && pointers.size === 0 && dragged < 6) pick(e.clientX, e.clientY); };
canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); pinch = null; });
canvas.addEventListener('wheel', e => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * .0015), e.clientX, e.clientY); }, { passive: false });
function spread() { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; }
function zoomBy(f, sx, sy) {
  const rect = canvas.getBoundingClientRect(), before = sx === undefined ? null : screenToWorld(sx, sy);
  cam.zoom = Math.min(40, Math.max(Math.min(rect.width, rect.height) / state.world * .9, cam.zoom * f));
  if (before) { const after = screenToWorld(sx, sy); cam.x += before.x - after.x; cam.y += before.y - after.y; }
}
function screenToWorld(sx, sy) { const r = canvas.getBoundingClientRect(); return { x: cam.x + (sx - r.left - r.width / 2) / cam.zoom, y: cam.y - (sy - r.top - r.height / 2) / cam.zoom }; }
addEventListener('keydown', e => { if (e.target.closest?.('input, textarea')) return; if (e.key === '+' || e.key === '=') zoomBy(1.25); if (e.key === '-') zoomBy(.8); if (e.key === 'Escape') select(null); });

function pick(sx, sy) {
  const w = screenToWorld(sx, sy), W = state.world, f = state.frames.at(-1);
  let best = null, bd = (14 / cam.zoom) ** 2 + 4;
  if (f) for (let i = 0; i < f.ids.length; i++) { const d = wrapD(f.x[i] - w.x, W) ** 2 + wrapD(f.y[i] - w.y, W) ** 2; if (d < bd) { bd = d; best = f.ids[i]; } }
  if (!best) for (const p of state.plants) { const d = wrapD(p.x - w.x, W) ** 2 + wrapD(p.y - w.y, W) ** 2; if (d < bd) { bd = d; best = p.id; } }
  select(best, true);
}

// ---------- interface ----------
const $ = s => document.querySelector(s);
const fmt = n => Number(n || 0).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US');
const clock = t => { const h = Math.floor(t / 3600); return `${T().dayShort}${Math.floor(h / 24) + 1} ${String(h % 24).padStart(2, '0')}:${String(Math.floor(t % 3600 / 60)).padStart(2, '0')}`; };
const hueCss = h => `hsl(${Math.round(h * 360)}, 62%, 62%)`;

// Intro, observe mode, drawer
function enter() { document.body.classList.remove('intro-open'); try { sessionStorage.setItem('epochs-entered', '1'); } catch {} }
try { if (sessionStorage.getItem('epochs-entered')) document.body.classList.remove('intro-open'); } catch {}
$('#enter').addEventListener('click', enter);
canvas.addEventListener('pointerdown', () => { if (document.body.classList.contains('intro-open')) enter(); }, { capture: true });
$('#observe').addEventListener('click', () => {
  const on = document.body.classList.toggle('observing'); $('#observe').setAttribute('aria-pressed', on);
  if (on) { enter(); setGuide(false); }
});
function setGuide(open) {
  $('#guide').classList.toggle('open', open); $('#guide').inert = !open; $('#guide-open').setAttribute('aria-pressed', open);
  if (open) { enter(); document.body.classList.remove('observing'); $('#observe').setAttribute('aria-pressed', false); renderGuide(); }
}
$('#guide-open').addEventListener('click', () => setGuide(!$('#guide').classList.contains('open')));
$('#guide-close').addEventListener('click', () => setGuide(false));
let tab = 'life';
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => {
  tab = b.dataset.tab;
  for (const x of document.querySelectorAll('.tabs button')) { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); }
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== tab;
  renderGuide();
});

// Observer pseudonym: three indices into fixed word lists, shown in the viewer's language.
let who = (() => { try { const w = JSON.parse(localStorage.getItem('epochs-who')); if (Array.isArray(w) && w.length === 3) return w; } catch {} return null; })();
function newWho() { who = [Math.floor(Math.random() * 16), Math.floor(Math.random() * 16), 1 + Math.floor(Math.random() * 99)]; try { localStorage.setItem('epochs-who', JSON.stringify(who)); } catch {} }
if (!who) newWho();
const whoText = w => `${T().adjectives[w[0]]} ${T().nouns[w[1]]} ${w[2]}`;
const sameWho = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const claimed = new Set();
$('#observer-new').addEventListener('click', () => { newWho(); renderGuide(); });

// Creature card
// The card can shrink to a thin bar; the choice is kept for the visit.
let compact = (() => { try { return sessionStorage.getItem('epochs-compact') === '1'; } catch { return false; } })();
const narrow = () => innerWidth < 860;
function setCompact(on) {
  compact = on; try { sessionStorage.setItem('epochs-compact', on ? '1' : '0'); } catch {}
  $('#card').classList.toggle('compact', on);
  $('#card-collapse').setAttribute('aria-expanded', !on); $('#card-collapse').setAttribute('aria-label', on ? T().expand : T().collapse);
  document.body.classList.toggle('focus', on && !$('#card').hidden && narrow());
}
$('#card-collapse').addEventListener('click', () => setCompact(!compact));
$('#card-names').addEventListener('click', () => { if (compact) setCompact(false); });
// byUser: opened by a visitor's own tap or click. Only that can make them a species' first discoverer
// (not a script, a test or the console).
function select(id, byUser = false) {
  state.selected = id; state.byUser = byUser; state.follow = !!id && !!state.bodies.get(id)?.acts;
  if (!id) return hideCard();
  enter(); $('#card').hidden = false;
  setCompact(narrow() ? true : compact); // on a phone, following starts full-screen with a thin bar; tap it for details
  if (!state.bodies.get(id)?.acts) { const p = state.plants.find(p => p.id === id); if (p) updateCard({ x: p.x, y: p.y, e: p.e, s: p.s, fl: 0 }); }
}
function hideCard() { $('#card').hidden = true; state.selected = null; state.follow = false; document.body.classList.remove('focus'); }
function updateCard(pos) {
  const body = state.bodies.get(state.selected); if (!body) return;
  const sp = species.get(body.sp), t = T(), ai = aiNames.get(body.sp);
  $('#card-dot').style.background = hueCss(body.hue); $('#card-dot').style.color = hueCss(body.hue);
  $('#card-name').textContent = sp ? speciesName(sp) : `${t.speciesNo}${body.sp}`;
  $('#card-common').textContent = ai ? ai[lang] : '';
  $('#card-note').textContent = ai ? ai[lang + '_note'] : t.autoName;
  const disc = state.summary?.discoveries?.[body.sp], dEl = $('#card-discover');
  dEl.hidden = !disc; dEl.classList.toggle('mine', !!disc && sameWho(disc.who, who));
  if (disc) dEl.textContent = sameWho(disc.who, who) ? t.youDiscovered : t.discoveredBy.replace('{who}', whoText(disc.who));
  else if (state.byUser && sp?.established && !claimed.has(body.sp) && socket?.readyState === 1) { claimed.add(body.sp); socket.send(JSON.stringify({ type: 'discover', species: body.sp, who })); }
  $('#card-role').textContent = (sp?.role ? t.roles[sp.role] : t.roles.none) + (sp?.immigrant ? ' · ' + t.immigrantTag : '');
  const counts = new Map(); for (const m of body.modules) counts.set(m.t, (counts.get(m.t) || 0) + 1);
  const plan = body.acts ? t.plan(body.sym || 0, body.elong ?? 1.3, body.seg || 1) : t.flora(body.form || 0, body.pig || 0, body.leaf ?? .5);
  $('#card-body').textContent = (plan ? plan + ' · ' : '') + [...counts].map(([k, n]) => (n > 1 ? n + '× ' : '') + t.parts[k]).join(', ');
  $('#card-energy').style.width = $('#card-mini-energy').style.width = Math.round(pos.e * 100) + '%';
  $('#card-kin').textContent = sp ? fmt(sp.count) : '—';
  $('#card-state').textContent = [pos.s < 1 ? t.juvenile : '', pos.fl & 2 ? t.infected : ''].filter(Boolean).join(' · ');
  $('#card-follow-label').textContent = state.follow ? t.unfollow : t.follow;
  $('#card-follow').hidden = !body.acts;
}
$('#card-close').addEventListener('click', () => select(null));
$('#card-follow').addEventListener('click', () => { state.follow = !state.follow; if (state.follow && narrow()) setCompact(true); });

// Guide: life, chronicle, rules
function renderGuide() {
  const s = state.summary, t = T(); if (!s || !$('#guide').classList.contains('open')) return;
  const r = s.roles || {};
  $('#g-animals').textContent = fmt((r.grazer || 0) + (r.predator || 0) + (r.scavenger || 0));
  $('#g-grazers').textContent = fmt(r.grazer); $('#g-predators').textContent = fmt(r.predator); $('#g-scavengers').textContent = fmt(r.scavenger); $('#g-plants').textContent = fmt(r.producer);
  const tr = s.trend || [];
  if (tr.length > 1) {
    const max = Math.max(1, ...tr.map(x => x[2] + x[3] + x[4])), X = i => (i / (tr.length - 1) * 300).toFixed(1), Y = v => (66 - v / max * 60).toFixed(1);
    const line = k => tr.map((x, i) => `${i ? 'L' : 'M'}${X(i)},${Y(x[k])}`).join('');
    const area = `M0,66 ${tr.map((x, i) => `L${X(i)},${Y(x[2] + x[3] + x[4])}`).join('')} L300,66Z`;
    $('#trend').innerHTML = `<defs><linearGradient id="tf" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6aa9f0" stop-opacity=".22"/><stop offset="100%" stop-color="#6aa9f0" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#tf)"/><path d="${line(2)}" fill="none" stroke="#6aa9f0" stroke-width="1.5" vector-effect="non-scaling-stroke"/><path d="${line(3)}" fill="none" stroke="#ff7a4d" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
  }
  const list = $('#species-list'); list.textContent = '';
  const living = (s.species || []).filter(x => x.established).sort((a, b) => b.count - a.count);
  $('#g-species-count').textContent = fmt(s.living);
  for (const sp of living.slice(0, 14)) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'species';
    const dot = document.createElement('span'); dot.className = 'lineage-dot'; dot.style.background = hueCss(sp.hue); dot.style.color = hueCss(sp.hue);
    const txt = document.createElement('span'), name = document.createElement('span'), role = document.createElement('span'), num = document.createElement('span');
    const ai = aiNames.get(sp.id);
    name.className = 'species-name'; name.textContent = speciesName(sp);
    role.className = 'species-role'; role.textContent = [ai?.[lang], t.roles[sp.role || 'none']].filter(Boolean).join(' · ');
    num.className = 'species-number'; num.textContent = fmt(sp.count);
    txt.append(name, role); b.append(dot, txt, num);
    b.addEventListener('click', () => findSpecies(sp.id));
    list.append(b);
  }
  // chronicle
  const p = s.paper; $('#paper-teaser').hidden = !p; if (p) $('#paper-teaser-head').textContent = p[lang].headline;
  const sl = $('#story-list'); sl.textContent = '';
  const st = [...(s.stories || [])].reverse().slice(0, 8);
  if (!st.length) { const e = document.createElement('p'); e.className = 'empty'; e.textContent = t.noStories; sl.append(e); }
  for (const x of st) { const a = document.createElement('article'); a.className = 'story'; const tm = document.createElement('time'), h = document.createElement('h3'), b = document.createElement('p'); tm.textContent = clock(x.t); h.textContent = x[lang].title; b.textContent = x[lang].body; a.append(tm, h, b); sl.append(a); }
  const el = $('#event-list'); el.textContent = '';
  for (const e of eventsToShow(s).slice(0, 10)) { const li = document.createElement('li'), tm = document.createElement('time'), sp = document.createElement('span'); tm.textContent = clock(e.t); sp.textContent = eventText(e); li.append(tm, sp); el.append(li); }
  // epoch and climate
  const en = s.epochNames?.[s.epoch];
  $('#epoch-box').hidden = !en;
  if (en) { $('#epoch-eyebrow').textContent = t.epochEyebrow.replace('{n}', roman(s.epoch)); $('#epoch-name').textContent = en[lang].name; $('#epoch-note').textContent = en[lang].note; }
  drawClimate(s);
  // rules
  $('#rules-copy').innerHTML = t.rules;
  $('#observer-name').textContent = whoText(who);
  const mine = Object.values(s.discoveries || {}).filter(d => sameWho(d.who, who)).length;
  $('#observer-finds').textContent = t.finds.replace('{n}', mine);
  const c = s.chronicler; $('#chronicler-status').textContent = c?.enabled ? t.chronOn.replace('{spent}', (c.spentToday || 0).toFixed(3)).replace('{limit}', c.limit.toFixed(2)) : t.chronOff;
}
const roman = n => ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'][n - 1] || String(n);
// Climate is deterministic: the browser forecasts it with the server's own formula.
const COLD_START = .72, COLD_END = .78;
function climateAt(t, s) { return environment(t, s).climate; }
// The same hysteresis as the server: a cold spell starts below COLD_START and ends above COLD_END.
function coldAt(t, s) {
  const c = climateAt(t, s); if (c < COLD_START) return true; if (c >= COLD_END) return false;
  for (let b = t - 1800; b > t - 5 * 86400; b -= 1800) { const x = climateAt(b, s); if (x < COLD_START) return true; if (x >= COLD_END) return false; }
  return false;
}
function forecast(s) {
  const now = s.t, step = 1800, horizon = now + 30 * 86400;
  let t = now;
  if (coldAt(now, s)) { while (t < horizon && climateAt(t, s) < COLD_END) t += step; return { now: true, end: t - now }; }
  while (t < horizon && climateAt(t, s) >= COLD_START) t += step;
  if (t >= horizon) return null;
  let e = t; while (e < t + 30 * 86400 && climateAt(e, s) < COLD_END) e += step;
  return { now: false, start: t - now, length: e - t };
}
function span(sec) { const t = T(), d = Math.floor(sec / 86400), h = Math.round(sec % 86400 / 3600); return d ? `${d} ${t.dayShort} ${h} ${t.h}` : `${h || 1} ${t.h}`; }
function drawClimate(s) {
  const pts = [], from = s.t - 2 * 86400, to = s.t + 14 * 86400, X = t => ((t - from) / (to - from) * 300).toFixed(1), Y = c => (56 - (c - .55) / .9 * 52).toFixed(1);
  for (let t = from; t <= to; t += 3 * 3600) pts.push(`${pts.length ? 'L' : 'M'}${X(t)},${Y(climateAt(t, s))}`);
  $('#climate-chart').innerHTML = `<line x1="0" x2="300" y1="${Y(COLD_START)}" y2="${Y(COLD_START)}" stroke="#6aa9f0" stroke-opacity=".45" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
    <path d="${pts.join('')}" fill="none" stroke="#e7c27c" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <line x1="${X(s.t)}" x2="${X(s.t)}" y1="0" y2="60" stroke="#a9e9d2" stroke-opacity=".7" vector-effect="non-scaling-stroke"/>`;
  const f = forecast(s), t = T();
  $('#forecast').textContent = !f ? t.noCold : f.now ? t.coldNow.replace('{d}', span(f.end)) : t.coldIn.replace('{d}', span(f.start)).replace('{l}', span(f.length));
  $('#climate-now').textContent = `${Math.round(climateAt(s.t, s) * 100)}%`;
}
function eventsToShow(s) { return (s.events || []).filter(e => T().ev[e.type] && (e.type !== 'speciation' || named.has(e.species))).reverse(); }
function eventText(e) {
  const story = stories.get(`${e.type}-${e.seq}`); if (story) return story[lang].title;
  const sp = named.get(e.species); return T().ev[e.type].replace('{plan}', T().evPlan[e.plan] || '').replace('{sp}', sp ? speciesName(sp) : T().speciesNo + (e.species ?? ''));
}
// Jump to the largest group of a species and follow one member.
function findSpecies(id) {
  const f = state.frames.at(-1); if (!f) return;
  let best = null; for (let i = 0; i < f.ids.length; i++) { const b = state.bodies.get(f.ids[i]); if (b?.sp === id) { best = f.ids[i]; break; } }
  if (!best) { const p = state.plants.find(p => state.bodies.get(p.id)?.sp === id); if (p) { cam.x = p.x; cam.y = p.y; cam.zoom = Math.max(cam.zoom, 12); select(p.id, true); } return; }
  const i = f.index.get(best); cam.x = f.x[i]; cam.y = f.y[i]; cam.zoom = Math.max(cam.zoom, 12); select(best, true);
  if (innerWidth < 860) setGuide(false);
}

// Paper, about, time-lapse, sound, language
const lapse = new Timelapse($('#timelapse'), T);
const treeView = new TreeOfLife($('#tree'), { T, lang: () => lang, who: () => who, whoText: w => whoText(w), sameWho, clock: t => clock(t),
  nameOf: (s, ai) => ai ? ai.latin : speciesName(s) });
$('#tree-open').addEventListener('click', () => treeView.open()); $('#tree-open-2').addEventListener('click', () => treeView.open());
const museumView = new Museum($('#museum'), { T, clock: t => clock(t), nameOf: (s, ai) => ai ? ai.latin : speciesName(s) });
$('#museum-open').addEventListener('click', () => museumView.open());

// The day's discoveries: firsts, new species, great extinctions and catastrophes of the last
// world day, one at a time on the main screen, with the species' portrait. A tap goes to it.
const news = { items: [], at: 0, shown: -1, portraits: null, museum: null, fetched: 0 };
async function loadNews() {
  try {
    const [n, m] = await Promise.all([fetch('api/news', { cache: 'no-store' }).then(r => r.json()), news.museum && Date.now() - news.fetched < 600000 ? news.museum : fetch('api/museum', { cache: 'no-store' }).then(r => r.json())]);
    news.items = n.items || []; news.museum = m; news.fetched = Date.now();
    news.byId = new Map((m.species || []).map(s => [s.id, s]));
    for (const [id, x] of Object.entries(m.names || {})) if (x.look) looks.set(Number(id), x.look);
  } catch {}
}
function newsText(it) {
  const t = T(), name = it.name ? it.name.latin : it.species ? t.speciesNo + it.species : '', common = it.name?.[lang] || '';
  if (it.type === 'first_plan') return [t.evPlan[it.plan] || '', name ? `${name}${common ? ' — ' + common : ''}` : ''];
  if (it.type === 'speciation') return [`${t.newsSpecies}: ${name}`, common];
  if (it.type === 'immigration') return [`${t.newsImmigrant}: ${name}`, common];
  if (it.type === 'extinction') return [`${t.newsGone}: ${name}`, common];
  return [(t.ev[it.type] || '').replace('{sp}', name), clock(it.t)];
}
function showNews() {
  const el = $('#news');
  if (!news.items.length || !state.connected) { el.hidden = true; return; }
  news.shown = (news.shown + 1) % news.items.length;
  const it = news.items[news.shown], [title, sub] = newsText(it), t = T();
  el.classList.add('fade');
  setTimeout(() => {
    el.hidden = false;
    el.querySelector('.news-eyebrow').textContent = t.newsEyebrow.replace('{i}', news.shown + 1).replace('{n}', news.items.length);
    el.querySelector('.news-title').textContent = title; el.querySelector('.news-sub').textContent = sub || '';
    const canvas = el.querySelector('.news-portrait'), sp = it.species && news.byId?.get(it.species), ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (sp?.portrait) { try { portraitMaker().draw(sp.portrait, sp.id, canvas); } catch {} }
    canvas.style.visibility = sp?.portrait ? 'visible' : 'hidden';
    el.dataset.species = it.species ?? '';
    el.classList.remove('fade');
  }, 500);
}
$('#news').addEventListener('click', () => { const sp = Number($('#news').dataset.species); if (sp && species.has(sp)) findSpecies(sp); else museumView.open(); });
setTimeout(async () => { await loadNews(); showNews(); }, 4000);
setInterval(showNews, 9000);
setInterval(loadNews, 300000);
// The paper keeps its back issues: the panel opens on the newest and can be leafed back.
const papers = { list: null, at: -1 };
async function loadPapers() {
  try { const r = await fetch('api/papers', { cache: 'no-store' }); if (r.ok) { const d = await r.json(); papers.list = d.papers || []; papers.stories = d.stories || []; } } catch {}
}
function renderPaper() {
  const s = state.summary, t = T(), list = papers.list?.length ? papers.list : s?.paper ? [s.paper] : [];
  if (!list.length) return;
  if (papers.at < 0 || papers.at >= list.length) papers.at = list.length - 1;
  const p = list[papers.at], newest = papers.at === list.length - 1;
  $('#paper-nav').hidden = list.length < 2; $('#paper-prev').disabled = papers.at === 0; $('#paper-next').disabled = newest;
  $('#paper-count').textContent = t.paperCount.replace('{i}', papers.at + 1).replace('{n}', list.length);
  $('#paper-day').textContent = `${t.day} ${p.day}`.toUpperCase();
  $('#paper-head').textContent = p[lang].headline;
  const items = $('#paper-items'); items.textContent = '';
  for (const it of p[lang].items) { const li = document.createElement('li'); li.textContent = it; items.append(li); }
  const box = $('#paper-stories'); box.textContent = '';
  // the chronicler's notes of that issue's day (for the newest, the latest notes)
  const from = papers.at > 0 ? list[papers.at - 1].at : 0, notes = newest ? (s?.stories || []) : (papers.stories || []).filter(x => x.at > from && x.at <= p.at);
  for (const st of [...notes].reverse().slice(0, 6)) { const art = document.createElement('article'), h = document.createElement('h3'), b = document.createElement('p'); h.textContent = st[lang].title; b.textContent = st[lang].body; art.append(h, b); box.append(art); }
}
const openPaper = async () => { papers.at = -1; renderPaper(); $('#paper-panel').hidden = false; await loadPapers(); papers.at = -1; renderPaper(); };
$('#paper-prev').addEventListener('click', () => { if (papers.at > 0) { papers.at--; renderPaper(); } });
$('#paper-next').addEventListener('click', () => { if (papers.list && papers.at < papers.list.length - 1) { papers.at++; renderPaper(); } });
$('#paper').addEventListener('click', openPaper); $('#paper-teaser').addEventListener('click', openPaper);
$('#paper-close').addEventListener('click', () => { $('#paper-panel').hidden = true; });
$('#paper-panel').addEventListener('click', e => { if (e.target === $('#paper-panel')) $('#paper-panel').hidden = true; });
const aboutCache = {};
async function openAbout(page = 'about') {
  $('#about').hidden = false;
  const key = `${page}-${lang}`;
  try { aboutCache[key] ??= await (await fetch(`${key}.html`)).text(); $('#about-body').innerHTML = (page === 'about' ? '' : `<button type="button" class="about-back" data-more="about">← ${T().aboutTitle}</button>`) + aboutCache[key]; } catch { $('#about-body').textContent = '…'; }
  $('#about-body').scrollTop = 0; $('.about-sheet').scrollTop = 0; aboutPage = page;
}
let aboutPage = 'about';
$('#about-body').addEventListener('click', e => { const b = e.target.closest('[data-more]'); if (b) openAbout(b.dataset.more); });
$('#about-open').addEventListener('click', () => openAbout()); $('#about-from-guide').addEventListener('click', () => openAbout());
$('#about-close').addEventListener('click', () => { $('#about').hidden = true; });
$('#about').addEventListener('click', e => { if (e.target === $('#about')) $('#about').hidden = true; });
addEventListener('keydown', e => { if (e.key === 'Escape') { $('#about').hidden = true; $('#paper-panel').hidden = true; $('#tree').hidden = true; $('#museum').hidden = true; setGuide(false); } });
$('#lapse').addEventListener('click', () => lapse.open());
// Sound is on by default, but browsers allow audio only after a gesture: it starts with the
// first tap, click or key, unless the visitor has switched it off before.
const soundOff = () => { try { return localStorage.getItem('epochs-sound') === 'off'; } catch { return false; } };
$('#sound').addEventListener('click', () => {
  if (sound.on) sound.stop(); else sound.start();
  $('#sound').setAttribute('aria-pressed', sound.on);
  try { localStorage.setItem('epochs-sound', sound.on ? 'on' : 'off'); } catch {}
});
$('#sound').setAttribute('aria-pressed', !soundOff());
// Browsers differ in which gesture unlocks audio (Safari wants a click or touchend), so every
// gesture tries again until the sound really plays.
const GESTURES = ['pointerdown', 'pointerup', 'click', 'touchend', 'keydown'];
const unlock = e => {
  const done = () => { for (const type of GESTURES) removeEventListener(type, unlock, true); };
  if (soundOff()) return done();
  if (e.target.closest?.('#sound')) return; // the sound button handles itself
  if (!sound.on) { sound.start(); $('#sound').setAttribute('aria-pressed', true); }
  else if (sound.ctx?.state !== 'running') sound.ctx?.resume();
  if (sound.ctx?.state === 'running') done();
};
for (const type of GESTURES) addEventListener(type, unlock, true);
$('#lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ru' : 'en'; try { localStorage.setItem('epochs-lang', lang); } catch {}
  applyText(); updateHud(); renderGuide(); if (!$('#paper-panel').hidden) renderPaper(); if (!$('#about').hidden) openAbout(aboutPage);
});

let lastCaption = '', captionAt = 0; // caption state, declared before the first applyText()
function applyText() {
  const t = T(); document.documentElement.lang = lang;
  $('#lang').innerHTML = `${lang === 'en' ? 'RU' : 'EN'} <span>↗</span>`;
  for (const el of document.querySelectorAll('[data-t]')) if (typeof t[el.dataset.t] === 'string') el.textContent = t[el.dataset.t];
  $('#live-label').textContent = state.connected ? t.live : t.connecting;
  document.title = t.title; lastCaption = '';
}
function updateHud() {
  const s = state.summary, t = T(); if (!s) return;
  $('#live-label').textContent = state.connected ? t.live : t.connecting;
  const days = Math.floor(s.t / 86400), env = environment(s.t, s), seasonIndex = Math.floor((((s.t / YEAR) % 1) + .125) * 4) % 4;
  $('#age-label').textContent = `${t.epoch} ${roman(s.epoch)} · ${t.oceanAge}`.toUpperCase();
  $('#epoch-line').textContent = s.epochNames?.[s.epoch]?.[lang]?.name || '';
  $('#age').textContent = `${t.day} ${String(days + 1).padStart(2, '0')}`;
  const h = Math.floor(s.t % 86400 / 3600), m = Math.floor(s.t % 3600 / 60);
  $('#age-detail').textContent = `${h} ${t.h} ${m} ${t.min}`;
  const f = forecast(s);
  $('#season').textContent = t.season[seasonIndex] + (f?.now ? ' · ' + t.ice : f && f.start < 4 * 86400 ? ' · ' + t.coldShort.replace('{d}', span(f.start)) : '') + (s.dust < .9 ? ' · ' + t.dark : '') + (s.weather ? ' · ' + t.weatherNames[s.weather.kind] : '');
  const r = s.roles || {};
  $('#n-animals').textContent = fmt((r.grazer || 0) + (r.predator || 0) + (r.scavenger || 0));
  $('#count-foot').textContent = t.countFoot.replace('{species}', fmt(s.living)).replace('{plants}', fmt(r.producer));
  $('#paper').hidden = !s.paper;
  renderGuide();
}
applyText();

// A caption that describes what the camera is looking at, refreshed every few seconds.
function caption(now, movers, env) {
  if (now - captionAt < 7) return; captionAt = now;
  const t = T().captions, s = state.summary; let text = t.opening;
  if (s && movers.length) {
    const rect = canvas.getBoundingClientRect(), hw = rect.width / 2 / cam.zoom, hh = rect.height / 2 / cam.zoom, W = state.world;
    const seen = new Map(); let pred = 0, juv = 0, n = 0, thorns = 0;
    for (const m of movers) {
      if (Math.abs(wrapD(m[1] - cam.x, W)) > hw || Math.abs(wrapD(m[2] - cam.y, W)) > hh) continue;
      const b = state.bodies.get(m[0]); if (!b) continue; n++;
      if (m[4] < .8) juv++;
      if (species.get(b.sp)?.role === 'predator') pred++;
      seen.set(b.sp, (seen.get(b.sp) || 0) + 1);
    }
    for (const p of state.plants) { if (Math.abs(wrapD(p.x - cam.x, W)) > hw || Math.abs(wrapD(p.y - cam.y, W)) > hh) continue; if (state.bodies.get(p.id)?.modules.some(m => m.t === MOD.ARMOR)) thorns++; }
    const fx = (cam.x / W) % 1, day = Math.max(0, Math.min(1, .2 + .8 * Math.cos(TAU * (fx - env.dayFrac))));
    let herd = null, hc = 0; for (const [id, c] of seen) if (c > hc) { hc = c; herd = id; }
    if (s.dust < .9) text = t.dust;
    else if (s.weather && t[s.weather.kind]) text = t[s.weather.kind];
    else if (env.climate < .75) text = t.cold;
    else if (pred) text = t.predator;
    else if (herd && hc >= 6 && named.has(herd) && Math.random() < .6) text = t.herd.replace('{sp}', aiNames.get(herd)?.[lang] || speciesName(named.get(herd)));
    else if (thorns >= 4 && Math.random() < .5) text = t.thorns;
    else if (n > 8 && juv / n > .45) text = t.juveniles;
    else if (!n) text = t.empty;
    else text = day > .35 ? t.day : t.night;
  }
  if (text === lastCaption) return; lastCaption = text;
  const box = $('#world-caption'); box.classList.add('fade');
  setTimeout(() => { $('#caption').textContent = text; box.classList.remove('fade'); }, 600);
}
