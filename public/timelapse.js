// "The last day in 30 seconds": the whole world from above, replayed from the
// server's keyframes. Trails show where herds went; the night side sweeps across.
const DAY = 900, TAU = Math.PI * 2;
const ROLE_COLOR = ['#4fbf6a', '#59a8f0', '#ff6a3d', '#e2b14a', '#9aa7ab'];

function parse(buf) {
  const dv = new DataView(buf);
  if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== 'TLP1') throw Error('Unknown time-lapse format');
  const world = dv.getUint16(4, true), A = dv.getUint16(6, true), frames = [];
  let plants = null;
  for (let o = 8; o + 4 <= buf.byteLength;) {
    const len = dv.getUint32(o, true), p = o + 4; o = p + len;
    if (o > buf.byteLength) break;
    const t = dv.getUint32(p, true), na = dv.getUint16(p + 4, true), np = dv.getUint16(p + 6, true);
    const counts = [0, 1, 2, 3, 4].map(i => dv.getUint16(p + 8 + i * 2, true));
    const animals = new Uint8Array(buf, p + 18, na * 4);
    if (np) plants = new Uint8Array(buf, p + 18 + na * 4, np * 3);
    const algae = new Uint8Array(buf, p + 18 + na * 4 + np * 3, A * A);
    frames.push({ t, counts, animals, plants, algae });
  }
  return { world, A, frames };
}

export class Timelapse {
  constructor(root, text) {
    this.root = root; this.text = text; this.canvas = root.querySelector('canvas'); this.ctx = this.canvas.getContext('2d');
    this.algae = document.createElement('canvas'); this.trail = document.createElement('canvas');
    this.playing = false; this.pos = 0; this.duration = 30;
    root.querySelector('.tl-close').addEventListener('click', () => this.close());
    root.querySelector('.tl-play').addEventListener('click', () => { this.playing = !this.playing; if (this.pos >= 1) this.pos = 0; this.label(); });
    const bar = root.querySelector('.tl-bar');
    const seek = e => { const r = bar.getBoundingClientRect(); this.pos = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); this.clearTrail = true; };
    bar.addEventListener('pointerdown', e => { bar.setPointerCapture(e.pointerId); seek(e); bar.onpointermove = seek; });
    bar.addEventListener('pointerup', () => { bar.onpointermove = null; });
    addEventListener('keydown', e => { if (!this.root.hidden && e.key === 'Escape') this.close(); });
  }
  async open() {
    this.root.hidden = false; this.root.querySelector('.tl-status').textContent = this.text().loading;
    try {
      const res = await fetch('api/timelapse', { cache: 'no-store' });
      if (!res.ok) throw Error(res.status);
      this.data = parse(await res.arrayBuffer());
      if (this.data.frames.length < 3) { this.root.querySelector('.tl-status').textContent = this.text().tooShort; return; }
      this.root.querySelector('.tl-status').textContent = '';
      this.sparkline(); this.pos = 0; this.playing = true; this.clearTrail = true; this.label();
      this.last = performance.now(); requestAnimationFrame(this.frame);
    } catch { this.root.querySelector('.tl-status').textContent = this.text().failed; }
  }
  close() { this.root.hidden = true; this.playing = false; this.data = null; }
  label() { this.root.querySelector('.tl-play').textContent = this.playing ? '❚❚' : '▶'; this.root.querySelector('.tl-play').setAttribute('aria-label', this.playing ? this.text().pause : this.text().play); }
  sparkline() {
    const svg = this.root.querySelector('.tl-spark'), f = this.data.frames, max = Math.max(1, ...f.map(x => x.counts[1] + x.counts[2]));
    const line = k => f.map((x, i) => `${i ? 'L' : 'M'}${(i / (f.length - 1) * 1000).toFixed(1)},${(40 - x.counts[k] / max * 36).toFixed(1)}`).join('');
    svg.innerHTML = `<path d="${line(1)}" fill="none" stroke="${ROLE_COLOR[1]}" stroke-width="2" vector-effect="non-scaling-stroke"/><path d="${line(2)}" fill="none" stroke="${ROLE_COLOR[2]}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  }
  frame = now => {
    if (!this.data || this.root.hidden) return;
    requestAnimationFrame(this.frame);
    const dt = Math.max(0, Math.min(.1, (now - this.last) / 1000)); this.last = now; // rAF time can precede open()
    if (this.playing) { this.pos += dt / this.duration; if (this.pos >= 1) { this.pos = 1; this.playing = false; this.label(); } }
    this.draw();
  };
  draw() {
    const { frames, A } = this.data, i = Math.max(0, Math.min(frames.length - 1, Math.floor(this.pos * (frames.length - 1)))), f = frames[i];
    const dpr = Math.min(2, devicePixelRatio || 1), cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(cw * dpr)) { this.canvas.width = Math.round(cw * dpr); this.canvas.height = Math.round(ch * dpr); this.clearTrail = true; }
    const S = Math.min(this.canvas.width, this.canvas.height), ox = (this.canvas.width - S) / 2, oy = (this.canvas.height - S) / 2, ctx = this.ctx;
    // algae as an upscaled image
    this.algae.width = this.algae.height = A;
    const a = this.algae.getContext('2d'), img = a.createImageData(A, A);
    for (let k = 0; k < A * A; k++) { const v = f.algae[k] / 255, y = A - 1 - Math.floor(k / A), x = k % A, o = (y * A + x) * 4; img.data[o] = 10 + 40 * v; img.data[o + 1] = 30 + 140 * v; img.data[o + 2] = 45 + 80 * v; img.data[o + 3] = 255; }
    a.putImageData(img, 0, 0);
    // trails: fade the previous picture, then add this frame's animals
    if (this.trail.width !== S) { this.trail.width = this.trail.height = S; this.clearTrail = true; }
    const tr = this.trail.getContext('2d');
    if (this.clearTrail) { tr.clearRect(0, 0, S, S); this.clearTrail = false; }
    tr.globalCompositeOperation = 'destination-out'; tr.fillStyle = 'rgba(0,0,0,.16)'; tr.fillRect(0, 0, S, S);
    tr.globalCompositeOperation = 'lighter';
    const n = f.animals.length / 4, px = S / 256;
    for (let k = 0; k < n; k++) {
      const x = (f.animals[k * 4] + .5) * px, y = S - (f.animals[k * 4 + 1] + .5) * px, role = f.animals[k * 4 + 3] >> 5, size = (f.animals[k * 4 + 3] & 31) / 6;
      tr.fillStyle = role === 2 ? 'rgba(255,106,61,.95)' : `hsla(${Math.round(f.animals[k * 4 + 2] / 255 * 360)}, 75%, 66%, .8)`;
      const r = Math.max(1.1 * dpr, size * px * .9 * (role === 2 ? 1.6 : 1));
      tr.beginPath(); tr.arc(x, y, r, 0, TAU); tr.fill();
    }
    ctx.fillStyle = '#02070a'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = true; ctx.drawImage(this.algae, ox, oy, S, S);
    if (f.plants) { ctx.fillStyle = 'rgba(110, 200, 120, .55)'; for (let k = 0; k < f.plants.length; k += 3) ctx.fillRect(ox + f.plants[k] * px, oy + S - f.plants[k + 1] * px, Math.max(1, px * .8), Math.max(1, px * .8)); }
    // night side, from the same day formula as the world
    const dayFrac = (f.t / DAY) % 1;
    for (let s = 0; s < 64; s++) { const d = Math.max(0, Math.min(1, .2 + .8 * Math.cos(TAU * ((s + .5) / 64 - dayFrac)))); ctx.fillStyle = `rgba(0, 4, 12, ${(1 - d) * .55})`; ctx.fillRect(ox + s * S / 64, oy, S / 64 + 1, S); }
    ctx.drawImage(this.trail, ox, oy);
    const t = this.text(), h = Math.floor(f.t / 3600);
    this.root.querySelector('.tl-time').textContent = `${t.day} ${Math.floor(h / 24) + 1} · ${String(h % 24).padStart(2, '0')}:${String(Math.floor(f.t % 3600 / 60)).padStart(2, '0')}`;
    this.root.querySelector('.tl-counts').textContent = `${f.counts[1]} ${t.grazers} · ${f.counts[2]} ${t.predators} · ${f.counts[0]} ${t.plants}`;
    this.root.querySelector('.tl-head').style.left = (this.pos * 100).toFixed(2) + '%';
  }
}
