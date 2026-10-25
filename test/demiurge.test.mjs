import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Demiurge, cleanDesign, genomeOf } from '../lib/demiurge.mjs';
import { Chronicler } from '../lib/chronicler.mjs';
import { World, HZ } from '../lib/world.mjs';
import { Rng } from '../lib/rng.mjs';
import { phenotype } from '../lib/genome.mjs';

const hunter = { latin: 'Raptoria nocturna', en: 'Night stalker', ru: 'Ночной охотник', en_note: 'A long hunter with tentacles.', ru_note: 'Длинный охотник со щупальцами.',
  lifestyle: 'hunter', region: 'slopes', count: 20, diet: .9,
  body: { organs: [{ type: 'mouth', size: .8, place: 'front' }, { type: 'cilia', size: .7, place: 'rear' }, { type: 'eye', size: .4, place: 'front' }, { type: 'tentacle', size: .4, place: 'front' }], symmetry: 'bilateral', length: 1.9, segments: 1 },
  look: { pattern: 'stripes', density: .5, contrast: .7, hue: .8, light: .25 } };
const kelp = { latin: 'Laminaria rubra', en: 'Red kelp', ru: 'Красная ламинария', en_note: 'Kelp of the slopes.', ru_note: 'Ламинария склонов.', lifestyle: 'plant', region: 'slopes', count: 15,
  body: { organs: [{ type: 'chloroplast', size: .6 }, { type: 'chloroplast', size: .5 }, { type: 'mouth', size: .5, place: 'front' }], form: 'kelp', pigment: .8, leaf: .4 }, look: { pattern: 'rim', density: .4, contrast: .6, hue: .1, light: .6 } };

test('designs are checked: only the vocabulary, bounded sizes, plants without mouths', () => {
  const d = cleanDesign(hunter); assert.ok(d && d.organs.length === 4 && d.diet === .9 && d.sym === 0 && d.elong === 1.9);
  const k = cleanDesign(kelp); assert.ok(k && k.organs.every(o => o.t === 0) && k.form === 3, 'the mouth was dropped from the plant');
  assert.equal(cleanDesign({ ...hunter, body: { organs: [{ type: 'laser', size: 1 }] } }), null);
  assert.equal(cleanDesign({ ...hunter, latin: '<script>' }), null);
  assert.equal(cleanDesign({ ...hunter, body: { organs: Array(10).fill({ type: 'armour', size: 1.5 }) } }), null, 'too heavy');
  assert.equal(cleanDesign({ ...hunter, body: { organs: [{ type: 'eye', size: .5 }] } }), null, 'an animal must eat or swim');
  const g = genomeOf(d, new Rng(3)); assert.ok(g && phenotype(g).acts && phenotype(g).tent > 0);
  assert.ok(genomeOf(k, new Rng(3)) && !phenotype(genomeOf(k, new Rng(3))).acts);
});

test('immigrants arrive from the sediment: matter is kept, a new species is founded', () => {
  const w = new World({ seed: 71, plants: 300, grazers: 30 });
  for (let i = 0; i < HZ * 60; i++) w.step();
  const m0 = w.matter(), g = genomeOf(cleanDesign(hunter), w.rng), r = w.immigrate(g, 20, 'slopes', { by: 'demiurge' });
  assert.ok(r && r.made === 20 && w.species.get(r.species).immigrant);
  assert.ok(Math.abs(w.matter() - m0) / m0 < 1e-9, 'matter is kept');
  for (let i = 0; i < HZ * 60; i++) w.step();
  assert.ok(w.events.some(e => e.type === 'immigration'));
});

test('a session: budget reserved first, designs checked, names and the dispatch recorded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-'));
  const catalogue = { data: [{ id: 'claude-sonnet-5-5', model_spec: { pricing: { input: { usd: 2 }, output: { usd: 10 } } } }] };
  const answer = { dispatch: { en: { title: 'Hunters on the current', body: 'A night stalker arrived.' }, ru: { title: 'Охотники на течении', body: 'Прибыл ночной охотник.' } },
    immigrants: [hunter, { ...kelp, latin: 'Bad <name>' }], weather: { kind: 'storm', why: 'stir the shallows' } };
  let ledgerAtSend = null;
  const fetchImpl = async (url, opts) => {
    if (opts.body) ledgerAtSend = JSON.parse(fs.readFileSync(path.join(dir, 'demiurge.json'), 'utf8')).ledger.length;
    const body = url.includes('models') ? catalogue : { usage: { prompt_tokens: 3000, completion_tokens: 900 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const env = { EPOCHS_AI_ENABLED: '1', VENICE_API_KEY: 'k' }, chronicler = new Chronicler({ dir, env, fetchImpl: async () => { throw Error('no'); } });
  let applied = null;
  const d = new Demiurge({ dir, env, fetchImpl, chronicler, apply: async (designs, weather) => { applied = { designs, weather }; return designs.map((_, i) => ({ species: 500 + i, made: 20 })); } });
  await d.session({ t: 90000, epoch: 1, roles: {}, species: [], events: [], trend: [] });
  assert.equal(ledgerAtSend, 1, 'the reservation existed before the paid request');
  assert.equal(applied.designs.length, 1, 'the invalid design was dropped'); assert.equal(applied.weather, 'storm');
  assert.equal(chronicler.state.names[500].latin, 'Raptoria nocturna'); assert.ok(chronicler.state.names[500].look);
  assert.ok(chronicler.state.stories.some(s => s.by === 'demiurge'));
  assert.equal(d.state.sessions.length, 1);
});
