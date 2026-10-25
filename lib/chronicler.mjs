// The chronicler: a low-frequency outside intelligence that names species, writes
// short stories about notable events and a daily paper. It never changes the world.
// Every paid call is reserved in a durable ledger before it is sent.
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000, HOUR = 3600000, MAX_CALLS = 144; // calls a day; each costs a fraction of a cent
const MAX_OUTPUT = 1400, INPUT_CEILING = .25, OUTPUT_CEILING = 1.2; // USD per million tokens, refuse pricier models
const NOTABLE = new Set(['first_predator', 'first_scavenger', 'first_plan', 'storm', 'red_tide', 'warm_current', 'bloom', 'epoch', 'eruption', 'meteor', 'epidemic', 'ice_age_start', 'ice_age_end', 'recovery', 'extinction']);
const PARTS = ['chloroplast', 'mouth', 'flagellum', 'armour', 'eye', 'light organ', 'fat body', 'tentacle', 'spine'];
// The artist's vocabulary: the chronicler dresses each species in one of these surface patterns.
// Only these numbers reach the page, never free text or code.
export const PATTERNS = ['none', 'spots', 'stripes', 'bands', 'rings', 'net', 'speckle', 'rim', 'sheen'];
const unit = v => typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
export function cleanLook(l) {
  const p = PATTERNS.indexOf(l?.pattern), d = unit(l?.density), c = unit(l?.contrast), h = typeof l?.hue === 'number' && Number.isFinite(l.hue) ? ((l.hue % 1) + 1) % 1 : null, li = unit(l?.light);
  if (p < 0 || d === null || c === null || h === null || li === null) return null;
  const r3 = v => Math.round(v * 1000) / 1000;
  return { p, d: r3(d), c: r3(c), h: r3(h), l: r3(li) };
}
const LOOK_TASK = 'look: the surface pattern and colouring an artist would give it, fitting its life and body (for example a dark hunter with violet stripes, a plant of the bright shallows with golden rims, a deep-water drifter with a pale sheen). pattern is one of ' + PATTERNS.join(', ') + '; density 0..1 from a few bold marks to many fine ones; contrast 0..1; hue 0..1 on the colour wheel (0 red, 0.17 yellow, 0.33 green, 0.5 cyan, 0.66 blue, 0.83 violet); light 0..1 from dark to pale. If parentLook is given, the new species is its descendant: keep the family resemblance (usually the same pattern, hue within 0.08, small changes elsewhere). Unrelated lineages should look clearly different.';

const SYSTEM = `You are the naturalist-chronicler of "NIMA: Epochs", an artificial ocean on a server where life evolves on its own from simple rules: bodies are built from modules (chloroplast, mouth, flagellum, armour, eye, light organ, fat body, tentacle, spine) on a body plan (bilateral, or radial with 3-8 rays, short or long, in a chain of up to 5 segments; plants grow as rosettes, filaments or bushes), animals have tiny neural brains, and roles such as grazer or predator are measured from what living members actually ate. Nobody designs the creatures after the first ancestors.
Write for curious visitors, in a calm, precise, lightly poetic voice. Use only the facts supplied; never invent numbers, organs, behaviour or causes. Do not use digits in prose. Always answer with one JSON object in the requested shape, with parallel English ("en") and Russian ("ru") text.`;

function atomic(file, value) {
  const tmp = `${file}.tmp`, fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
const clean = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max && !/[<>`]|https?:|\p{Cc}/u.test(v) ? v.trim() : null;

export class Chronicler {
  constructor({ dir, env = process.env, fetchImpl = fetch, now = () => Date.now() }) {
    this.file = path.join(dir, 'chronicle.json'); this.fetch = fetchImpl; this.now = now;
    this.key = env.VENICE_API_KEY || ''; this.model = env.EPOCHS_AI_MODEL || 'qwen3-235b-a22b-instruct-2507';
    this.limit = Math.min(.2, Number(env.EPOCHS_AI_DAILY_USD || .05)); // a hard ceiling whatever the setting says
    this.enabled = env.EPOCHS_AI_ENABLED === '1' && !!this.key;
    this.state = { version: 1, names: {}, stories: [], papers: [], epochs: {}, ledger: [], halted: false, lastSeq: 0, queue: [], last: {} };
    try { const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (s.version === 1) this.state = { ...this.state, ...s }; } catch {}
    this.state.epochs ??= {}; this.state.epochStarts ??= [];
    this.busy = false; this.reason = this.enabled ? 'waiting' : 'disabled';
  }
  save() { atomic(this.file, this.state); }
  status() {
    const day = this.state.ledger.filter(r => r.at > this.now() - DAY);
    return { enabled: this.enabled, reason: this.reason, spentToday: +day.reduce((s, r) => s + (r.reported ?? r.reserved), 0).toFixed(5), limit: this.limit };
  }
  // What the page shows: names for listed species, recent stories, the latest paper.
  decorate(summary) {
    const names = {};
    for (const s of summary.species || []) if (this.state.names[s.id]) names[s.id] = this.state.names[s.id];
    for (const e of summary.events || []) if (e.species && this.state.names[e.species]) names[e.species] = this.state.names[e.species];
    return { ...summary, names, epochNames: this.state.epochs, stories: this.state.stories.slice(-12), paper: this.state.papers.at(-1) || null, chronicler: this.status() };
  }

  // Called with every summary from the engine; decides whether one call is due.
  observe(summary) {
    for (const e of summary.events || []) if (e.seq > this.state.lastSeq) {
      this.state.lastSeq = e.seq;
      if (e.type === 'epoch' && !this.state.epochStarts.some(x => x.epoch === e.epoch)) this.state.epochStarts.push({ epoch: e.epoch, t: e.t, cause: e.cause });
      if (NOTABLE.has(e.type) && (e.type !== 'extinction' || (e.peak || 0) >= 150)) this.state.queue.push({ ...e, at: this.now() }); // only notable extinctions
    }
    this.state.queue = this.state.queue.filter(e => this.now() - e.at < 12 * HOUR).slice(-10);
    this.latest = summary;
    if (!this.enabled || this.busy || this.state.halted) return;
    const now = this.now(), last = this.state.last;
    const unnamed = (summary.species || []).filter(s => s.established && !this.state.names[s.id]);
    let job = null;
    const epochDue = !this.state.epochs[summary.epoch] && (summary.epoch > 1 || summary.t > 6 * 3600) && now - (last.epoch || 0) > 30 * 60000;
    if (this.state.queue.length && now - (last.story || 0) > 30 * 60000) job = () => this.story(this.state.queue.shift());
    else if (epochDue) job = () => this.nameEpoch(summary);
    else if (now - (last.paper || 0) > 23 * HOUR && summary.t > 6 * 3600) job = () => this.paper(summary); // the daily paper before naming
    else if (unnamed.length && now - (last.names || 0) > 30 * 60000) job = () => this.nameSpecies(unnamed.slice(0, 6));
    else if (now - (last.looks || 0) > 15 * 60000) { // species named before the artist came get their looks, a few at a time
      const bare = (summary.species || []).filter(s => s.established && this.state.names[s.id] && !this.state.names[s.id].look);
      if (bare.length) job = () => this.dress(bare.slice(0, 6));
    }
    if (!job) { this.reason = 'quiet'; return; }
    this.busy = true;
    job().catch(e => { this.reason = 'error'; console.error('chronicler:', e.message); }).finally(() => { this.busy = false; try { this.save(); } catch {} });
  }

  describe(s) {
    const parts = {}; for (const m of s.modules || []) parts[PARTS[m]] = (parts[PARTS[m]] || 0) + 1;
    const parent = s.parent && this.state.names[s.parent];
    const swims = (s.modules || []).includes(2), eats = (s.modules || []).includes(1), photo = (s.modules || []).filter(m => m === 0).length;
    const bodyPlan = !swims && !eats ? ['rosette of leaves', 'filament, a chain of cells', 'branching bush that overtops the others', 'kelp with long fronds', 'creeping runner along the bottom', 'floating spherical colony', 'diatom in a glass shell'][s.form || 0]
        + ((s.pig || 0) > .2 ? (s.pig < .5 ? ', brown pigment' : ', red pigment (a deep-water plant)') : ', green')
      : (s.sym > 0 ? `radial, ${s.sym} rays` : s.elong > 1.8 ? 'bilateral, long and slender' : s.elong < .95 ? 'bilateral, round' : 'bilateral') + (s.seg > 1 ? `, a chain of ${s.seg} segments` : '');
    return { id: s.id, body: parts, bodyPlan, lifeForm: !swims && eats ? 'sessile, catches what passes by' : !swims ? 'sessile, rooted in place, lives on light' : photo * 2 > (s.modules || []).length ? 'swimming, but lives mostly on light' : 'free-swimming animal', diet: s.diet <= .3 ? 'plant food' : s.diet >= .7 ? 'animal food' : 'mixed', measuredRole: s.role || 'undetermined',
      living: s.count, peak: s.peak, ageHours: Math.round(((this.latest?.t ?? s.born) - s.born) / 3600), descendsFrom: parent ? parent.latin : null, epoch: s.epoch,
      parentLook: parent?.look ? { pattern: PATTERNS[parent.look.p], density: parent.look.d, contrast: parent.look.c, hue: parent.look.h, light: parent.look.l } : undefined };
  }
  async nameSpecies(list) {
    const ask = { task: 'Name each species like a field naturalist. latin: a binomial built only from Latin or Greek roots (no English words), genus capitalised, at most 28 letters, unique among the given and existing names, for example "Phycodora lenta" or "Stomatops ferox"; species of one lineage may share a genus. en/ru: a natural common name of two or three words, as a naturalist would say it (Russian must be idiomatic Russian, not a transliteration). en_note/ru_note: one plain sentence about its body and way of life, using only the given facts; never call a sessile species drifting or swimming. ' + LOOK_TASK,
      shape: { names: [{ id: 0, latin: '', en: '', ru: '', en_note: '', ru_note: '', look: { pattern: 'spots', density: .5, contrast: .5, hue: .5, light: .5 } }] }, existing: Object.values(this.state.names).slice(-40).map(n => n.latin), species: list.map(s => this.describe(s)) };
    const out = await this.call(ask, 'names');
    if (!out || !Array.isArray(out.names)) return;
    const ids = new Set(list.map(s => s.id)), taken = new Set(Object.values(this.state.names).map(n => n.latin.toLowerCase()));
    for (const n of out.names) {
      if (!ids.has(n.id)) continue;
      const latin = clean(n.latin, 32), en = clean(n.en, 48), ru = clean(n.ru, 48), en_note = clean(n.en_note, 220), ru_note = clean(n.ru_note, 220);
      if (!latin || !en || !ru || !en_note || !ru_note || /\d/.test(latin) || taken.has(latin.toLowerCase())) continue;
      taken.add(latin.toLowerCase());
      this.state.names[n.id] = { latin, en, ru, en_note, ru_note, at: this.now() };
      const look = cleanLook(n.look); if (look) this.state.names[n.id].look = look;
    }
  }
  async dress(list) {
    const ask = { task: 'Give each of these named species of the ocean its look. ' + LOOK_TASK, shape: { looks: [{ id: 0, look: { pattern: 'spots', density: .5, contrast: .5, hue: .5, light: .5 } }] },
      species: list.map(s => ({ ...this.describe(s), name: this.state.names[s.id].latin })) };
    const out = await this.call(ask, 'looks');
    if (!out || !Array.isArray(out.looks)) return;
    const ids = new Set(list.map(s => s.id));
    for (const x of out.looks) { const look = cleanLook(x?.look); if (ids.has(x?.id) && look && this.state.names[x.id]) this.state.names[x.id].look = look; }
  }
  async story(event) {
    const s = this.latest, facts = { event, worldHours: Math.round(s.t / 3600), epoch: s.epoch, roles: s.roles, livingSpecies: s.living,
      species: event.species ? (this.state.names[event.species]?.latin || `species ${event.species}`) : null,
      speciesBody: event.species ? this.describe((s.species || []).find(x => x.id === event.species) || { modules: [] }) : null };
    const out = await this.call({ task: 'Write a short story about this event for the chronicle: title (max 70 characters) and body (two or three sentences, max 420 characters), in English and Russian. Say plainly what happened and why it matters in this ocean.',
      shape: { en: { title: '', body: '' }, ru: { title: '', body: '' } }, facts }, 'story');
    const text = this.bilingual(out, 70, 460);
    if (text) this.state.stories.push({ id: `${event.type}-${event.seq}`, type: event.type, t: event.t, at: this.now(), ...text });
    this.state.stories = this.state.stories.slice(-60);
  }
  async nameEpoch(s) {
    const start = (s.events || []).findLast?.(e => e.type === 'epoch' && e.epoch === s.epoch);
    const facts = { epoch: s.epoch, beganBecause: start ? start.cause : 'the opening of the world', worldHours: Math.round(s.t / 3600), roles: s.roles,
      leadingSpecies: (s.species || []).filter(x => x.established).slice(0, 5).map(x => ({ name: this.state.names[x.id]?.latin || `species ${x.id}`, ...this.describe(x) })),
      previousEpochs: Object.entries(this.state.epochs).map(([k, v]) => ({ epoch: Number(k), name: v.en.name })), recentStories: this.state.stories.slice(-5).map(x => x.en.title) };
    const out = await this.call({ task: 'Name this epoch of the ocean the way geologists and naturalists name ages, after what characterises its life (for example "The Age of Armoured Grazers"). name: at most 44 characters; note: one sentence (max 220 characters) on why. English and Russian; Russian must be natural, for example «Век панцирных пастухов».',
      shape: { en: { name: '', note: '' }, ru: { name: '', note: '' } }, facts }, 'epoch');
    const ok = l => out?.[l] && clean(out[l].name, 48) && clean(out[l].note, 240) && !/\d/.test(out[l].name);
    if (ok('en') && ok('ru')) this.state.epochs[s.epoch] = { en: { name: out.en.name.trim(), note: out.en.note.trim() }, ru: { name: out.ru.name.trim(), note: out.ru.note.trim() }, at: this.now(), t: s.t };
  }
  async paper(s) {
    const recent = this.state.stories.filter(x => x.at > this.now() - DAY).map(x => x.en.title);
    const facts = { worldDays: Math.floor(s.t / 86400) + 1, epoch: s.epoch, roles: s.roles, livingSpecies: s.living, counters: s.counters,
      topSpecies: (s.species || []).slice(0, 6).map(x => ({ name: this.state.names[x.id]?.latin || `species ${x.id}`, ...this.describe(x) })), storiesToday: recent };
    const out = await this.call({ task: 'Write today\'s issue of the ocean\'s newspaper: a headline (max 80 characters) and three short items (each max 260 characters) about the state of the ocean, its leading species and today\'s events. English and Russian.',
      shape: { en: { headline: '', items: ['', '', ''] }, ru: { headline: '', items: ['', '', ''] } }, facts }, 'paper');
    const ok = l => out?.[l] && clean(out[l].headline, 90) && Array.isArray(out[l].items) && out[l].items.length >= 2 && out[l].items.every(i => clean(i, 300));
    if (ok('en') && ok('ru')) this.state.papers = [...this.state.papers, { day: Math.floor(s.t / 86400) + 1, at: this.now(), en: { headline: out.en.headline.trim(), items: out.en.items.slice(0, 3).map(i => i.trim()) }, ru: { headline: out.ru.headline.trim(), items: out.ru.items.slice(0, 3).map(i => i.trim()) } }].slice(-30);
  }
  bilingual(out, t, b) {
    const en = out?.en, ru = out?.ru;
    const v = x => x && clean(x.title, t) && clean(x.body, b) && !/\d/.test(x.body);
    if (!v(en) || !v(ru) || !/[а-яё]/i.test(ru.body)) return null;
    return { en: { title: en.title.trim(), body: en.body.trim() }, ru: { title: ru.title.trim(), body: ru.body.trim() } };
  }

  async request(endpoint, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000); // the model can be slow
    try {
      const res = await this.fetch(`https://api.venice.ai/api/v1/${endpoint}`, { method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (!res.ok) { await res.body?.cancel(); throw Error(`api ${res.status}`); }
      const text = await res.text(); if (text.length > 600000) throw Error('api size');
      return JSON.parse(text);
    } finally { clearTimeout(timer); }
  }
  async call(payload, kind) {
    const now = this.now();
    this.state.last[kind] = now; // one attempt per interval, success or not
    const refuse = reason => { this.reason = reason; if (kind === 'paper') this.state.last.paper = now - 22 * HOUR; return null; }; // a refused paper is retried in an hour
    const catalogue = await this.request('models?type=text');
    const p = catalogue.data?.find(m => m.id === this.model)?.model_spec?.pricing;
    const input = Math.max(p?.input?.usd ?? NaN, p?.input?.diem ?? NaN), output = Math.max(p?.output?.usd ?? NaN, p?.output?.diem ?? NaN);
    if (!(input >= 0 && output >= 0 && input <= INPUT_CEILING && output <= OUTPUT_CEILING)) return refuse('pricing');
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(payload) }];
    const inputBound = Buffer.byteLength(JSON.stringify(messages)) + 1024;
    const reserved = (inputBound * input + MAX_OUTPUT * output) / 1e6 * 1.25;
    const day = this.state.ledger.filter(r => r.at > now - DAY);
    if (day.length >= MAX_CALLS || day.reduce((s, r) => s + (r.reported ?? r.reserved), 0) + reserved > this.limit) return refuse('budget');
    const entry = { at: now, kind, reserved, reported: null };
    this.state.ledger = [...this.state.ledger.filter(r => r.at > now - 8 * DAY), entry];
    this.save(); // durable before transmission; failed calls are never refunded
    this.reason = 'writing';
    const res = await this.request('chat/completions', { model: this.model, messages, max_tokens: MAX_OUTPUT, max_completion_tokens: MAX_OUTPUT, temperature: .6, n: 1, stream: false,
      response_format: { type: 'json_object' }, venice_parameters: { include_venice_system_prompt: false, enable_web_search: 'off', disable_thinking: true } });
    const u = res.usage;
    if (!u || !(u.prompt_tokens >= 0) || !(u.completion_tokens >= 0) || u.prompt_tokens > inputBound || u.completion_tokens > MAX_OUTPUT) { this.state.halted = true; this.reason = 'billing'; return null; }
    entry.reported = res.cost && Number.isFinite(res.cost.usd) ? res.cost.usd + (Number.isFinite(res.cost.diem) ? res.cost.diem : 0) : (u.prompt_tokens * input + u.completion_tokens * output) / 1e6;
    if (entry.reported > reserved) { this.state.halted = true; this.reason = 'billing'; return null; }
    this.reason = 'ready';
    const choice = res.choices?.[0]; if (choice?.finish_reason !== 'stop') return null;
    try { return JSON.parse(choice.message.content); } catch { return null; }
  }
}
