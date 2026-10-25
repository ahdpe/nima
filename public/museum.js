// The museum of forms: every body plan that has arisen in the ocean, in the order it appeared,
// each drawn from the first species that had it. A plan is the body's construction (symmetry or
// length, segments, a sessile life, tentacles, spines, armour; for plants the growth form and
// its weapons); the finer mix of organs is visible in the portrait itself.
import { Renderer, MOD } from './render.js';
import { drawBody, radius, halos, looks } from './bodies.js';

const TENTACLE = 7, SPINE = 8, ARMOR = 3, FLAGELLUM = 2;
const hueCss = h => `hsl(${Math.round(h * 360)}, 62%, 62%)`;

export function planOf(p) {
  const has = t => p.m.some(m => m[0] === t);
  if (!p.acts) { // plants: growth form, weapons, pigment (green, brown, red) and leaf (narrow, ordinary, broad)
    const pig = (p.pig || 0) > .2 ? ((p.pig < .5) ? 1 : 2) : 0, leaf = (p.leaf ?? .5) < .3 ? 0 : (p.leaf ?? .5) > .7 ? 2 : 1;
    return { kind: 'plant', form: p.form || 0, thorns: has(ARMOR), needles: has(SPINE), pig, leaf, key: `p${p.form || 0}${has(ARMOR) ? 'a' : ''}${has(SPINE) ? 's' : ''}g${pig}l${leaf}` };
  }
  const shape = p.sym > 0 ? 'r' + p.sym : p.elong > 1.8 ? 'long' : p.elong < .95 ? 'round' : 'bi';
  const plan = { kind: 'animal', shape, rays: p.sym, seg: p.seg || 1, sessile: !has(FLAGELLUM), tentacles: has(TENTACLE), spines: has(SPINE), armour: has(ARMOR) };
  plan.key = [shape, plan.seg, plan.sessile ? 's' : '', plan.tentacles ? 't' : '', plan.spines ? 'p' : '', plan.armour ? 'a' : ''].join('|');
  return plan;
}

// Draws portraits with one hidden WebGL renderer and copies each into its own small canvas.
// One hidden portrait renderer for the whole page (the museum and the news ribbon share it).
let sharedPortraits = null;
export const portraitMaker = () => sharedPortraits ??= new Portraits();
class Portraits {
  constructor() {
    this.canvas = document.createElement('canvas'); this.canvas.className = 'portrait-gl'; this.canvas.setAttribute('aria-hidden', 'true');
    document.body.append(this.canvas); this.r = new Renderer(this.canvas);
  }
  draw(p, id, target) {
    const body = { sp: id, hue: p.hue, diet: .5, acts: p.acts, modules: p.m.map(([t, s, a]) => ({ t, s, a })), sym: p.sym, elong: p.elong, seg: p.seg || 1, form: p.form || 0, pig: p.pig || 0, leaf: p.leaf ?? .5 };
    const R = radius(body, 1), has = t => p.m.some(m => m[0] === t), tent = p.m.filter(m => m[0] === TENTACLE).reduce((a, m) => a + m[1], 0);
    let E, x = 0;
    if (!p.acts) E = [R * 1.2 * (has(SPINE) ? 1.9 : has(ARMOR) ? 1.4 : 1), 5.8, 2.7 * R, 4.2 * R, 10.5, 1.9 * R, 2 * R][p.form || 0];
    if (!p.acts && p.form === 3) x = -1.9 * R; // kelp fronds stream one way from the holdfast
    else {
      const el = p.sym > 0 ? 1 : p.elong, gap = 2 * R * .58 * Math.sqrt(el) * (p.sym > 0 ? 1.05 : .82), chain = ((p.seg || 1) - 1) * gap;
      x = chain / 2; E = Math.max(R * 1.3 + chain / 2 + (tent ? .5 * (.35 * R + 2.2 * tent) : 0) + (has(SPINE) ? 1.2 : 0), R * 1.6);
    }
    const size = this.canvas.clientWidth, zoom = size / 2 / (E * 1.08), time = 1.7 + (id % 7) * .4, r = this.r;
    r.begin(); halos.length = 0;
    drawBody(r, body, -1 - id, x, 0, 0, 1, .8, .4, 0, time, zoom);
    for (const [hx, hy, rad, c, g] of halos) r.push(hx, hy, 0, rad, rad, MOD.GLOW, c[0], c[1], c[2], .55 * g);
    r.draw({ x: 0, y: 0, zoom }, { world: 1536, dayFrac: 0, beltFrac: 0, globalLight: .45 }, time);
    target.getContext('2d').drawImage(this.canvas, 0, 0, target.width, target.height);
  }
}

export class Museum {
  constructor(root, ctx) { // ctx: { T, lang, clock, nameOf }
    this.root = root; this.ctx = ctx;
    root.querySelector('.museum-close').addEventListener('click', () => this.close());
    root.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });
  }
  async open() {
    this.root.hidden = false; const t = this.ctx.T(), status = this.root.querySelector('.museum-status');
    status.textContent = t.museumLoading;
    try {
      const res = await fetch('api/museum', { cache: 'no-store' }); if (!res.ok) throw Error(res.status);
      this.data = await res.json(); status.textContent = this.data.species.length ? '' : t.museumEmpty;
      this.portraits ??= portraitMaker();
      this.draw();
    } catch (e) { console.error('museum:', e); status.textContent = t.museumFailed; }
  }
  close() { this.root.hidden = true; }
  title(plan) {
    const t = this.ctx.T(), w = t.museumWords;
    if (plan.kind === 'plant') return [[w.forms[plan.form], plan.thorns && w.thorns, plan.needles && w.needles].filter(Boolean).join(' '), plan.pig && t.pigments[plan.pig], plan.leaf !== 1 && t.leaves[plan.leaf]].filter(Boolean).join(', ');
    const head = plan.rays ? w.radial.replace('{n}', plan.rays) : w[plan.shape];
    return [head, plan.seg > 1 && w.chain.replace('{n}', plan.seg), plan.sessile && w.sessile, plan.tentacles && w.tentacles, plan.spines && w.spines, plan.armour && w.armour].filter(Boolean).join(', ');
  }
  draw() {
    const t = this.ctx.T(), groups = new Map();
    for (const [id, n] of Object.entries(this.data.names || {})) if (n.look) looks.set(Number(id), n.look);
    for (const s of this.data.species) {
      const plan = planOf(s.portrait); let g = groups.get(plan.key);
      if (!g) groups.set(plan.key, g = { plan, species: [] });
      g.species.push(s);
    }
    let seen = 0; try { seen = Number(localStorage.getItem('epochs-museum-seen')) || 0; } catch {}
    const list = [...groups.values()].map(g => {
      g.species.sort((a, b) => a.born - b.born); g.first = g.species[0];
      g.alive = g.species.reduce((n, s) => n + (s.died ? 0 : s.count || 0), 0); return g;
    }).sort((a, b) => a.first.born - b.first.born);
    const box = this.root.querySelector('.museum-halls'); box.textContent = '';
    const living = list.filter(g => g.alive > 0).length;
    this.root.querySelector('.museum-stats').textContent = t.museumStats.replace('{n}', list.length).replace('{a}', living);
    for (const kind of ['animal', 'plant']) {
      const hall = list.filter(g => g.plan.kind === kind); if (!hall.length) continue;
      const h = document.createElement('h3'); h.className = 'museum-hall'; h.textContent = kind === 'animal' ? t.museumAnimals : t.museumPlants;
      const grid = document.createElement('div'); grid.className = 'museum-grid';
      for (const g of hall) grid.append(this.exhibit(g, seen));
      box.append(h, grid);
    }
    try { localStorage.setItem('epochs-museum-seen', String(this.data.t)); } catch {}
  }
  exhibit(g, seen) {
    const t = this.ctx.T(), f = g.first, card = document.createElement('article'); card.className = 'exhibit';
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 300; canvas.className = 'exhibit-portrait';
    try { this.portraits.draw(f.portrait, f.id, canvas); } catch (e) { console.error('portrait:', e); }
    const title = document.createElement('h4'); title.textContent = this.title(g.plan);
    const first = document.createElement('p'); first.className = 'exhibit-first';
    const dot = document.createElement('span'); dot.className = 'lineage-dot'; dot.style.background = hueCss(f.portrait.hue);
    const name = document.createElement('em'); name.textContent = this.ctx.nameOf(f, this.data.names[f.id]);
    first.append(dot, name, document.createTextNode(` · ${this.ctx.clock(f.born)}`));
    if (f.immigrant) { const tag = document.createElement('span'); tag.className = 'exhibit-tag'; tag.textContent = t.newsImmigrant; first.append(tag); }
    const meta = document.createElement('p'); meta.className = 'exhibit-meta';
    const extinctAt = g.alive ? 0 : Math.max(...g.species.map(s => s.died || 0));
    meta.textContent = [t.museumSpecies.replace('{n}', g.species.length), g.alive ? t.museumAlive.replace('{n}', g.alive) : t.museumExtinct.replace('{when}', this.ctx.clock(extinctAt))].join(' · ');
    if (!g.alive) card.classList.add('extinct');
    if (seen && f.born > seen) { const b = document.createElement('span'); b.className = 'exhibit-new'; b.textContent = t.museumNew; card.append(b); }
    card.append(canvas, title, first, meta);
    return card;
  }
}
