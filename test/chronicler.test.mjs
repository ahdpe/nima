import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Chronicler, cleanLook } from '../lib/chronicler.mjs';

const catalogue = { data: [{ id: 'qwen3-235b-a22b-instruct-2507', model_spec: { pricing: { input: { usd: .15, diem: .15 }, output: { usd: .75, diem: .75 } } } }] };
function api(content, { usage = { prompt_tokens: 900, completion_tokens: 300 }, cost } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, ledger: opts.body ? JSON.parse(fs.readFileSync(path.join(dir, 'chronicle.json'), 'utf8')).ledger.length : null });
    const body = url.includes('models') ? catalogue : { model: 'qwen3-235b-a22b-instruct-2507', usage, cost, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  let dir; return { calls, make: (env = {}) => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chron-')); return new Chronicler({ dir, fetchImpl, env: { EPOCHS_AI_ENABLED: '1', VENICE_API_KEY: 'k', ...env } }); } };
}
const summary = { t: 4000, epoch: 1, roles: { grazer: 10 }, living: 3, counters: {}, events: [],
  species: [{ id: 7, established: true, count: 30, peak: 40, born: 100, epoch: 1, parent: 0, role: 'grazer', modules: [1, 2, 4], diet: .1 }] };
const tick = () => new Promise(r => setTimeout(r, 30));

test('names are written only after the budget is reserved on disk', async () => {
  const a = api({ names: [{ id: 7, latin: 'Velox marinus', en: 'Swift grazer', ru: 'Быстрый пастух', en_note: 'A small swimmer with a mouth and one eye.', ru_note: 'Небольшой пловец со ртом и одним глазом.' }] });
  const c = a.make(); c.observe(summary); await tick();
  assert.equal(c.state.names[7].latin, 'Velox marinus');
  const post = a.calls.find(x => x.url.includes('chat'));
  assert.equal(post.ledger, 1, 'reservation existed before the paid request');
  assert.ok(c.decorate(summary).names[7]);
});

test('invalid names and text are rejected', async () => {
  const a = api({ names: [{ id: 7, latin: 'Velox <b>', en: 'x', ru: 'y', en_note: 'n', ru_note: 'n' }, { id: 99, latin: 'Other one', en: 'a', ru: 'б', en_note: 'n', ru_note: 'н' }] });
  const c = a.make(); c.observe(summary); await tick();
  assert.deepEqual(c.state.names, {});
});

test('the daily limit stops calls before anything is sent', async () => {
  const a = api({ names: [] });
  const c = a.make({ EPOCHS_AI_DAILY_USD: '0.0001' }); c.observe(summary); await tick();
  assert.equal(a.calls.filter(x => x.url.includes('chat')).length, 0);
  assert.equal(c.reason, 'budget');
});

test('a bill larger than the reservation halts the chronicler', async () => {
  const a = api({ names: [] }, { cost: { usd: 5, diem: 0 } });
  const c = a.make(); c.observe(summary); await tick();
  assert.equal(c.state.halted, true);
});

test('disabled without a key: no network at all', async () => {
  const a = api({});
  const c = a.make({ VENICE_API_KEY: '' }); c.observe(summary); await tick();
  assert.equal(a.calls.length, 0);
});

test('an epoch gets one name, in both languages', async () => {
  const a = api({ en: { name: 'The Age of Swift Grazers', note: 'Grazers with eyes spread over every bank.' }, ru: { name: 'Век быстрых пастухов', note: 'Зрячие травоядные расселились по всем отмелям.' } });
  const c = a.make(); c.observe({ ...summary, t: 40000, species: [] }); await tick();
  assert.equal(c.state.epochs[1].ru.name, 'Век быстрых пастухов');
  assert.equal(c.decorate({ ...summary }).epochNames[1].en.name, 'The Age of Swift Grazers');
});

test('the artist: a species gets a look only from the fixed vocabulary', async () => {
  assert.deepEqual(cleanLook({ pattern: 'stripes', density: .4, contrast: 2, hue: 1.25, light: .3 }), { p: 2, d: .4, c: 1, h: .25, l: .3 });
  assert.equal(cleanLook({ pattern: '<script>', density: .4, contrast: .5, hue: .2, light: .3 }), null);
  assert.equal(cleanLook({ pattern: 'spots', density: 'x', contrast: .5, hue: .2, light: .3 }), null);
  const a = api({ names: [{ id: 7, latin: 'Velox marinus', en: 'Swift grazer', ru: 'Быстрый пастух', en_note: 'A small swimmer.', ru_note: 'Небольшой пловец.',
    look: { pattern: 'rings', density: .6, contrast: .7, hue: .55, light: .4 } }] });
  const c = a.make(); c.observe(summary); await tick();
  assert.deepEqual(c.state.names[7].look, { p: 4, d: .6, c: .7, h: .55, l: .4 });
});
