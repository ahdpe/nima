// Measurements used by run reports and, later, by the chronicle.

// Peaks of a smoothed series whose rise and fall both exceed `prominence` of the peak.
export function peaks(series, { window = 6, prominence = .3, floor = 5 } = {}) {
  const s = series.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - window); k <= Math.min(series.length - 1, i + window); k++) { sum += series[k]; n++; }
    return sum / n;
  });
  const out = [];
  let lastTrough = s[0], candidate = -1;
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] >= s[i - 1] && s[i] > s[i + 1] && s[i] >= floor) {
      if (candidate < 0 || s[i] > s[candidate]) candidate = i;
    }
    if (candidate >= 0 && s[i] <= s[candidate] * (1 - prominence) && s[candidate] - lastTrough >= s[candidate] * prominence) {
      out.push(candidate); lastTrough = s[i]; candidate = -1;
    } else if (candidate < 0) lastTrough = Math.min(lastTrough, s[i]);
  }
  return out;
}

// Lag (in samples) at which predators best follow prey, and that correlation.
export function lagCorrelation(prey, pred, maxLag = 36) {
  const n = Math.min(prey.length, pred.length);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  let best = { lag: 0, r: -2 };
  for (let lag = 0; lag <= maxLag && lag < n - 4; lag++) {
    const a = prey.slice(0, n - lag), b = pred.slice(lag, n), ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    const r = da && db ? num / Math.sqrt(da * db) : 0;
    if (r > best.r) best = { lag, r };
  }
  return best;
}

// Predator–prey cycle: a predator peak that follows a prey peak within `within` samples.
export function predatorPreyCycles(prey, pred, within = 24) {
  const pp = peaks(prey), qp = peaks(pred);
  let cycles = 0;
  for (const q of qp) if (pp.some(p => p < q && q - p <= within)) cycles++;
  return { preyPeaks: pp.length, predatorPeaks: qp.length, cycles };
}
