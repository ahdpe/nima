// WebGL2 renderer. Scene: water (light, depth, algae, toxin) and one instanced pass
// for every body part, drawn into an offscreen buffer; then bloom, grading, grain.
// Decoration (light shafts, caustics, marine snow, membranes' sheen, bloom) is
// styling of the data: positions, organs, sizes, energy, light and algae are real.
export const MOD = { PHOTO: 0, MOUTH: 1, FLAGELLUM: 2, ARMOR: 3, EYE: 4, PHOTOPHORE: 5, FAT: 6, CORE: 7, HALO: 8, BULB: 9, THORN: 10, GLOW: 11, CILIA: 12, ROSETTE: 13, SPINES: 14, TENTACLE: 15, FILAMENT: 16, STEM: 17, FROND: 18, COLONY: 19, DIATOM: 20 };

const QUAD_VS = `#version 300 es
in vec2 p; out vec2 uv; void main(){ uv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`;

const NOISE = `
float hash(vec2 q){ return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 q){ vec2 i = floor(q), f = fract(q); f = f*f*(3.-2.*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 q){ float s = 0., a = .5; for (int i = 0; i < 4; i++) { s += a * noise(q); q = q * 2.03 + 17.1; a *= .5; } return s; }
vec2 voronoi(vec2 x){ vec2 n = floor(x), f = fract(x); float d1 = 8., d2 = 8.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 g = vec2(i, j), o = vec2(hash(n + g), hash(n + g + 31.7));
    float d = length(g + o - f); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
  return vec2(d1, d2); }`;

const OCEAN_FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D fields; uniform vec2 view, center; uniform float zoom, world, time, dayFrac, beltFrac, globalLight;
uniform vec3 storm, band; // weather: storm (strength, direction); warm current (centre x, half-width, strength) as world fractions
const float TAU = 6.2831853;
${NOISE}
void main(){
  vec2 w = center + (uv - .5) * view / zoom;              // world position of this pixel
  vec2 f = fract(w / world);
  vec4 F = texture(fields, f);                              // r algae, g shallow, b detritus, a toxin
  float day = clamp(.2 + .8 * cos(TAU * (f.x - dayFrac)), 0., 1.);
  float belt = .12 + .88 * pow((1. + cos(TAU * (f.y - beltFrac))) * .5, 1.5);
  float bx = fract(f.x - band.x + .5) - .5;
  float light = day * belt * globalLight * (.3 + .7 * F.g) * (1. + .35 * band.z * exp(-bx * bx / (band.y * band.y)));  // the same formula as the server
  float sh = smoothstep(0., 1., F.g);
  // Water: deep navy in the abyss, teal over the banks, warm in sunlight.
  vec3 deep = vec3(.012, .036, .078), shoal = vec3(.022, .14, .17);
  vec3 col = mix(deep, shoal, sh) * (.6 + 1.6 * light);
  col += vec3(.0, .012, .03) * noise(w * .012 + time * .01);        // slow currents in the deep (decoration)
  col += vec3(.09, .07, .03) * light * light;
  col += vec3(.05, .035, .0) * band.z * exp(-bx * bx / (band.y * band.y));  // the warm current's water
  // Decoration, only where it can be seen: light shafts and a caustic net in sunlit water.
  if (light > .03) {
    float shafts = fbm(vec2((w.x + w.y * .45) * .018 + time * .015, time * .02));
    col += vec3(.10, .16, .15) * smoothstep(.45, .85, shafts) * light * .9;
    if (sh > .05) {
      vec2 cv = voronoi(w * .16 + vec2(time * .12, time * .07));
      col += vec3(.18, .26, .22) * pow(clamp(1. - (cv.y - cv.x) * 3.2, 0., 1.), 4.) * light * sh;
    }
  }
  // Algal carpet (data: density), drawn as a living film of cells.
  float a = F.r;
  if (a > .003) {
    vec2 cell = voronoi(w * 1.6 + vec2(0., time * .02));
    float wall = smoothstep(.10, .0, cell.y - cell.x), body = smoothstep(.6, .0, cell.x);
    float tex = .7 + .3 * body + .45 * wall;
    vec3 dayC = vec3(.12, .50, .22), nightC = vec3(.04, .42, .48);
    vec3 algae = mix(nightC * .55, dayC, clamp(light * 1.7, 0., 1.)) * tex;
    col = mix(col, algae * (.35 + 1.3 * light), clamp(a * 1.1, 0., .85));
    col += nightC * (.35 + wall) * a * (1. - day) * .75;     // bioluminescent film at night
  }
  col += vec3(.24, .15, .06) * F.b * .35;                   // detritus haze
  col = mix(col, vec3(.45, .05, .28), F.a * .55);           // toxin
  if (storm.x > 0.) {                                       // a storm: murky streaks driven along the surge
    vec2 sd = storm.yz, sp = vec2(dot(w, sd), dot(w, vec2(-sd.y, sd.x)));
    float streak = noise(vec2(sp.x * .025 - time * 1.1, sp.y * .12)) * .7 + noise(w * .05 + sd * time * .8) * .3;
    col = mix(col, vec3(.2, .21, .16) * (.55 + light), storm.x * .5 * smoothstep(.35, .8, streak)); // silt lifted from the bottom
  }
  // Decoration: marine snow in two depths, drifting slower than the camera moves.
  for (int L = 0; L < 2; L++) {
    float s = L == 0 ? .30 : .55, par = L == 0 ? .35 : .15;
    vec2 sp = (w - center * par) * s + vec2(time * .04, -time * .09) * (1. + float(L));
    vec2 id = floor(sp), fr = fract(sp) - .5 - (vec2(hash(id), hash(id + 7.)) - .5) * .8;
    float speck = smoothstep(.07, .0, length(fr)) * step(.84, hash(id + 3.));
    col += vec3(.12, .16, .17) * speck * (.35 + light) * clamp(zoom * .15, .2, 1.) * (L == 0 ? 1. : .6);
  }
  o = vec4(col, 1.);
}`;

// One instance = one body part: position, rotation, half-size, kind, colour, phase, energy.
const MOD_VS = `#version 300 es
in vec2 corner; in vec2 pos; in float rot; in vec2 half_; in float kind; in vec4 color; in float phase; in float extra; in vec4 deco;
uniform vec2 view, center; uniform float zoom, world, minPx;
out vec2 q; flat out float k; flat out vec4 c; flat out float ph; flat out highp float ex; flat out float px; flat out vec4 dc; // per-instance values must not be interpolated
void main(){
  vec2 d = pos - center; d = mod(d + world * .5, world) - world * .5;   // nearest copy on the torus
  float pad = (kind == 8. || kind == 11.) ? 1. : (kind == 3. || kind == 12.) ? 1.75 : (kind == 13. || kind == 14.) ? 1.04 : 1.3; // cell-wall parts share the body's frame
  vec2 h = max(half_ * zoom, vec2(minPx)) / zoom;
  vec2 local = corner * h * pad;
  float cs = cos(rot), sn = sin(rot);
  vec2 wpos = d + vec2(local.x * cs - local.y * sn, local.x * sn + local.y * cs);
  gl_Position = vec4(wpos * zoom / (view * .5), 0., 1.);
  q = corner * pad; k = kind; c = color; ph = phase; ex = extra; px = min(h.x, h.y) * zoom; dc = deco;
}`;
const MOD_FS = `#version 300 es
precision mediump float;
in vec2 q; flat in float k; flat in vec4 c; flat in float ph; flat in highp float ex; flat in float px; flat in vec4 dc; out vec4 o;
uniform float time;
${NOISE}
// The artist's look of a species (deco): pattern id + density·.99, contrast, hue, lightness.
vec3 hsl2rgb(float h, float s, float l) { vec3 k = mod(vec3(0., 8., 4.) + h * 12., 12.); float a = s * min(l, 1. - l); return l - a * clamp(min(k - 3., 9. - k), -1., 1.); }
// How much of the pattern lies at a point, given in the part's own frame: p, along, across, radial.
float pattern(float id, float dens, vec2 p, float along, float across, float radial) {
  float f = 2.5 + 9. * dens;
  if (id < .5) return 0.;
  if (id < 1.5) { vec2 cv = voronoi(p * f * .5); return smoothstep(.36, .2, cv.x); }                  // spots
  if (id < 2.5) return smoothstep(.15, -.05, abs(fract(along * f * .5) - .5) - .22);                 // stripes across
  if (id < 3.5) return smoothstep(.15, -.05, abs(fract(across * f * .35) - .5) - .25);                // bands lengthwise
  if (id < 4.5) return smoothstep(.15, -.05, abs(fract(radial * f * .6) - .5) - .25);                 // rings
  if (id < 5.5) { vec2 cv = voronoi(p * f * .45); return smoothstep(.13, .02, cv.y - cv.x); }         // net
  if (id < 6.5) return step(.8 - .12 * dens, hash(floor(p * f * 2.2)));                              // speckle
  if (id < 7.5) return smoothstep(.62, .9, radial);                                                   // rim
  return .5 + .5 * sin(along * 3. + across * 5. + time * 1.5);                                        // sheen
}
vec3 dressed(vec3 col, vec2 p, float along, float across, float radial) {
  float id = floor(dc.x); if (id < .5) return col;
  float m = pattern(id, fract(dc.x) * 1.0101, p, along, across, radial) * dc.y, sheen = step(7.5, id);
  vec3 pc = hsl2rgb(dc.z, .7, mix(.16, .78, dc.w));
  return mix(col, pc * (.75 + .5 * dc.w), m * .85 * (1. - sheen)) + pc * m * .45 * sheen;
}
// One whorl of n leaves around the centre: distance to the nearest leaf's edge, the position
// along it (-1 at the base, 1 at the tip) and across it. Leaves are ovate, widest past the middle.
vec3 whorl(vec2 q, float n, float turn, float u0, float len, float wid, float lobes, float depth, float seed) {
  float sect = 6.28318 / n, a = atan(q.y, abs(q.x) < 1e-4 ? 1e-4 : q.x) - turn;
  float kk = floor(a / sect + .5), f = a - kk * sect + sin(time * .8 + kk * 2.3 + seed * 5.) * .035; // each leaf stirs a little
  // No two leaves alike: each has its own length, width and curve, like blades of grass.
  float h1 = fract(sin((kk + seed * 13.) * 91.7) * 43758.5), h2 = fract(sin((kk + seed * 7.) * 47.3) * 24634.6);
  len *= .86 + .28 * h1; wid *= .88 + .24 * h2;
  float rr = length(q); f -= (h2 - .5) * .9 * pow(max(0., (rr - u0) / len), 2.);      // the blade bends to one side
  float u = rr * cos(f), v = rr * sin(f), x = (u - u0) / len * 2. - 1.;
  float hw = wid * len * .5 * sqrt(max(0., 1. - x * x)) * (.62 + .38 * (x + 1.) * .5);
  if (lobes > 0.) hw *= 1. - depth * (.5 + .5 * cos((x + 1.) * lobes * 3.14159)) * step(-.7, x); // lobed or feathery edges
  return vec3(max(abs(v) - hw, (abs(x) - 1.) * len * .5), x, v / max(hw, .001));
}
void main(){
  float aa = 1.6 / max(px, 1.), r = length(q), d = r - 1., alpha = c.a, add = 0.;
  vec3 col = c.rgb;
  // Animal parts pack the body's shape and a fraction into extra: 40 + round(taper·40) for a
  // bilateral body, 100 + rays for a radial one with a scalloped bell margin; plus a fraction.
  float shp = floor(ex), lobes = shp > 99. ? shp - 100. : 0., tp = lobes > 0. ? 0. : (shp - 40.) / 40., fr = ex - shp;
  vec2 eg = vec2(q.x, q.y * (1. + tp * q.x)); float th = atan(eg.y, abs(eg.x) < 1e-4 ? 1e-4 : eg.x); // never atan(0, 0)
  float rho = length(eg) / (1. + (lobes > 0. ? .07 * cos(lobes * th) : 0.));
  float dth = mod(th - ph + 3.14159, 6.28318) - 3.14159;               // angle from a wall part's centre
  if (k == 7.) {                         // animal body: a translucent cell: thin membrane, granular cytoplasm, nucleus
    d = rho - 1.;
    float rim = smoothstep(.78, .99, rho), cells = noise(q * 3.2 + ph * 7.) * .6 + noise(q * 7. - ph) * .4;
    vec2 vg = voronoi(q * 6.5 + ph * 3. + vec2(time * .05, 0.));                   // drifting granules
    float gran = smoothstep(.2, .1, vg.x) * step(.45, noise(q * 2.5 + ph * 9.)) * (1. - rim);
    vec2 nq = q - vec2(-.08, 0.);
    float nuc = smoothstep(.3, .22, length(nq * vec2(1., 1.25))), nucleolus = smoothstep(.09, .04, length(nq - vec2(.04, .03)));
    float vac = smoothstep(.15, .1, length(q - vec2(-.58, .0))) * (.5 + .5 * sin(time * 1.3 + ph * 5.)); // contractile vacuole
    col = c.rgb * (.16 + .26 * cells) + c.rgb * 1.25 * rim * rim * rim + mix(c.rgb, vec3(1.), .5) * gran * .35
        + mix(c.rgb, vec3(.9), .4) * nuc * (.18 + .3 * fr) + vec3(.9) * nucleolus * nuc * .25 + vec3(.5, .7, .8) * vac * .18;
    col = dressed(col, q * 1.6 + ph, q.x, q.y, rho);                        // the species' pattern, by the artist
    alpha = mix(.5, .95, rim) * c.a; add = .2 * rim;
  } else if (k == 12.) {                 // cilia: a band of short hairs beating in a metachronal wave
    float hw = fr * 3.2, t = (rho - .97) / .3;
    float band = smoothstep(hw, hw * .6, abs(dth));
    if (t < 0. || t > 1. || band <= 0.) discard;
    float u = dth * 9.5;                                                   // about 60 cilia around a cell
    float bend = sin(time * 8. - dth * 7. + ph * 3.) * .55 * t * t;     // the stroke travels along the band
    float f = abs(fract(u + bend) - .5), w = .16 * (1. - .55 * t), fw = fwidth(u) * .8;
    float line = 1. - smoothstep(w - fw, w + fw, f);
    float sheen = .5 + .5 * sin(dth * 4. - time * 3. + t * 3.);         // comb rows split light into colour
    vec3 tint = max(col * (.85 + .5 * sheen) + vec3(.25, -.05, .3) * (1. - sheen) * .5, 0.);
    float a = line * band * (1. - .6 * t) * c.a;
    o = vec4(tint * a * 1.2, a * .7); return;
  } else if (k == 3.) {                  // armour: a theca of plates following the cell wall
    float hw = fr * 3.2, mid = 1.035, thick = .085;
    if (abs(rho - mid) > thick + .1) discard;
    d = max(abs(rho - mid) - thick, (abs(dth) - hw) * rho);
    float n = 1. - abs(rho - mid) / thick;
    float seam = smoothstep(.07, .0, abs(fract(dth / .42 + .5) - .5) - .43);
    float pore = smoothstep(.022, .0, length(vec2(fract(dth / .42 + .5) - .5, (rho - mid) * 2.2)) - .03);
    col = c.rgb * (.45 + .6 * sqrt(max(n, 0.))) * (1. - .55 * seam) * (1. - .35 * pore) + vec3(.6, .7, .75) * pow(max(n, 0.), 6.) * .25;
  } else if (k == 13.) {                 // a plant: a rosette of translucent leaves around a glossy heart
    // ph carries the leaf edge: whole lobes plus their depth as a fraction; the turn is the quad's rotation.
    // extra: code (leaves + 10·inner whorl), energy in 32 steps, then the plant's own seed.
    float code = floor(ex), fr = (ex - code) * 32., en = floor(fr) / 31., seed = fract(fr) * 9.7, W = c.a, lobes = floor(ph), depth = ph - lobes;
    float n = mod(code, 10.), inner = floor(code / 10.);
    vec3 o1 = whorl(q, n, 0., .1, .9, W, lobes, depth, seed), o2 = inner > .5 ? whorl(q, n, 3.14159 / n, .08, .56, W * 1.15, lobes, depth * .7, seed + 1.) : vec3(9.);
    vec3 lf = o2.x < 0. ? o2 : o1; float young = o2.x < 0. ? 1. : 0.;
    float x = lf.y, side = lf.z;
    float rib = smoothstep(.12, .0, abs(side)) * step(-.85, x);
    float veins = smoothstep(.1, .0, abs(fract(x * 3.2 - abs(side) * 1.1) - .5) - .38) * (1. - abs(side));
    float edge = smoothstep(-.04, 0., lf.x);
    vec3 leaf = c.rgb * (.5 + .45 * (x + 1.) * .5) * (1. + .25 * young);
    leaf += c.rgb * (.45 * rib + .18 * veins) + mix(c.rgb, vec3(.95, 1., .75), .5) * edge * .55;
    leaf = dressed(leaf, q * 2.2 + seed, (x + 1.) * 1.2, side, (x + 1.) * .5);
    float hr = length(q), heart = hr - .17;
    vec3 core = mix(c.rgb, vec3(1., .92, .58), .6) * (.55 + .7 * en) * (1.15 - hr * 2.) + vec3(.9) * smoothstep(.07, .0, length(q - vec2(-.05, .06))) * .5;
    d = min(min(o1.x, o2.x), heart);
    col = heart < 0. ? core : leaf; alpha = heart < 0. ? 1. : .86 + .14 * edge; add = heart < 0. ? .3 * en : .12 * edge;
  } else if (k == 14.) {                 // thorns: a ring of fine needles between the leaves
    float m = floor(ex), sect = 6.28318 / m, a = atan(q.y, abs(q.x) < 1e-4 ? 1e-4 : q.x) - ph;
    float kk = floor(a / sect + .5), f = a - kk * sect, rr = length(q), u = rr * cos(f), v = rr * sin(f), x = (u - .22) / .78;
    if (x < 0. || x > 1.) discard;
    d = abs(v) - .03 * (1. - x) - .003;
    col = c.rgb * (.7 + .45 * (1. - x));
  } else if (k == 15.) {                 // tentacle: a slow translucent whip set with stinging beads
    if (abs(q.x) > 1.) discard;
    float t = (q.x + 1.) * .5;                                            // 0 at the base, 1 at the tip
    float wave = sin(q.x * 3. - time * 2.4 - ph) * .6 * t * t + sin(q.x * 7. - time * 3.7 + ph) * .12 * t;
    float w = mix(.22, .05, t), dist = abs(q.y - wave);
    float core = smoothstep(w, w * .35, dist), glow = exp(-dist * dist / (w * w * 5.));
    float bead = smoothstep(.45, .15, length(vec2(fract(t * 7.) - .5, (q.y - wave) / max(w, .05) * .45))) * step(.12, t);
    vec3 cc = col * (core * .8 + glow * .2) + mix(col, vec3(1.), .5) * bead * core * .7;
    float a = (core * .8 + glow * .12) * c.a * (1. - .35 * t);
    o = vec4(cc * c.a, a * .9); return;
  } else if (k == 16.) {                 // filament: a swaying chain of cells, each with a spiral chloroplast
    // The quad is A = 1.2·cells times longer than wide (cells keep one size); X runs along it in units of the half-width.
    float n = floor(ex), en = ex - n, A = 1.2 * n, X = q.x * A, wave = sin(q.x * 2.2 + time * .55 + ph) * .3, Y = q.y - wave;
    if (abs(q.x) > 1.) discard;
    float len = 2.4, u = (X + A) / len, cx = (fract(u) - .5) * len, ci = floor(u);
    vec2 bx = vec2(max(abs(cx) - (len * .5 - .5), 0.), abs(Y) - .1);                     // a capsule: rounded ends
    float dc = length(max(bx, 0.)) + min(max(bx.x, bx.y), 0.) - .5;
    d = dc;                                                                             // Y runs in q units across the filament
    float helix = smoothstep(.13, .03, abs(fract((cx * .9 + Y * 1.3) / 1.3 + ci * .37) - .5) - .3) * step(dc, -.12);
    float wall = smoothstep(-.14, 0., dc), tip = 1. - .35 * smoothstep(.8, 1., abs(q.x));
    col = c.rgb * (.22 + .2 * en) + c.rgb * 1.2 * helix * (.6 + .5 * en) + mix(c.rgb, vec3(.9, 1., .8), .5) * wall * .7;
    col *= tip; alpha = c.a * (.45 + .45 * wall + .25 * helix); add = .08 * wall;
  } else if (k == 18.) {                 // kelp frond: a long ruffled ribbon on a thin stipe, rippling in the current
    if (abs(q.x) > 1.) discard;
    float t = (q.x + 1.) * .5, bend = (ex - 10.) / 5.;
    float yc = sin(q.x * 2.6 - time * 1.1 + ph) * .28 * t + bend * .5 * t * t;          // the frond's centre line
    float w = .5 * (.12 + .88 * pow(sin(3.14159 * min(1., t * 1.08)), .55)) * (1. + .12 * sin(t * 38. + ph * 3.));
    float dy = q.y - yc; d = (abs(dy) - w) * .5;
    float rib = smoothstep(.06, .0, abs(dy)) * step(.12, t), edge = smoothstep(-.06, 0., abs(dy) - w);
    float veins = smoothstep(.12, .0, abs(fract(t * 14. - abs(dy) * 1.5) - .5) - .38);
    col = c.rgb * (.75 + .5 * t) + c.rgb * (.4 * rib + .15 * veins) + mix(c.rgb, vec3(.95, 1., .8), .4) * edge * .55;
    col = dressed(col, vec2(t * 6., dy * 2.) + ph, t * 3., dy / max(w, .05), abs(dy) / max(w, .05));
    alpha = c.a * (.72 + .28 * edge) * (t < .1 ? 1. : .92); add = .1 * edge;
  } else if (k == 19.) {                 // floating colony: a glass sphere of tiny cells with daughter colonies inside
    if (r > 1.) discard;
    float ang = time * .18 + ph, cs = cos(ang), sn = sin(ang); vec2 p = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
    float z = sqrt(max(0., 1. - r * r)), limb = 1. - z;
    vec2 cell = voronoi(p / max(z, .35) * 6.5 + ph);
    float dots = smoothstep(.22, .1, cell.x) * (.35 + .65 * limb);
    float kids = 0.; float nk = floor(ex);
    for (float i = 0.; i < 4.; i++) { if (i >= nk) break; float a = i * 6.28318 / nk + ph * 2.; vec2 cc = .42 * vec2(cos(a), sin(a)); kids = max(kids, smoothstep(.24, .17, length(p - cc))); }
    col = c.rgb * (.25 + 1.2 * dots + .9 * kids) + vec3(.6, .9, .8) * pow(limb, 3.) * .5;
    alpha = c.a * (.18 + .55 * dots + .6 * kids + .5 * pow(limb, 4.)); add = .25;
  } else if (k == 20.) {                 // diatom: an ornate glass valve of ribs and pores, faintly tinted by its chloroplasts
    if (r > 1.) discard;
    float pennate = step(.5, fract(ex)), ribs = floor(ex), ang = atan(q.y, abs(q.x) < 1e-4 ? 1e-4 : q.x), glass, rim = smoothstep(.86, .97, r);
    if (pennate > .5) {                  // a raphe along the middle with a central nodule, striae of pores across
      float raphe = smoothstep(.035, .0, abs(q.y)) * step(abs(q.x), .88) * smoothstep(.05, .1, abs(q.x));
      float nodule = smoothstep(.12, .07, length(q * vec2(1., 1.6)));
      float row = fract(q.x * ribs * .5), stria = smoothstep(.16, .04, abs(row - .5) - .3) * step(.07, abs(q.y)) * step(r, .9);
      float pore = smoothstep(.3, .1, length(vec2(row - .5, fract(abs(q.y) * 9.) - .5)));
      glass = .25 * stria + .55 * pore * stria + .9 * raphe + .7 * nodule;
    } else {                             // a centric valve: rings of pores in radial rows, a small rosette, spines at the margin
      float sector = fract(ang * ribs / 6.28318), ring = fract(r * 9.);
      float pore = smoothstep(.32, .12, length(vec2(sector - .5, ring - .5))) * step(.16, r) * step(r, .86);
      float rib = smoothstep(.06, .0, abs(sector - .5) - .45) * step(.16, r);
      float centre = smoothstep(.15, .1, r) * (.6 + .4 * smoothstep(.04, .0, abs(fract(ang * 5. / 6.28318) - .5) - .4));
      float spine = smoothstep(.1, .0, abs(fract(ang * ribs / 3.14159) - .5) - .44) * step(.94, r);
      glass = .6 * pore + .35 * rib + .7 * centre + .6 * spine;
    }
    col = vec3(.6, .72, .7) * (glass + .5 * rim) + c.rgb * .4;
    alpha = c.a * (.2 + .5 * glass + .5 * rim); add = .05;
  } else if (k == 17.) {                 // stem: a tapering, gently bent stalk with nodes
    if (abs(q.x) > 1.) discard;
    float t = (q.x + 1.) * .5, bend = sin(q.x * 1.6 + ph) * .18, w = mix(.55, .22, t);
    d = (abs(q.y - bend) - w) * .5;
    float node = smoothstep(.06, .0, abs(fract(t * 3.) - .5) - .44);
    col = c.rgb * (.65 + .35 * (1. - abs(q.y - bend) / w)) * (1. - .3 * node);
  } else if (k == 9.) {                  // plant base: a small glossy bulb
    float n = sqrt(max(0., 1. - r * r));
    col = c.rgb * (.45 + .6 * n) + vec3(.35, .3, .2) * smoothstep(.35, .0, length(q - vec2(-.3, .35)));
  } else if (k == 0.) {                  // leaf: translucent blade with a midrib and lit edges
    float halfw = .95 * pow(max(0., 1. - q.x * q.x), .75);
    d = abs(q.y) - halfw; if (q.x < -1. || q.x > 1.) d = 1.;
    float rib = smoothstep(.09, .0, abs(q.y)) * step(-.85, q.x), edge = smoothstep(-.18, 0., d);
    float veins = smoothstep(.05, .0, abs(fract((q.x - abs(q.y) * .8) * 3.) - .5) - .45);
    col = c.rgb * (.55 + .35 * (1. - abs(q.y) / max(halfw, .01))) + c.rgb * .6 * rib + c.rgb * .25 * veins + mix(c.rgb, vec3(.9, 1., .7), .4) * edge * .7;
    alpha = c.a * (.82 + .18 * edge); add = .15 * edge;
  } else if (k == 10.) {                 // thorn: a sharp spike pointing outward
    d = abs(q.y) - .55 * max(0., 1. - (q.x + 1.) * .5); if (q.x < -1. || q.x > 1.) d = 1.;
    col = c.rgb * (.7 + .5 * (1. - abs(q.y) * 2.));
  } else if (k == 2.) {                  // flagellum: a glowing filament beating in a wave
    if (abs(q.x) > 1.) discard;
    float wave = sin(q.x * 4.2 - time * 9. - ph) * .42 * (q.x + 1.) * .5;
    float w = mix(.28, .05, (q.x + 1.) * .5), dist = abs(q.y - wave);
    float core = smoothstep(w, w * .3, dist), glow = exp(-dist * dist / (w * w * 6.));
    o = vec4(col * (core * 1.3 + glow * .45) * c.a, core * c.a * .8); return;
  } else if (k == 1.) {                  // mouth: an oral funnel opening forward, a dark gullet inside a crimson lip
    d = max(r - 1., -(length(q - vec2(.75, 0.)) - .55));
    float gullet = smoothstep(.55, .2, length(q - vec2(.2, 0.)));
    col = mix(col * .95, vec3(.12, .02, .05), gullet * .8); add = .12;
  } else if (k == 4.) {                  // eyespot: a dark pigment cup holding a clear lens that faces outward
    float lens = length(q - vec2(.3, 0.)), cupd = length(q + vec2(.12, 0.));
    col = mix(c.rgb * .35, vec3(.06, .02, .02), smoothstep(.5, 1., cupd));                 // pigment, darker at the rim
    col = mix(col, vec3(.55, .75, .8) * .9, smoothstep(.56, .46, lens));                   // the lens
    col += vec3(1.) * smoothstep(.16, .0, length(q - vec2(.45, .22))) * .8;
    alpha = c.a * .95;
  } else if (k == 6.) {                  // fat: an amber droplet
    float n = sqrt(max(0., 1. - r * r));
    col = c.rgb * (.45 + .65 * n) + vec3(1., .9, .6) * smoothstep(.3, .0, length(q - vec2(-.3, .35))) * .8; add = .1;
  } else if (k == 5.) {                  // light organ: a hot bright core
    float n = smoothstep(1., .0, r);
    if (r > 1.) discard; o = vec4(col * (n * n * 2.2 + .3) * c.a, 0.); return;
  } else if (k == 8.) {                  // soft shadow (black) under bodies
    if (r > 1.) discard; o = vec4(vec3(0.), exp(-r * r * 3.2) * c.a); return;
  } else if (k == 11.) {                 // additive glow halo
    if (r > 1.) discard; o = vec4(col * exp(-r * r * 3.5) * c.a, 0.); return;
  }
  float m = 1. - smoothstep(-aa, aa, d);
  if (m <= 0.) discard;
  float a = m * alpha;
  o = vec4(col * a, a * (1. - add));
}`;

// Bright pass, blur, composite.
const BRIGHT_FS = `#version 300 es
precision mediump float; in vec2 uv; out vec4 o; uniform sampler2D src; uniform float threshold;
void main(){ vec3 c = texture(src, uv).rgb; float l = max(c.r, max(c.g, c.b)); o = vec4(c * smoothstep(threshold, threshold + .35, l), 1.); }`;
const BLUR_FS = `#version 300 es
precision mediump float; in vec2 uv; out vec4 o; uniform sampler2D src; uniform vec2 dir;
void main(){ vec3 s = texture(src, uv).rgb * .227;
  s += (texture(src, uv + dir * 1.385).rgb + texture(src, uv - dir * 1.385).rgb) * .316;
  s += (texture(src, uv + dir * 3.231).rgb + texture(src, uv - dir * 3.231).rgb) * .070; o = vec4(s, 1.); }`;
const COMPOSE_FS = `#version 300 es
precision mediump float; in vec2 uv; out vec4 o; uniform sampler2D scene, bloom; uniform float time, strength;
float hash(vec2 q){ return fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec3 c = texture(scene, uv).rgb + texture(bloom, uv).rgb * strength;
  c = c * (2.51 * c + .03) / (c * (2.43 * c + .59) + .14);             // filmic tone curve
  float l = dot(c, vec3(.299, .587, .114)); c = mix(vec3(l), c, 1.12);    // a little more colour
  c *= mix(.78, 1., smoothstep(1.25, .25, length(uv - .5) * 1.55));      // vignette
  c += (hash(uv * 911. + fract(time) * 37.) - .5) * .025;                 // film grain
  o = vec4(pow(max(c, 0.), vec3(.95)), 1.);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram(); gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
  return p;
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) throw Error('WebGL2 unavailable');
    this.gl = gl; this.canvas = canvas;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.ocean = program(gl, QUAD_VS, OCEAN_FS); this.mods = program(gl, MOD_VS, MOD_FS);
    this.bright = program(gl, QUAD_VS, BRIGHT_FS); this.blur = program(gl, QUAD_VS, BLUR_FS); this.compose = program(gl, QUAD_VS, COMPOSE_FS);
    this.quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.fieldTex = this.texture(1, 1, false, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    // Instance layout: pos2 rot1 half2 kind1 color4 phase1 extra1 = 12 floats.
    this.stride = 16; this.inst = new Float32Array(this.stride * 4096); this.count = 0;
    this.instBuf = gl.createBuffer();
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const loc = n => gl.getAttribLocation(this.mods, n);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad); gl.enableVertexAttribArray(loc('corner')); gl.vertexAttribPointer(loc('corner'), 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const S = this.stride * 4, attrs = [['pos', 2, 0], ['rot', 1, 2], ['half_', 2, 3], ['kind', 1, 5], ['color', 4, 6], ['phase', 1, 10], ['extra', 1, 11], ['deco', 4, 12]];
    for (const [n, size, off] of attrs) { const l = loc(n); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, S, off * 4); gl.vertexAttribDivisor(l, 1); }
    gl.bindVertexArray(null);
    this.quadVao = {};
    for (const [name, prog] of [['ocean', this.ocean], ['bright', this.bright], ['blur', this.blur], ['compose', this.compose]]) {
      const v = gl.createVertexArray(); gl.bindVertexArray(v); gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      const lp = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 0, 0);
      this.quadVao[name] = v;
    }
    gl.bindVertexArray(null);
    this.targets = null;
  }
  texture(w, h, float, repeat = false) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else if (w > 1) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }
  target(w, h) {
    const gl = this.gl, tex = this.texture(w, h, this.hdr), fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && this.hdr) { this.hdr = false; gl.deleteTexture(tex); gl.deleteFramebuffer(fb); return this.target(w, h); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }
  ensureTargets(w, h) {
    if (this.targets && this.targets.w === w && this.targets.h === h) return;
    const gl = this.gl;
    if (this.targets) for (const t of [this.targets.scene, this.targets.a, this.targets.b]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    const bw = Math.max(1, Math.round(w / 4)), bh = Math.max(1, Math.round(h / 4));
    this.targets = { w, h, scene: this.target(w, h), a: this.target(bw, bh), b: this.target(bw, bh) };
  }
  setFields(bytes, n) {
    // Server sends four planes; pack them into one RGBA texture.
    const gl = this.gl, rgba = new Uint8Array(n * n * 4), plane = n * n;
    for (let i = 0; i < plane; i++) { rgba[i * 4] = bytes[i]; rgba[i * 4 + 1] = bytes[plane + i]; rgba[i * 4 + 2] = bytes[2 * plane + i]; rgba[i * 4 + 3] = bytes[3 * plane + i]; }
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }
  begin() { this.count = 0; }
  push(x, y, rot, hx, hy, kind, r, g, b, a, phase = 0, extra = 0, d0 = 0, d1 = 0, d2 = 0, d3 = 0) {
    if ((this.count + 1) * this.stride > this.inst.length) { const n = new Float32Array(this.inst.length * 2); n.set(this.inst); this.inst = n; }
    const o = this.count++ * this.stride, I = this.inst;
    I[o] = x; I[o + 1] = y; I[o + 2] = rot; I[o + 3] = hx; I[o + 4] = hy; I[o + 5] = kind; I[o + 6] = r; I[o + 7] = g; I[o + 8] = b; I[o + 9] = a; I[o + 10] = phase; I[o + 11] = extra; I[o + 12] = d0; I[o + 13] = d1; I[o + 14] = d2; I[o + 15] = d3;
  }
  // Render scale adapts to the device: the app lowers it when frames get slow.
  resize() {
    // At most ~1.4 million rendered pixels: large Retina screens would otherwise cost
    // five to eight million per frame for little visible gain.
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const dpr = Math.min(Math.min(1.5, devicePixelRatio || 1), Math.sqrt(1.4e6 / Math.max(1, cw * ch))) * (this.quality ?? 1);
    const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr;
  }
  quadPass(name, prog, target, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
    gl.useProgram(prog); gl.bindVertexArray(this.quadVao[name]); setup(n => gl.getUniformLocation(prog, n));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  bind(unit, tex) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); }
  draw(cam, env, time) {
    const gl = this.gl; this.resize();
    const W = this.canvas.width, H = this.canvas.height, zoom = cam.zoom * this.dpr;
    this.ensureTargets(W, H);
    const T = this.targets;
    gl.disable(gl.BLEND);
    // 1. water
    this.bind(0, this.fieldTex);
    this.quadPass('ocean', this.ocean, T.scene, u => {
      gl.uniform1i(u('fields'), 0); gl.uniform2f(u('view'), W, H); gl.uniform2f(u('center'), cam.x, cam.y);
      gl.uniform1f(u('zoom'), zoom); gl.uniform1f(u('world'), env.world); gl.uniform1f(u('time'), time);
      gl.uniform1f(u('dayFrac'), env.dayFrac); gl.uniform1f(u('beltFrac'), env.beltFrac); gl.uniform1f(u('globalLight'), env.globalLight);
      const st = env.storm || [0, 1, 0], bd = env.band || [0, .05, 0]; gl.uniform3f(u('storm'), st[0], st[1], st[2]); gl.uniform3f(u('band'), bd[0], bd[1], bd[2]);
    });
    // 2. bodies
    if (this.count) {
      gl.useProgram(this.mods); gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf); gl.bufferData(gl.ARRAY_BUFFER, this.inst.subarray(0, this.count * this.stride), gl.STREAM_DRAW);
      const m = n => gl.getUniformLocation(this.mods, n);
      gl.uniform2f(m('view'), W, H); gl.uniform2f(m('center'), cam.x, cam.y); gl.uniform1f(m('zoom'), zoom);
      gl.uniform1f(m('world'), env.world); gl.uniform1f(m('time'), time); gl.uniform1f(m('minPx'), 1.3 * this.dpr);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
      gl.disable(gl.BLEND);
    }
    // 3. bloom: bright parts, blurred twice at quarter resolution
    this.bind(0, T.scene.tex);
    this.quadPass('bright', this.bright, T.a, u => { gl.uniform1i(u('src'), 0); gl.uniform1f(u('threshold'), this.hdr ? .5 : .42); });
    for (let i = 0; i < 2; i++) {
      this.bind(0, T.a.tex); this.quadPass('blur', this.blur, T.b, u => { gl.uniform1i(u('src'), 0); gl.uniform2f(u('dir'), (1 + i) / T.a.w, 0); });
      this.bind(0, T.b.tex); this.quadPass('blur', this.blur, T.a, u => { gl.uniform1i(u('src'), 0); gl.uniform2f(u('dir'), 0, (1 + i) / T.a.h); });
    }
    // 4. grade and present
    this.bind(0, T.scene.tex); this.bind(1, T.a.tex);
    this.quadPass('compose', this.compose, null, u => { gl.uniform1i(u('scene'), 0); gl.uniform1i(u('bloom'), 1); gl.uniform1f(u('time'), time); gl.uniform1f(u('strength'), 1.15); });
  }
}
