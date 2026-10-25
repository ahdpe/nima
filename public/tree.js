// The tree of life: every established species on a time axis. A line is a species'
// life from its appearance to its extinction (or now); thickness is its peak
// population; a branch joins it to the species it descended from.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const hueCss = (h, l = 62) => `hsl(${Math.round(h * 360)}, 62%, ${l}%)`;

export class TreeOfLife {
  constructor(root, ctx) { // ctx: { T, lang, nameOf, whoText, sameWho, who, clock }
    this.root = root; this.ctx = ctx;
    root.querySelector('.tree-close').addEventListener('click', () => this.close());
    root.querySelector('.td-close').addEventListener('click', () => { root.querySelector('.tree-detail').hidden = true; });
    root.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });
    addEventListener('resize', () => { if (!root.hidden && this.data) this.draw(); });
  }
  async open() {
    this.root.hidden = false; const t = this.ctx.T();
    this.root.querySelector('.tree-status').textContent = t.treeLoading; this.root.querySelector('.tree-detail').hidden = true;
    try {
      const res = await fetch('api/tree', { cache: 'no-store' }); if (!res.ok) throw Error(res.status);
      this.data = await res.json(); this.root.querySelector('.tree-status').textContent = this.data.species.length ? '' : t.treeEmpty; this.draw();
    } catch (e) { console.error('tree:', e); this.root.querySelector('.tree-status').textContent = t.treeFailed; }
  }
  close() { this.root.hidden = true; }
  order() {
    const sp = this.data.species, byId = new Map(sp.map(s => [s.id, s])), kids = new Map();
    for (const s of sp) { const p = byId.has(s.parent) ? s.parent : 0; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(s); }
    for (const list of kids.values()) list.sort((a, b) => a.born - b.born);
    const out = [], walk = id => { for (const s of kids.get(id) || []) { out.push(s); walk(s.id); } };
    walk(0); return { out, byId };
  }
  draw() {
    const { out, byId } = this.order(), now = Math.max(1, this.data.t), t = this.ctx.T(), lang = this.ctx.lang();
    const box = this.root.querySelector('.tree-plot'), W = Math.max(320, box.clientWidth), lane = W < 600 ? 15 : 17, top = 34, left = 12, right = W < 600 ? 92 : 170;
    const H = top + out.length * lane + 30, X = s => left + (s / now) * (W - left - right);
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': t.treeTitle });
    // epochs and day ticks
    const starts = [{ epoch: 1, t: 0 }, ...(this.data.epochEvents || [])].sort((a, b) => a.t - b.t);
    starts.forEach((e, i) => {
      const x0 = X(e.t), x1 = X(starts[i + 1]?.t ?? now);
      if (i % 2) svg.append(el('rect', { x: x0, y: top - 6, width: x1 - x0, height: H - top - 18, fill: 'rgba(231,194,124,.035)' }));
      svg.append(el('line', { x1: x0, x2: x0, y1: 14, y2: H - 22, stroke: 'rgba(231,194,124,.35)', 'stroke-dasharray': '2 4' }));
      const name = this.data.epochNames?.[e.epoch]?.[lang]?.name, label = el('text', { x: x0 + 5, y: 22, class: 'tree-epoch' });
      label.textContent = `${t.epochEyebrow.replace('{n}', e.epoch)}${name ? ' · ' + name : ''}`; svg.append(label);
    });
    const days = Math.floor(now / 86400), every = Math.max(1, Math.ceil(days / 8));
    for (let d = 0; d <= days; d += every) { const x = X(d * 86400), lbl = el('text', { x, y: H - 6, class: 'tree-tick' }); lbl.textContent = `${t.day} ${d + 1}`; svg.append(lbl); }
    const rows = new Map(out.map((s, i) => [s.id, top + i * lane + lane / 2]));
    // branches first, then lives
    for (const s of out) {
      const p = byId.get(s.parent); if (!p) continue;
      const x = X(s.born), y0 = rows.get(p.id), y1 = rows.get(s.id);
      svg.append(el('path', { d: `M${x},${y0} V${y1 - 3} Q${x},${y1} ${x + 3},${y1}`, fill: 'none', stroke: hueCss(s.hue, 55), 'stroke-opacity': .45, 'stroke-width': 1 }));
    }
    for (const s of out) {
      const y = rows.get(s.id), x0 = X(s.born), x1 = X(s.died ?? now), w = Math.min(7, 1.2 + Math.log2(1 + (s.peak || 1)) * .7);
      const g = el('g', { class: 'tree-lane', tabindex: 0, role: 'button' });
      g.append(el('rect', { x: 0, y: y - lane / 2, width: W, height: lane, fill: 'transparent' }));
      g.append(el('line', { x1: x0, x2: Math.max(x0 + 2, x1), y1: y, y2: y, stroke: hueCss(s.hue), 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-opacity': s.died ? .55 : .95 }));
      if (s.died) g.append(el('path', { d: `M${x1 - 3},${y - 3} L${x1 + 3},${y + 3} M${x1 + 3},${y - 3} L${x1 - 3},${y + 3}`, stroke: 'rgba(220,230,226,.5)', 'stroke-width': 1 }));
      else g.append(el('circle', { cx: x1, cy: y, r: w / 2 + 2.5, fill: hueCss(s.hue, 70), class: 'tree-alive' }));
      const label = el('text', { x: x1 + 9, y: y + 3.5, class: s.died ? 'tree-name extinct' : 'tree-name' });
      label.textContent = this.ctx.nameOf(s, this.data.names[s.id]); g.append(label);
      const show = () => this.detail(s, byId); g.addEventListener('click', show); g.addEventListener('keydown', e => { if (e.key === 'Enter') show(); });
      svg.append(g);
    }
    box.textContent = ''; box.append(svg);
  }
  detail(s, byId) {
    const t = this.ctx.T(), lang = this.ctx.lang(), ai = this.data.names[s.id], d = this.root.querySelector('.tree-detail');
    d.hidden = false;
    d.querySelector('.td-name').textContent = this.ctx.nameOf(s, ai);
    d.querySelector('.td-common').textContent = ai ? ai[lang] : '';
    d.querySelector('.td-note').textContent = ai ? ai[lang + '_note'] : t.autoName;
    const parts = new Map(); for (const m of s.modules || []) parts.set(m, (parts.get(m) || 0) + 1);
    const parent = byId.get(s.parent), disc = this.data.discoveries?.[s.id];
    const facts = [
      [t.role, t.roles[s.role || 'none']],
      [t.body, [s.role !== 'producer' ? t.plan(s.sym || 0, s.elong ?? 1.3, s.seg || 1) : t.flora(s.form || 0, s.pig || 0, s.leaf ?? .5), [...parts].map(([k, n]) => (n > 1 ? n + '× ' : '') + t.parts[k]).join(', ')].filter(Boolean).join(' · ')],
      [t.treeLived, `${this.ctx.clock(s.born)} — ${s.died ? this.ctx.clock(s.died) : t.treeNow}`],
      [t.treePeak, String(s.peak ?? '—')],
      [t.treeParent, parent ? this.ctx.nameOf(parent, this.data.names[parent.id]) : t.treeFounder],
      ...(disc ? [[t.treeDiscoverer, this.ctx.sameWho(disc.who, this.ctx.who()) ? t.youDiscovered : this.ctx.whoText(disc.who)]] : [])
    ];
    const dl = d.querySelector('.td-facts'); dl.textContent = '';
    for (const [k, v] of facts) { const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; row.append(dt, dd); dl.append(row); }
    d.querySelector('.td-dot').style.background = hueCss(s.hue);
  }
}
