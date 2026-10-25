import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Discoveries } from '../lib/discoveries.mjs';

const summary = { t: 100, species: [{ id: 5, established: true, count: 20 }, { id: 6, established: false, count: 3 }] };
const fresh = () => new Discoveries(fs.mkdtempSync(path.join(os.tmpdir(), 'disc-')));

test('the first valid claim on an established species wins and persists', () => {
  const d = fresh();
  assert.equal(d.claim(5, [1, 2, 3], summary), true);
  assert.equal(d.claim(5, [4, 4, 4], summary), false);
  assert.deepEqual(new Discoveries(path.dirname(d.file)).for([5])[5].who, [1, 2, 3]);
});

test('claims with free text, bad indices or unestablished species are refused', () => {
  const d = fresh();
  assert.equal(d.claim(5, ['<b>me</b>', 1, 1], summary), false);
  assert.equal(d.claim(5, [16, 0, 1], summary), false);
  assert.equal(d.claim(5, [0, 0, 100], summary), false);
  assert.equal(d.claim(6, [0, 0, 1], summary), false);
  assert.equal(d.claim(7, [0, 0, 1], summary), false);
});
