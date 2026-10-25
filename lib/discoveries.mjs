// "First discoverer": the first visitor to open the card of an established species
// is recorded under a generated pseudonym. Visitors never type text; they send three
// indices into fixed word lists, so nothing anyone writes appears on the page.
import fs from 'node:fs';
import path from 'node:path';

export const ADJECTIVES = 16, NOUNS = 16, NUMBERS = 99;

export class Discoveries {
  constructor(dir) {
    this.file = path.join(dir, 'discoveries.json');
    try { this.map = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.map = {}; }
  }
  save() { const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.map), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  valid(who) { return Array.isArray(who) && who.length === 3 && Number.isInteger(who[0]) && who[0] >= 0 && who[0] < ADJECTIVES && Number.isInteger(who[1]) && who[1] >= 0 && who[1] < NOUNS && Number.isInteger(who[2]) && who[2] >= 1 && who[2] <= NUMBERS; }
  // Returns true when this claim became the record.
  claim(species, who, summary, now = Date.now()) {
    if (!this.valid(who) || !Number.isInteger(species) || this.map[species]) return false;
    const sp = summary?.species?.find(s => s.id === species);
    if (!sp || !sp.established || sp.count <= 0) return false;
    this.map[species] = { who, at: now, t: Math.round(summary.t) };
    this.save(); return true;
  }
  for(ids) { const out = {}; for (const id of ids) if (this.map[id]) out[id] = this.map[id]; return out; }
}
