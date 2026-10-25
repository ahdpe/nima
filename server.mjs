// Web server: owns the engine process, serves the page and broadcasts frames.
// Visitors only observe; nothing they send can change the world.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { accept, send, sendRaw, frame } from './lib/websocket.mjs';
import { PLANT_BYTES } from './lib/frames.mjs';
import { Chronicler } from './lib/chronicler.mjs';
import { Demiurge } from './lib/demiurge.mjs';
import { Discoveries } from './lib/discoveries.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.EPOCHS_PORT || 18975), HOST = process.env.EPOCHS_HOST || '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'" };

const engine = fork(path.join(ROOT, 'engine.mjs'), [], { serialization: 'advanced', env: process.env, stdio: 'inherit' });
let stopping = false;
engine.on('exit', code => { if (stopping) process.exit(0); console.error(`Engine exited (${code}); stopping server so the supervisor restarts both.`); process.exit(1); });

const DATA = process.env.EPOCHS_DATA_DIR || path.join(ROOT, 'data');
const chronicler = new Chronicler({ dir: DATA }), discoveries = new Discoveries(DATA);
// Once a day the demiurge brings immigrants (and maybe weather); the engine carries them in.
const demiurge = new Demiurge({ dir: DATA, chronicler, apply: async (designs, weather) => JSON.parse(await ask('immigrate', { designs, weather })).results });
let lastSummary = null;
// The page's code as served now: an open page that sees a different build after a restart reloads itself.
const BUILD = (() => { const h = createHash('sha1'), dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
  for (const f of fs.readdirSync(dir).filter(f => /\.(js|html|css)$/.test(f)).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex').slice(0, 12); })();
const decorate = data => { const d = chronicler.decorate(data); d.discoveries = discoveries.for((data.species || []).map(s => s.id)); d.build = BUILD; return d; };
const clients = new Set();
// Region streaming: each viewer receives the creatures near its camera, with a margin.
let world = 1536, decoded = { actors: null, plants: null };
function decode(buf, stride) { // positions of every record in a frame, as world units
  const n = buf.readUInt32LE(16), xs = new Float32Array(n), ys = new Float32Array(n), W = buf.readUInt16LE(2);
  for (let i = 0, o = 24; i < n; i++, o += stride) { xs[i] = buf.readUInt16LE(o + 4) / 65536 * W; ys[i] = buf.readUInt16LE(o + 6) / 65536 * W; }
  world = W; return { buf, stride, n, xs, ys };
}
const inView = (v, x, y, m) => { const dx = Math.abs(((x - v.x) % world + world * 1.5) % world - world / 2), dy = Math.abs(((y - v.y) % world + world * 1.5) % world - world / 2); return dx <= v.hw * m && dy <= v.hh * m; };
function regional(d, v, margin) {
  if (!v || v.hw * margin * 2 >= world * .5 || v.hh * margin * 2 >= world * .5) return null; // zoomed far out: the whole frame
  const keep = []; for (let i = 0; i < d.n; i++) if (inView(v, d.xs[i], d.ys[i], margin)) keep.push(i);
  const out = Buffer.alloc(24 + keep.length * d.stride); d.buf.copy(out, 0, 0, 24); out.writeUInt32LE(keep.length, 16);
  keep.forEach((i, k) => d.buf.copy(out, 24 + k * d.stride, 24 + i * d.stride, 24 + (i + 1) * d.stride));
  return frame(out, 0x2);
}
function sendRegion(c, kind) {
  const d = decoded[kind]; if (!d) return;
  const bytes = regional(d, c.view, kind === 'plants' ? 1.8 : 1.4) || latest[kind];
  if (bytes) sendRaw(c, bytes);
  if (kind === 'plants') c.plantsView = c.view && { ...c.view };
}
const latest = { actors: null, plants: null, fields: null, summary: null };
let pending = new Map(), nextRequest = 1, startedAt = Date.now(), lastFrameAt = 0;

engine.on('message', m => {
  if (m.type === 'frame') {
    const raw = Buffer.from(m.bytes), bytes = frame(raw, 0x2);
    if (m.kind !== 'bodies') latest[m.kind] = bytes;
    lastFrameAt = Date.now();
    if (m.kind === 'actors' || m.kind === 'plants') {
      decoded[m.kind] = decode(raw, m.kind === 'actors' ? 12 : PLANT_BYTES);
      for (const c of clients) if (c.ready) sendRegion(c, m.kind);
    } else for (const c of clients) if (c.ready) sendRaw(c, bytes);
  } else if (m.type === 'summary') {
    chronicler.observe(m.data); demiurge.observe(m.data); lastSummary = m.data;
    const bytes = frame(Buffer.from(JSON.stringify(decorate(m.data))), 0x1);
    latest.summary = bytes;
    for (const c of clients) if (c.ready) sendRaw(c, bytes);
  } else if (m.type === 'reply') {
    const done = pending.get(m.id); pending.delete(m.id); done?.(Buffer.from(m.bytes));
  }
});
function ask(type, extra = {}) {
  return new Promise((resolve, reject) => {
    const id = nextRequest++; pending.set(id, resolve); engine.send({ ...extra, type, id });
    setTimeout(() => { if (pending.delete(id)) reject(Error('Engine did not answer')); }, 5000);
  });
}

// The last day as a compressed keyframe stream; rebuilt at most every two minutes.
let lapse = null;
async function timelapse(request, response) {
  try {
    if (!lapse || Date.now() - lapse.at > 120000) lapse = { at: Date.now(), bytes: await ask('timelapse') };
    response.writeHead(200, { ...SECURITY, 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Content-Length': lapse.bytes.length, 'Cache-Control': 'public, max-age=120' });
    response.end(request.method === 'HEAD' ? undefined : lapse.bytes);
  } catch { response.writeHead(503, SECURITY); response.end('Time-lapse is not ready'); }
}

// The tree of life: every established species, extinct (from the fossil record) and living.
let treeCache = null;
function tree(request, response) {
  if (!treeCache || Date.now() - treeCache.at > 60000) {
    const species = new Map();
    try {
      const text = fs.readFileSync(path.join(DATA, 'fossils.jsonl'), 'utf8');
      for (const line of text.split('\n')) { if (!line) continue; try { const f = JSON.parse(line); species.set(f.id, { id: f.id, parent: f.parent, born: f.born, died: f.died, peak: f.peak, role: f.role, hue: f.hue ?? .5, modules: f.modules || [], diet: f.diet, epoch: f.epoch, lazarus: f.lazarus || null, immigrant: f.immigrant || null, sym: f.sym || 0, elong: f.elong ?? 1.3, seg: f.seg || 1, form: f.form || 0, pig: f.pig || 0, leaf: f.leaf ?? .5 }); } catch {} }
    } catch {}
    for (const s of lastSummary?.species || []) if (s.established) species.set(s.id, { id: s.id, parent: s.parent, born: s.born, died: null, peak: s.peak, count: s.count, role: s.role, hue: s.hue, modules: s.modules, diet: s.diet, epoch: s.epoch, lazarus: s.lazarus || null, immigrant: s.immigrant || null, sym: s.sym || 0, elong: s.elong ?? 1.3, seg: s.seg || 1, form: s.form || 0, pig: s.pig || 0, leaf: s.leaf ?? .5 });
    const ids = [...species.keys()], names = {}, n = chronicler.state.names;
    for (const id of ids) if (n[id]) names[id] = n[id];
    treeCache = { at: Date.now(), body: Buffer.from(JSON.stringify({ t: lastSummary?.t ?? 0, epoch: lastSummary?.epoch ?? 1, epochNames: chronicler.state.epochs,
      epochEvents: (chronicler.state.epochStarts || []), species: [...species.values()], names, discoveries: discoveries.for(ids) })) };
  }
  response.writeHead(200, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(treeCache.body);
}

// The museum of forms: every established species with a portrait to draw it by, from the
// engine's memory (living species and the spore bank) and the fossil record.
let museumCache = null;
async function museum(request, response) {
  try {
    if (!museumCache || Date.now() - museumCache.at > 60000) {
      const { t, portraits } = JSON.parse(await ask('museum')), species = new Map();
      try {
        for (const line of fs.readFileSync(path.join(DATA, 'fossils.jsonl'), 'utf8').split('\n')) {
          if (!line) continue;
          try { const f = JSON.parse(line); species.set(f.id, { id: f.id, born: f.born, died: f.died, peak: f.peak, role: f.role, count: 0, immigrant: f.immigrant || null, portrait: f.portrait || portraits[f.id] || null }); } catch {}
        }
      } catch {}
      for (const s of lastSummary?.species || []) if (s.established || s.immigrant) species.set(s.id, { id: s.id, born: s.born, died: null, peak: s.peak, role: s.role, count: s.count, immigrant: s.immigrant || null, portrait: portraits[s.id] || null });
      const list = [...species.values()].filter(s => s.portrait), names = {}, n = chronicler.state.names;
      for (const s of list) if (n[s.id]) names[s.id] = n[s.id];
      museumCache = { at: lastSummary ? Date.now() : 0, body: Buffer.from(JSON.stringify({ t, species: list, names, unknown: species.size - list.length })) }; // not cached before the first summary
    }
    response.writeHead(200, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(museumCache.body);
  } catch { response.writeHead(503, SECURITY); response.end('The museum is not ready'); }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://local');
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, SECURITY); return response.end(); }
  if (url.pathname === '/api/timelapse') return timelapse(request, response);
  if (url.pathname === '/api/museum') return museum(request, response);
  if (url.pathname === '/api/news') { // the day's discoveries for the ribbon on the main screen: firsts, new species, great extinctions, catastrophes
    const now = lastSummary?.t ?? 0, keep = new Set(['immigration', 'first_plan', 'first_predator', 'first_scavenger', 'speciation', 'extinction', 'epoch', 'eruption', 'meteor', 'epidemic', 'ice_age_start', 'recovery', 'storm', 'red_tide', 'warm_current', 'bloom']), items = [];
    try {
      for (const line of fs.readFileSync(path.join(DATA, 'events.jsonl'), 'utf8').split('\n').slice(-400)) {
        if (!line) continue; let e; try { e = JSON.parse(line); } catch { continue; }
        if (!keep.has(e.type) || e.t < now - 86400 || (e.type === 'extinction' && (e.peak || 0) < 150)) continue;
        const n = e.species && chronicler.state.names[e.species];
        items.push({ type: e.type, t: e.t, species: e.species ?? null, plan: e.plan, rays: e.rays, epoch: e.epoch, name: n ? { latin: n.latin, en: n.en, ru: n.ru } : null, look: n?.look || null });
      }
    } catch {}
    response.writeHead(200, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify({ t: now, items: items.reverse().slice(0, 12) }));
  }
  if (url.pathname === '/api/demiurge') { // the demiurge's diary: what it brought each day and why (no ledger, no keys)
    response.writeHead(200, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify({ status: demiurge.status(), days: demiurge.state.sessions.slice(-30).map(z => ({ day: z.day, at: z.at, weather: z.weather, immigrants: z.results })) }));
  }
  if (url.pathname === '/api/papers') { // every kept issue of the daily paper, and the chronicler's notes to go with them
    response.writeHead(200, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify({ papers: chronicler.state.papers, stories: chronicler.state.stories }));
  }
  if (url.pathname === '/api/tree') return tree(request, response);
  if (url.pathname === '/health') {
    response.writeHead(200, { ...SECURITY, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify({ status: Date.now() - lastFrameAt < 5000 ? 'alive' : 'starting', viewers: clients.size, uptime: Math.round((Date.now() - startedAt) / 1000) }));
  }
  let name = decodeURIComponent(url.pathname);
  if (name.endsWith('/')) name += 'index.html';
  const file = path.normalize(path.join(PUBLIC, name));
  if (!file.startsWith(PUBLIC + path.sep) || !MIME[path.extname(file)]) { response.writeHead(404, SECURITY); return response.end('Not found'); }
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) { response.writeHead(404, SECURITY); return response.end('Not found'); }
    response.writeHead(200, { ...SECURITY, 'Content-Type': MIME[path.extname(file)], 'Content-Length': stat.size, 'Cache-Control': file.endsWith('.woff2') ? 'public, max-age=2592000, immutable' : 'no-cache' });
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(file).pipe(response);
  });
});

server.on('upgrade', async (request, socket) => {
  if (new URL(request.url, 'http://local').pathname !== '/ws') return socket.destroy();
  const client = accept(request, socket, { clients, maxClients: Number(process.env.EPOCHS_MAX_VIEWERS || 300) });
  if (!client) return;
  // The only thing a viewer may send: where its camera is (world units). It changes what it receives, never the world.
  client.onText = text => {
    try {
      const v = JSON.parse(text);
      if (v?.type === 'discover') {
        const now = Date.now(); if (now - (client.lastClaim || 0) < 5000 || (client.claims = (client.claims || 0) + 1) > 200) return;
        client.lastClaim = now;
        if (discoveries.claim(v.species, v.who, lastSummary)) {
          latest.summary = frame(Buffer.from(JSON.stringify(decorate(lastSummary))), 0x1);
          for (const c of clients) if (c.ready) sendRaw(c, latest.summary);
        }
        return;
      }
      if (v?.type === 'need') { // a viewer sees creatures it has no body for: send those bodies, at most once a second
        const now = Date.now(); if (now - (client.lastNeed || 0) < 1000 || !Array.isArray(v.ids)) return;
        client.lastNeed = now;
        const ids = v.ids.filter(Number.isInteger).slice(0, 80);
        if (ids.length) ask('need', { ids }).then(bytes => { if (client.ready) send(client, bytes); }).catch(() => {});
        return;
      }
      if (v?.type !== 'view' || ![v.x, v.y, v.hw, v.hh].every(Number.isFinite) || v.hw <= 0 || v.hh <= 0) return;
      const prev = client.plantsView;
      client.view = { x: v.x, y: v.y, hw: Math.min(v.hw, world), hh: Math.min(v.hh, world) };
      // Moved beyond the plants already sent: send this area's plants now rather than in up to 15 s.
      if (client.ready && (!prev || !inView({ ...prev, hw: prev.hw * .8, hh: prev.hh * .8 }, v.x, v.y, 1) || v.hw > prev.hw * 1.3)) sendRegion(client, 'plants');
    } catch {}
  };
  // A new viewer gets the field, plants, every body plan, then the live stream.
  try {
    for (const k of ['summary', 'fields']) if (latest[k]) sendRaw(client, latest[k]);
    send(client, await ask('bodies'));
    sendRegion(client, 'plants'); sendRegion(client, 'actors');
  } catch { /* the stream itself will catch up */ }
  client.ready = true;
});

// Keep connections honest: ping every 30 s, drop the silent ones.
setInterval(() => { for (const c of clients) { if (!c.alive) { c.drop(); continue; } c.alive = false; sendRaw(c, Buffer.from([0x89, 0])); } }, 30000);

server.listen(PORT, HOST, () => console.log(`NIMA: Epochs on http://${HOST}:${PORT}/`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; server.close(); engine.kill('SIGTERM'); setTimeout(() => process.exit(0), 8000).unref(); });
