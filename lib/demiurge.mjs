// The demiurge: once a day an outside intelligence looks at the ocean and brings something new into it —
// one or two immigrant species carried in by a current, and perhaps the day's weather. It may only use the
// world's own vocabulary (organs, body plans, growth forms, pigments, looks); everything it returns is
// checked, turned into genomes by fixed rules, and from then on selection alone decides what happens.
// Every paid call is reserved in a durable ledger before it is sent, as for the chronicler.
import fs from 'node:fs';
import path from 'node:path';
import { cleanLook, PATTERNS } from './chronicler.mjs';
import { MODULE, MAX_MODULES, MIN_SIZE, MAX_SIZE, ELONG_MIN, ELONG_MAX, SEG_MAX, FORMS, validGenome, brainFor } from './genome.mjs';

const DAY = 86400000, HOUR = 3600000, MAX_CALLS = 4, MAX_OUTPUT = 6000, INPUT_CEILING = 3, OUTPUT_CEILING = 15; // USD per million tokens
export const ORGANS = { chloroplast: MODULE.PHOTO, mouth: MODULE.MOUTH, cilia: MODULE.FLAGELLUM, armour: MODULE.ARMOR, eye: MODULE.EYE,
  light: MODULE.PHOTOPHORE, fat: MODULE.FAT, tentacle: MODULE.TENTACLE, spine: MODULE.SPINE };
export const LIFESTYLES = ['grazer', 'hunter', 'ambusher', 'drifter', 'plant'];
export const GROWTH = ['rosette', 'filament', 'bush', 'kelp', 'runner', 'colony', 'diatom'];
export const REGIONS = ['shallows', 'slopes', 'deep'];
export const WEATHER = ['storm', 'red_tide', 'warm_current', 'bloom'];
const PLACES = { front: 0, rear: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 };

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max && !/[<>`]|https?:|\p{Cc}/u.test(v) ? v.trim() : null;

// One immigrant as the model described it → a checked design, or null. Never throws.
export function cleanDesign(d) {
  if (!d || typeof d !== 'object') return null;
  const latin = text(d.latin, 32), en = text(d.en, 48), ru = text(d.ru, 48), en_note = text(d.en_note, 260), ru_note = text(d.ru_note, 260);
  const lifestyle = LIFESTYLES.includes(d.lifestyle) ? d.lifestyle : null, region = REGIONS.includes(d.region) ? d.region : null;
  const look = cleanLook(d.look), count = Math.round(num(d.count, 12, 40) ?? 20), b = d.body || {};
  if (!latin || /\d/.test(latin) || !en || !ru || !en_note || !ru_note || !lifestyle || !region || !look || !Array.isArray(b.organs)) return null;
  const plant = lifestyle === 'plant', organs = [];
  for (const o of b.organs.slice(0, MAX_MODULES)) {
    const t = ORGANS[o?.type], s = num(o?.size, MIN_SIZE, MAX_SIZE);
    if (t === undefined || s === null) return null;
    if (plant && (t === MODULE.MOUTH || t === MODULE.FLAGELLUM)) continue; // a plant has no mouth and does not swim
    organs.push({ t, s: Math.round(s * 100) / 100, place: Object.hasOwn(PLACES, o.place) ? o.place : 'around' });
  }
  const total = organs.reduce((a, o) => a + o.s, 0);
  if (!organs.length || total > 7) return null;
  if (plant && !organs.some(o => o.t === MODULE.PHOTO)) return null;
  if (!plant && !organs.some(o => o.t === MODULE.MOUTH || o.t === MODULE.FLAGELLUM)) return null;
  const rays = b.symmetry === 'radial' ? Math.round(num(b.rays, 3, 8) ?? 5) : 0;
  return { latin, en, ru, en_note, ru_note, lifestyle, region, look, count, organs,
    sym: plant ? 0 : rays, elong: num(b.length, ELONG_MIN, ELONG_MAX) ?? 1.3, seg: plant ? 1 : Math.round(num(b.segments, 1, SEG_MAX) ?? 1),
    form: plant ? Math.max(0, GROWTH.indexOf(b.form)) : 0, pig: num(b.pigment, 0, 1) ?? 0, leaf: num(b.leaf, 0, 1) ?? .5,
    diet: num(d.diet, 0, 1) ?? { grazer: .1, hunter: .85, ambusher: .8, drifter: .2, plant: .05 }[lifestyle] };
}

// A checked design → a genome, by fixed rules (organ angles from their place, reflexes from the way of
// life, neutral markers from the world's own random numbers).
export function genomeOf(d, rng) {
  let k = 0; const around = d.organs.filter(o => o.place === 'around').length || 1;
  const modules = d.organs.map(o => ({ t: o.t, s: o.s, a: o.place === 'around' ? -Math.PI + (k++ + .5) * 2 * Math.PI / around : PLACES[o.place] }));
  const g = { modules, brain: brainFor(d.lifestyle, rng), diet: d.diet, repro: d.lifestyle === 'plant' ? .65 : .7, invest: .35, birth: .45, freq: rng.range(.05, .5),
    markers: [rng.next(), rng.next(), rng.next(), rng.next()], sym: d.sym, elong: d.elong, seg: d.seg, form: Math.min(FORMS - 1, d.form), pig: d.pig, leaf: d.leaf };
  return validGenome(g) ? g : null;
}

const SYSTEM = `You are the demiurge of "NIMA: Epochs", an artificial ocean on a server where life evolves by itself from simple rules. Once a day you look at the state of the world and bring something new into it, so that the ocean stays varied and surprising: one or two immigrant species carried in by a current from beyond the map, and, if it would make the day more interesting, one weather event. After that you have no power: selection decides whether your immigrants thrive, change the world, split into new species or die out. Tomorrow you will see what became of them.

How bodies work (you can only use this vocabulary):
- organs, each with a size 0.1 to 1.5 (sum of sizes at most 7): chloroplast (food from light; worth more in plants, less in big swimmers), mouth (bites algae, plants or animals; works best at the front), cilia (swimming; push best from the rear), armour (defence against smaller mouths; heavy), eye (sight; best at the front), light (light organ: a startle flash when bitten lets prey escape), fat (energy store for the night and the cold), tentacle (reach and grip for catching prey; drags in the water), spine (stings whoever bites; drags).
- each organ has a place: front, rear, left, right or around.
- body plan of an animal: symmetry bilateral (with a length 0.7 round to 2.4 long; long bodies are fast but turn slowly) or radial with 3 to 8 rays (no front, mouths and eyes work all round, cheap to keep, slow); segments 1 to 5 (a chain repeating all organs: cheaper per segment, but heavy and late to mature).
- plants (lifestyle plant: no mouth, no cilia) grow as rosette, filament (spreads over three cells), bush (tall, shades others), kelp (tallest, reaches the light from slopes), runner (creeps and spreads far, cheap offshoots), colony (floats near the surface, light even over deep water, no defence) or diatom (glass shell, hard to graze, heavy). pigment 0 green (best in bright shallows) to 0.7+ red (best in dim deep water); leaf 0 narrow (grazed less, less light) to 1 broad.
- diet 0 to 1: 0 digests plants well and meat poorly, 1 the reverse (meat is easier to digest).
- lifestyle sets the newcomer's first reflexes: grazer (seeks plants and algae, flees threats), hunter (chases prey), ambusher (waits and bites what comes close), drifter (cruises slowly, lives on light), plant.
- region where the current brings them: shallows (bright banks), slopes (edges of the banks), deep (dark open water, 90% of the ocean).
- look: the surface pattern an artist gives it: pattern one of ${PATTERNS.join(', ')}; density, contrast, light 0..1; hue 0..1 (0 red, 0.17 yellow, 0.33 green, 0.5 cyan, 0.66 blue, 0.83 violet).
Weather you may call (or not): storm (murky, a surge, tears tall plants, then a bloom), red_tide (poisonous bloom off a bank), warm_current (a bright band crossing the ocean for a day), bloom (nutrients well up in one place).

Aim for variety and drama that the world can actually sustain: fill empty niches, give missing roles a chance (for example real predators, deep-water life, light-signalling animals), try body plans the ocean has not tried, sometimes run a bold experiment. Learn from your previous immigrants' fate. Do not repeat yourself. Names: latin a binomial of Latin or Greek roots (no digits, at most 28 letters, not already used); en and ru natural common names of two or three words (idiomatic Russian); en_note and ru_note one plain sentence each about its body and way of life. The dispatch is a short note for the chronicle (title up to 70 characters, body two or three sentences up to 420 characters, in English and Russian) about what the current brought today and why it might matter; no digits in prose.
Answer with one JSON object only, in exactly the shape given.`;

const SHAPE = { dispatch: { en: { title: '', body: '' }, ru: { title: '', body: '' } },
  immigrants: [{ latin: '', en: '', ru: '', en_note: '', ru_note: '', lifestyle: 'hunter', region: 'slopes', count: 20, diet: .8,
    body: { organs: [{ type: 'mouth', size: .6, place: 'front' }, { type: 'cilia', size: .5, place: 'rear' }], symmetry: 'bilateral', rays: 0, length: 1.6, segments: 1, form: 'rosette', pigment: 0, leaf: .5 },
    look: { pattern: 'stripes', density: .5, contrast: .6, hue: .8, light: .3 } }],
  weather: { kind: 'storm', why: '' } };

function atomic(file, value) {
  const tmp = `${file}.tmp`, fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

export class Demiurge {
  // apply(designs, weather) → Promise<[{ species, made } | null]>: hands the checked designs to the engine.
  constructor({ dir, env = process.env, fetchImpl = fetch, now = () => Date.now(), chronicler, apply }) {
    this.file = path.join(dir, 'demiurge.json'); this.fetch = fetchImpl; this.now = now; this.chronicler = chronicler; this.apply = apply;
    this.key = env.VENICE_API_KEY || ''; this.model = env.EPOCHS_DEMIURGE_MODEL || 'claude-sonnet-5-5';
    this.limit = Math.min(.3, Number(env.EPOCHS_DEMIURGE_USD || .2)); // a hard ceiling whatever the setting says
    this.enabled = env.EPOCHS_DEMIURGE_ENABLED !== '0' && env.EPOCHS_AI_ENABLED === '1' && !!this.key;
    this.state = { version: 1, ledger: [], sessions: [], last: {}, halted: false };
    try { const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (s.version === 1) this.state = { ...this.state, ...s }; } catch {}
    this.busy = false; this.reason = this.enabled ? 'waiting' : 'disabled';
  }
  save() { atomic(this.file, this.state); }
  status() {
    const day = this.state.ledger.filter(r => r.at > this.now() - DAY);
    return { enabled: this.enabled, reason: this.reason, spentToday: +day.reduce((s, r) => s + (r.reported ?? r.reserved), 0).toFixed(5), limit: this.limit, model: this.model, sessions: this.state.sessions.length };
  }
  // Once a day (a failed or refused attempt is retried after an hour).
  observe(summary) {
    if (!this.enabled || this.busy || this.state.halted || !summary || summary.t < 3600) return;
    const now = this.now(), last = this.state.last;
    if (now - (last.session || 0) < 23 * HOUR || now - (last.attempt || 0) < HOUR) return;
    this.busy = true;
    this.session(summary).catch(e => { this.reason = 'error'; console.error('demiurge:', e.message); }).finally(() => { this.busy = false; try { this.save(); } catch {} });
  }
  // What the demiurge is shown: the state of the ocean and the fate of its earlier immigrants.
  context(s) {
    const names = this.chronicler?.state?.names || {}, living = new Map((s.species || []).map(x => [x.id, x]));
    const plan = x => {
      const parts = {}; for (const m of x.modules || []) { const k = Object.keys(ORGANS).find(n => ORGANS[n] === m); parts[k] = (parts[k] || 0) + 1; }
      const plant = !(x.modules || []).includes(MODULE.MOUTH) && !(x.modules || []).includes(MODULE.FLAGELLUM);
      return { organs: parts, ...(plant ? { form: GROWTH[x.form || 0], pigment: x.pig } : { symmetry: x.sym > 0 ? `radial ${x.sym}` : 'bilateral', length: x.elong, segments: x.seg }) };
    };
    const species = (s.species || []).filter(x => x.established).slice(0, 40).map(x => ({ name: names[x.id]?.latin || `species ${x.id}`, common: names[x.id]?.en, living: x.count,
      role: x.role, diet: x.diet, immigrant: !!x.immigrant, ...plan(x) }));
    const past = this.state.sessions.slice(-7).map(z => ({ day: z.day, weather: z.weather?.kind || null, immigrants: (z.results || []).map(r => ({ name: r.latin, lifestyle: r.lifestyle, region: r.region,
      broughtIn: r.made, livingNow: r.species && living.get(r.species)?.count || 0, established: !!(r.species && living.get(r.species)?.established) })) }));
    const roles = s.roles || {}, trend = (s.trend || []).filter((_, i, a) => i % 12 === 0 || i === a.length - 1).map(([t, p, g, c, sc]) => ({ hour: Math.round(t / 3600), producers: p, grazers: g, predators: c, scavengers: sc }));
    return { worldDay: Math.floor(s.t / 86400) + 1, epoch: s.epoch, creatures: s.creatures ?? null, roles, livingSpecies: (s.species || []).length,
      establishedSpecies: species.length, weatherNow: s.weather?.kind || null, recentEvents: (s.events || []).slice(-12).map(e => e.type), trendLastHalfDay: trend,
      species, yourPreviousDays: past, usedNames: Object.values(names).slice(-60).map(n => n.latin) };
  }
  async session(s) {
    const now = this.now(); this.state.last.attempt = now;
    const out = await this.call({ task: 'Today: design one or two immigrant species for the ocean, and choose the weather or none (weather may be null).', shape: SHAPE, world: this.context(s) });
    if (!out) return;
    const designs = (Array.isArray(out.immigrants) ? out.immigrants : []).slice(0, 2).map(cleanDesign).filter(Boolean);
    const taken = new Set(Object.values(this.chronicler?.state?.names || {}).map(n => n.latin.toLowerCase()));
    const fresh = designs.filter(d => !taken.has(d.latin.toLowerCase()));
    const weather = WEATHER.includes(out.weather?.kind) ? out.weather.kind : null;
    if (!fresh.length && !weather) { this.reason = 'invalid'; return; }
    const results = await this.apply(fresh, weather);
    const day = Math.floor(s.t / 86400) + 1, kept = [];
    fresh.forEach((d, i) => {
      const r = results?.[i]; kept.push({ latin: d.latin, lifestyle: d.lifestyle, region: d.region, count: d.count, species: r?.species ?? null, made: r?.made ?? 0 });
      if (r?.species && this.chronicler) this.chronicler.state.names[r.species] = { latin: d.latin, en: d.en, ru: d.ru, en_note: d.en_note, ru_note: d.ru_note, look: d.look, at: now, by: 'demiurge' };
    });
    const disp = out.dispatch, flat = v => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v; // line breaks are fine in a note
    for (const l of ['en', 'ru']) if (disp?.[l]) disp[l] = { title: flat(disp[l].title), body: flat(disp[l].body) };
    const ok = l => disp?.[l] && text(disp[l].title, 120) && text(disp[l].body, 900);
    if (this.chronicler && ok('en') && ok('ru') && kept.some(k => k.made)) {
      this.chronicler.state.stories.push({ id: `demiurge-${day}-${now}`, type: 'immigration', t: s.t, at: now, by: 'demiurge',
        en: { title: disp.en.title.trim(), body: disp.en.body.trim() }, ru: { title: disp.ru.title.trim(), body: disp.ru.body.trim() } });
      this.chronicler.state.stories = this.chronicler.state.stories.slice(-60);
    }
    try { this.chronicler?.save(); } catch {}
    const dispatch = ok('en') && ok('ru') ? { en: disp.en, ru: disp.ru } : { rejected: JSON.stringify(disp ?? null).slice(0, 2000) };
    this.state.sessions = [...this.state.sessions, { at: now, day, model: this.model, weather: weather ? { kind: weather, why: text(out.weather?.why, 300) } : null, results: kept, designs: fresh, dispatch }].slice(-60);
    this.state.last.session = now; this.reason = 'ready';
  }
  async request(endpoint, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await this.fetch(`https://api.venice.ai/api/v1/${endpoint}`, { method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (!res.ok) { await res.body?.cancel(); throw Error(`api ${res.status}`); }
      const t = await res.text(); if (t.length > 600000) throw Error('api size');
      return JSON.parse(t);
    } finally { clearTimeout(timer); }
  }
  async call(payload) {
    const now = this.now();
    const catalogue = await this.request('models?type=text');
    const p = catalogue.data?.find(m => m.id === this.model)?.model_spec?.pricing;
    const price = o => { const v = [o?.usd, o?.diem].filter(Number.isFinite); return v.length ? Math.max(...v) : NaN; }, input = price(p?.input), output = price(p?.output);
    if (!(input >= 0 && output >= 0 && input <= INPUT_CEILING && output <= OUTPUT_CEILING)) { this.reason = 'pricing'; return null; }
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(payload) }];
    const inputBound = Buffer.byteLength(JSON.stringify(messages)) + 1024;
    const reserved = (inputBound * input + MAX_OUTPUT * output) / 1e6 * 1.25;
    const day = this.state.ledger.filter(r => r.at > now - DAY);
    if (day.length >= MAX_CALLS || day.reduce((s, r) => s + (r.reported ?? r.reserved), 0) + reserved > this.limit) { this.reason = 'budget'; return null; }
    const entry = { at: now, kind: 'session', reserved, reported: null };
    this.state.ledger = [...this.state.ledger.filter(r => r.at > now - 8 * DAY), entry];
    this.save(); // durable before transmission; failed calls are never refunded
    this.reason = 'thinking';
    const res = await this.request('chat/completions', { model: this.model, messages, max_tokens: MAX_OUTPUT, max_completion_tokens: MAX_OUTPUT, temperature: .9, n: 1, stream: false,
      response_format: { type: 'json_object' }, reasoning_effort: 'low', venice_parameters: { include_venice_system_prompt: false, enable_web_search: 'off' } });
    const u = res.usage;
    if (!u || !(u.prompt_tokens >= 0) || !(u.completion_tokens >= 0) || u.prompt_tokens > inputBound || u.completion_tokens > MAX_OUTPUT * 1.05) { this.state.halted = true; this.reason = 'billing'; return null; }
    entry.reported = res.cost && Number.isFinite(res.cost.usd) ? res.cost.usd + (Number.isFinite(res.cost.diem) ? res.cost.diem : 0) : (u.prompt_tokens * input + u.completion_tokens * output) / 1e6;
    if (entry.reported > reserved) { this.state.halted = true; this.reason = 'billing'; return null; }
    const choice = res.choices?.[0]; if (!['stop', 'end_turn'].includes(choice?.finish_reason)) { this.reason = 'incomplete'; return null; }
    const content = String(choice.message?.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
    try { return JSON.parse(content); } catch { this.reason = 'unreadable'; return null; }
  }
}
