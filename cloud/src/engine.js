// Lern-Engine des Cloud-Bots. Wird 1:1 vom Cloud-Worker (live) und vom Rückblick (Vergangenheit) benutzt.
// Grundsatz: Jede Entscheidung nutzt nur Kerzen, die zu diesem Zeitpunkt schon geschlossen waren.
export const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'];
export const H4 = 4 * 3600e3, DAY = 864e5;
const FEE = 0.001, FFEE = 0.0005, SLIP = 0.0002, FUND = 0.0001;
export const W4 = 300, WD = 300;   // so viele Kerzen braucht die Engine rückwärts

// Die Varianten laufen alle gleichzeitig mit je 1.000 € Testgeld (Schattenkonto).
// Der Haupt-Bot verteilt sein Geld jede Woche auf die Varianten, die gerade am besten passen.
export const VARS = {
  trend: { n: 'Trend normal', d: 'Trendfolge Long+Short, vorsichtig', k: 'A', lvl: 1, adds: 2, L: 1, S: 1, brk: 1 },
  max: { n: 'Trend Max', d: 'Trendfolge Long+Short, Risiko ×3, 5 Nachkäufe', k: 'A', lvl: 3, adds: 5, L: 1, S: 1, brk: 1 },
  long: { n: 'Nur Long', d: 'Nur steigende Kurse, Rücksetzer + Ausbrüche', k: 'A', lvl: 2, adds: 3, L: 1, S: 0, brk: 1 },
  short: { n: 'Nur Short', d: 'Nur fallende Kurse (Rücksetzer im Abwärtstrend)', k: 'A', lvl: 2, adds: 3, L: 0, S: 1, brk: 0 },
  learn: { n: 'Selbstlernend', d: 'Lernt aus Schatten-Trades, welche Einstiege gerade klappen', k: 'L', lvl: 2, adds: 3 },
  rsi2: { n: 'RSI-2 Rücksetzer', d: 'Kauft kurze Dips im Aufwärtstrend (Tageskerzen)', k: 'B' },
  mom: { n: 'Momentum', d: 'Hält Coins, die über Wochen steigen – nur wenn BTC im Aufwärtstrend', k: 'C' },
  cash: { n: 'Bargeld', d: 'Nichts tun – sicherer Hafen', k: 'X' },
};
const VK = Object.keys(VARS);
export const CFG = { can: 1, look: 60, top: 3, cap: 0.6, smooth: 0, guard: 0, regW: 1, K: 30, minDays: 30, eqw: 0 };
export const LT = { pL: 'Rücksetzer Long', pS: 'Rücksetzer Short', bL: 'Ausbruch Long', bS: 'Ausbruch Short' };

/* ---------- Indikatoren ---------- */
const ema = (v, n) => { const k = 2 / (n + 1); let e = v[0]; return v.map((x, i) => i ? (e = x * k + e * (1 - k)) : e); };
const rma = (v, n) => { let e = v[0]; return v.map((x, i) => i ? (e = (e * (n - 1) + x) / n) : e); };
const sma = (v, n, i) => { if (i < n - 1) return NaN; let s = 0; for (let j = i - n + 1; j <= i; j++) s += v[j]; return s / n; };
const atrA = cs => rma(cs.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - cs[i - 1].c), Math.abs(x.l - cs[i - 1].c)) : x.h - x.l), 14);
const rsiA = (cl, n) => { const g = rma(cl.map((x, i) => i ? Math.max(0, x - cl[i - 1]) : 0), n), l = rma(cl.map((x, i) => i ? Math.max(0, cl[i - 1] - x) : 0), n); return g.map((x, i) => l[i] === 0 ? 100 : 100 - 100 / (1 + x / l[i])); };
function adxLast(cs) {
  const n = cs.length, pd = [0], md = [0], tr = [cs[0].h - cs[0].l];
  for (let i = 1; i < n; i++) { const u = cs[i].h - cs[i - 1].h, d = cs[i - 1].l - cs[i].l; pd.push(u > d && u > 0 ? u : 0); md.push(d > u && d > 0 ? d : 0); tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c))); }
  const a = rma(tr, 14), p = rma(pd, 14), m = rma(md, 14), dx = p.map((x, i) => { const P = 100 * x / a[i], M = 100 * m[i] / a[i]; return 100 * Math.abs(P - M) / Math.max(P + M, 1e-12); });
  const r = rma(dx, 14); return r[n - 1];
}
const pctLast = (v, w) => { const n = v.length - 1, x = v[n]; let le = 0, k = 0; for (let j = Math.max(0, n - w + 1); j <= n; j++) { if (!isFinite(v[j])) continue; k++; if (v[j] <= x) le++; } return k ? le / k : 0.5; };

// alles, was ein 4h-Signal braucht – einmal pro Coin und Kerze
function ind4(cs) {
  const cl = cs.map(x => x.c), n = cl.length - 1, x = cs[n], at = atrA(cs);
  const bw = cl.map((_, i) => { if (i < 19 || i < n - 140) return NaN; let s = 0, q = 0; for (let k = i - 19; k <= i; k++) { s += cl[k]; q += cl[k] * cl[k]; } const m = s / 20; return 4 * Math.sqrt(Math.max(0, q / 20 - m * m)) / m; });
  const atp = cl.map((c, i) => i < n - 140 ? NaN : at[i] / c);
  let hi = -Infinity, lo = Infinity, av = 0; for (let j = n - 30; j < n; j++) { hi = Math.max(hi, cs[j].h); lo = Math.min(lo, cs[j].l); } for (let j = n - 20; j < n; j++) av += cs[j].v; av /= 20;
  const e21 = ema(cl, 21), e50 = ema(cl, 50), e200 = ema(cl, 200);
  return { x, n, e21: e21[n], e50: e50[n], e200: e200[n], atr: at[n], r14: rsiA(cl, 14)[n], adx: adxLast(cs), bwp: pctLast(bw, 120), atp: pctLast(atp, 120), hi30: hi, lo30: lo, av20: av,
    minL3: Math.min(cs[n].l, cs[n - 1].l, cs[n - 2].l), maxH3: Math.max(cs[n].h, cs[n - 1].h, cs[n - 2].h) };
}
function signals(I) {
  const x = I.x, up = x.c > I.e200 && I.e50 > I.e200, dn = x.c < I.e200 && I.e50 < I.e200, vol = x.v > 1.2 * I.av20, s = [];
  if (up && I.minL3 <= I.e50 * 1.002 && x.c > I.e21 && x.c > x.o && I.r14 < 70) s.push(['pL', 1]);
  if (dn && I.maxH3 >= I.e50 * 0.998 && x.c < I.e21 && x.c < x.o && I.r14 > 30) s.push(['pS', -1]);
  if (x.c > I.hi30 && I.e21 > I.e50 && vol) s.push(['bL', 1]);
  if (x.c < I.lo30 && I.e21 < I.e50 && vol) s.push(['bS', -1]);
  return s;
}
const safety = I => (I.bwp > 0.62 ? 1 : 0) + (I.x.v > 1.96 * I.av20 ? 1 : 0) + (I.atr / I.x.c * 100 < 1.73 ? 1 : 0);
function feats(I, sd, bull) {
  const vr = I.x.v / I.av20;
  return ['Trendstärke ' + (I.adx < 20 ? 'schwach' : I.adx < 30 ? 'mittel' : 'stark'), 'Bandbreite ' + (I.bwp < 1 / 3 ? 'eng' : I.bwp < 2 / 3 ? 'mittel' : 'weit'),
    'Volumen ' + (vr < 1.2 ? 'normal' : vr < 2 ? 'erhöht' : 'stark'), 'Schwankung ' + (I.atp < 1 / 3 ? 'ruhig' : I.atp < 2 / 3 ? 'mittel' : 'wild'), 'BTC-Phase ' + ((bull ? 1 : -1) === sd ? 'passt' : 'gegen')];
}

/* ---------- Zustand ---------- */
export function fresh(t0) {
  const vars = {};
  for (const v of VK) { const acc = {}; for (const c of COINS) acc[c] = { cash: 1000 / COINS.length, pos: null }; vars[v] = { acc, peak: 1000, cool: {}, rets: [], lastEq: 1000, eqD: [], n: 0, win: 0, sum: 0 }; }
  const units = {}; for (const v of VK) units[v] = v === 'cash' ? 1 : 0;
  return { v: 2, t0, t4: null, tD: null, px: {}, vars, units, w: { cash: 1 }, mainPeak: 1000, mainD: [], mainI: [], fees: 0, bull: false,
    reg: null, regH: [], rst: {}, learn: { st: {}, sh: {} }, ev: [], logs: [], rebN: 0 };
}
let S, NOW, EVH = null;
export const setEventHook = f => { EVH = f; };
const log = (cls, msg) => { S.logs.unshift({ t: NOW, cls, msg }); if (S.logs.length > 400) S.logs.length = 400; };
function ev(o) { const e = { t: NOW, ...o }; S.ev.push(e); if (S.ev.length > 1500) S.ev.splice(0, S.ev.length - 1500); if (EVH) EVH(e); }

export function eqA(a, c) {
  if (!a.pos) return a.cash; const p = a.pos, pr = S.px[c] || p.mid;
  if (p.kind === 'spot') return a.cash + p.qty * pr * (1 - SLIP) * (1 - FEE);
  const ex = pr * (1 - p.side * SLIP); return a.cash + Math.max(0, p.margin + p.side * (ex - p.entry) * p.qty - ex * p.qty * FFEE - p.fund);
}
export function eqV(v) { let s = 0; for (const c of COINS) s += eqA(S.vars[v].acc[c], c); return s; }
export const bind = st => { S = st; };
// Crash-Schutz: alle Long-Positionen aller Varianten schließen, Shorts absichern, Longs für eine Weile sperren
export function emergency(st, now, why, hours) {
  S = st; NOW = now; S.crashUntil = Math.max(S.crashUntil || 0, now + hours * 3600e3); let n = 0;
  for (const v of VK) for (const c of COINS) { const p = S.vars[v].acc[c].pos; if (!p) continue;
    if (p.side > 0) { closePos(v, c, 'Crash-Schutz: ' + why); n++; }
    else if (p.kind === 'lev' && S.px[c] < p.mid) p.sl = Math.min(p.sl, p.mid); }
  log('k', `🚨 Crash-Schutz: ${n} Long-Positionen geschlossen, keine neuen Longs bis ${new Date(S.crashUntil).toISOString().slice(11, 16)} UTC – ${why}`);
  return n;
}
export function eqMain() { let s = 0; for (const v of VK) s += S.units[v] * eqV(v); return s; }

function closePos(v, c, why, price) {
  const V = S.vars[v], a = V.acc[c], p = a.pos; if (!p) return; if (price) S.px[c] = price;
  const after = eqA(a, c), pnl = after - p.cap0; a.cash = after; a.pos = null;
  V.n++; V.sum += pnl; if (pnl > 0) V.win++;
  if ((VARS[v].k === 'A' || VARS[v].k === 'L') && pnl < 0) V.cool[c] = NOW + 3 * H4;
  ev({ v, c, io: 'out', side: p.side, px: S.px[c], pnl, pct: pnl / p.cap0 * 100, why });
}
function openLev(v, c, sd, I, rp, why) {
  const V = S.vars[v], a = V.acc[c], pr = I.x.c, stop = 2 * I.atr, eq = a.cash;
  const risk = eq * rp / 100 * ((V.peak - eqV(v)) / V.peak > 0.15 ? 0.5 : 1);
  const notional = Math.min(risk / (stop / pr + 2 * FFEE + 2 * SLIP), eq * 5 * 0.95), margin = notional / 5; if (margin < 0.5) return;
  const fill = pr * (1 + sd * SLIP);
  a.pos = { kind: 'lev', side: sd, qty: notional / fill, margin, entry: fill, mid: pr, sl: pr - sd * stop, R: stop, best: pr, be: false, trail: false, fund: 0, cap0: a.cash, t: NOW, adds: 0, nk: 0 };
  a.cash -= margin + notional * FFEE;
  ev({ v, c, io: 'in', side: sd, px: pr, lev: notional / eq, sl: pr - sd * stop, why });
}
function manageLev(v, c, I, maxAdds) {   // läuft an jedem 4h-Schluss für offene Hebel-Positionen
  const a = S.vars[v].acc[c], p = a.pos; if (!p || p.kind !== 'lev') return; const sd = p.side, x = I.x;
  if (p.t < NOW - H4 + 1) { p.best = sd > 0 ? Math.max(p.best, x.h) : Math.min(p.best, x.l); if (sd > 0 ? x.l <= p.sl : x.h >= p.sl) { closePos(v, c, p.trail ? 'Trailing-Stop' : 'Stop-Loss', sd > 0 ? Math.min(x.o, p.sl) : Math.max(x.o, p.sl)); S.px[c] = x.c; return; } }
  if (sd > 0) p.fund += p.qty * x.c * FUND * 0.5;
  if (sd * (p.best - p.mid) >= p.R) p.be = true;
  const t = p.best - sd * 3 * I.atr; if (p.be && sd * (t - p.sl) > 0) { p.sl = t; p.trail = true; }
  if (p.adds < maxAdds && sd * (x.c - p.mid) >= (p.adds + 1) * p.R) {
    const q0 = p.q0 || p.qty, maxN = eqA(a, c) * 5 * 0.95, addN = Math.min(0.5 * q0 * x.c, maxN - p.qty * x.c), mg = addN / 5;
    if (addN > 0 && mg >= 0.5 && a.cash >= mg + addN * FFEE) {
      const f = x.c * (1 + sd * SLIP), aq = addN / f; p.q0 = q0; p.entry = (p.entry * p.qty + f * aq) / (p.qty + aq); p.qty += aq; p.margin += mg; a.cash -= mg + addN * FFEE; p.adds++; p.nk++;
      ev({ v, c, io: 'add', side: sd, px: x.c, why: 'Nachkauf ' + p.nk });
    } else p.adds = 99;
  }
}
// Stops zwischen zwei 4h-Schlüssen (live mit 5-Minuten-Kerzen)
export function touch(st, c, hi, lo, now) {
  S = st; NOW = now;
  for (const v of VK) { const a = S.vars[v].acc[c], p = a.pos; if (!p || p.kind !== 'lev') continue; const sd = p.side;
    p.best = sd > 0 ? Math.max(p.best, hi) : Math.min(p.best, lo);
    if (sd > 0 ? lo <= p.sl : hi >= p.sl) closePos(v, c, p.trail ? 'Trailing-Stop' : 'Stop-Loss', p.sl); }
}

/* ---------- Selbstlernen (Schatten-Trades, nur Vergangenheit) ---------- */
const LK = 20;
const Lm = k => { const o = S.learn.st[k]; return o ? o.s / (o.n + LK) : 0; };
const Ln = k => S.learn.st[k] ? S.learn.st[k].n : 0;
const Ladd = (k, r) => { const o = S.learn.st[k] || (S.learn.st[k] = { n: 0, s: 0 }); o.n++; o.s += r; };
function learnBar(c, I, bull, sig) {
  const x = I.x;
  for (const ty in LT) { const k = c + ty, s = S.learn.sh[k]; if (!s) continue; const sd = s.sd; let ex = null;
    if (sd > 0 ? x.l <= s.sl : x.h >= s.sl) ex = sd > 0 ? Math.min(x.o, s.sl) : Math.max(x.o, s.sl);
    if (ex != null) { const r = sd * (ex - s.mid) / s.R - 2 * (FFEE + SLIP) * s.mid / s.R; Ladd('ALL', r); Ladd('T:' + ty, r); for (const f of s.fs) Ladd(f, r); S.learn.sh[k] = null; continue; }
    s.best = sd > 0 ? Math.max(s.best, x.h) : Math.min(s.best, x.l); if (sd * (s.best - s.mid) >= s.R) s.be = true; const tr = s.best - sd * 3 * I.atr; if (s.be && sd * (tr - s.sl) > 0) s.sl = tr; }
  for (const [ty, sd] of sig) { const k = c + ty; if (!S.learn.sh[k]) S.learn.sh[k] = { sd, mid: x.c, sl: x.c - sd * 2 * I.atr, R: 2 * I.atr, best: x.c, be: false, fs: feats(I, sd, bull) }; }
}
export function predict(st, ty, fs) { S = st; let e = Lm('T:' + ty); const all = Lm('ALL'); for (const f of fs) e += Lm(f) - all; return e; }

/* ---------- 4h-Schluss ---------- */
function step4(c, cs) {
  const I = ind4(cs), sig = signals(I), bull = S.bull; S.px[c] = I.x.c;
  for (const v of VK) {
    const C = VARS[v]; if (C.k !== 'A' && C.k !== 'L') continue;
    const V = S.vars[v], a = V.acc[c];
    if (a.pos) { manageLev(v, c, I, C.adds); continue; }
    if ((V.cool[c] || 0) > NOW) continue;
    if (C.k === 'A') {
      let sd = 0, why = '';
      for (const [ty, s] of sig) {
        if (ty === 'pL' && C.L && I.adx < 30 && I.bwp >= 0.4) { sd = 1; why = 'Rücksetzer im Aufwärtstrend'; break; }
        if (ty === 'pS' && C.S && I.adx < 30 && I.bwp >= 0.4) { sd = -1; why = 'Rücksetzer im Abwärtstrend'; break; }
      }
      if (!sd && C.brk && C.L && sig.some(s => s[0] === 'bL')) { sd = 1; why = 'Ausbruch nach oben'; }
      if (sd > 0 && (S.crashUntil || 0) > NOW) sd = 0;
      if (sd) openLev(v, c, sd, I, [1, 2.5, 4, 6][safety(I)] * C.lvl, why);
    } else {
      let best = null; const minN = 15;
      for (const [ty, sd] of sig) { if (Ln('T:' + ty) < minN) continue; const e = predict(S, ty, feats(I, sd, bull)); if (e >= 0.1 && (!best || e > best.e)) best = { ty, sd, e }; }
      if (best && best.sd > 0 && (S.crashUntil || 0) > NOW) best = null;
      if (best) openLev(v, c, best.sd, I, Math.min(6, Math.max(0.5, best.e * 5)) * C.lvl, `${LT[best.ty]} · gelernter Vorteil ${best.e.toFixed(2).replace('.', ',')}R`);
    }
  }
  learnBar(c, I, bull, sig);
}

/* ---------- Tagesschluss: RSI-2, Momentum, Marktphase, Wochenplan ---------- */
function regimeOf(d) {
  const cl = d.map(x => x.c), n = cl.length - 1; if (n < 210) return null;
  const s200 = sma(cl, 200, n), s50 = sma(cl, 50, n), at = atrA(d), ap = at.map((a, i) => i < n - 260 ? NaN : a / cl[i]);
  const tr = cl[n] > s200 && s50 > s200 ? 'Bulle' : cl[n] < s200 && s50 < s200 ? 'Bär' : 'Seitwärts';
  return { tr, vol: pctLast(ap, 250) > 0.67 ? 'wild' : 'ruhig', bull: cl[n] > s200 };
}
function stepB(c, d) {
  const a = S.vars.rsi2.acc[c], cl = d.map(x => x.c), n = cl.length - 1, r2 = rsiA(cl, 2)[n], s200 = sma(cl, 200, n), s5 = sma(cl, 5, n);
  if (a.pos) { if (cl[n] > s5) closePos('rsi2', c, 'Schluss über 5-Tage-Schnitt'); return; }
  if (n >= 200 && cl[n] > s200 && r2 < 10 && !((S.crashUntil || 0) > NOW)) { const pr = cl[n], size = a.cash; if (size < 0.5) return;
    a.pos = { kind: 'spot', side: 1, qty: size * (1 - FEE) / (pr * (1 + SLIP)), mid: pr, cap0: a.cash, t: NOW }; a.cash = 0;
    ev({ v: 'rsi2', c, io: 'in', side: 1, px: pr, lev: 1, why: `RSI(2) ${r2.toFixed(1).replace('.', ',')} – kurzer Dip im Aufwärtstrend` }); }
}
function stepC(c, d) {
  const a = S.vars.mom.acc[c], cl = d.map(x => x.c), n = cl.length - 1; if (n < 91) return; let w = 0; for (const k of [10, 20, 30, 60, 90]) if (cl[n] > cl[n - k]) w++;
  const target = S.bull && !((S.crashUntil || 0) > NOW) ? w / 5 : 0, pr = cl[n], eq = eqA(a, c), cur = a.pos ? a.pos.qty * pr / eq : 0; if (Math.abs(target - cur) < 0.05) return;
  if (target === 0) { closePos('mom', c, S.bull ? 'Momentum weg' : 'BTC unter 200-Tage-Schnitt – raus'); return; }
  const diff = (target - cur) * eq, fee = Math.abs(diff) * (FEE + SLIP), cap0 = a.pos ? a.pos.cap0 : eq;
  if (!a.pos) ev({ v: 'mom', c, io: 'in', side: 1, px: pr, lev: target, why: `Momentum ${Math.round(target * 100)} % (${w}/5 Zeiträume steigen)` });
  a.cash = eq - target * eq - fee; a.pos = { kind: 'spot', side: 1, qty: target * eq / pr, mid: a.pos ? a.pos.mid : pr, cap0, t: a.pos ? a.pos.t : NOW };
}
const regKey = r => r ? r.tr + ' · ' + r.vol : '–';
function stepDay(D, dd) {
  const r = dd.BTC ? regimeOf(dd.BTC) : null;
  if (r) S.bull = r.bull;
  let ab = 0; for (const c of COINS) if (dd[c] && dd[c].length > 200) { const cl = dd[c].map(x => x.c), n = cl.length - 1; if (cl[n] > sma(cl, 200, n)) ab++; }
  S.ab200 = ab;   // wie viele Coins über ihrem 200-Tage-Schnitt liegen
  for (const c of COINS) if (dd[c] && dd[c].length > 30) { S.px[c] = dd[c][dd[c].length - 1].c; stepB(c, dd[c]); stepC(c, dd[c]); }
  // Tagesrenditen jeder Variante → kurzfristige Form + Lernen je Marktphase (Phase vom Tagesbeginn)
  const k0 = regKey(S.reg);
  for (const v of VK) { const V = S.vars[v], e = eqV(v), ret = e / V.lastEq - 1; V.lastEq = e; V.peak = Math.max(V.peak, e);
    V.rets.push(ret); if (V.rets.length > 200) V.rets.shift(); V.eqD.push([D + DAY, +e.toFixed(2)]);
    if (S.reg) { const o = (S.rst[k0] = S.rst[k0] || {})[v] = (S.rst[k0][v] || { n: 0, s: 0 }); o.n++; o.s += ret; } }
  if (r) { const k = regKey(r); if (k !== regKey(S.reg)) log('i', `Marktphase gewechselt: ${regKey(S.reg)} → ${k}`); S.reg = r; S.regH.push([D + DAY, k]); if (S.regH.length > 3000) S.regH.shift(); }
  const m = eqMain(); S.mainPeak = Math.max(S.mainPeak, m); S.mainD.push([D + DAY, +m.toFixed(2)]);
  if (new Date(D + DAY).getUTCDay() === 1) rebalance();   // jeden Montag 0 Uhr (UTC)
}
// Wochenplan: Wer passt gerade? Nur Vergangenheit: letzte 60 Tage + Erfahrung in der aktuellen Marktphase
export function scores(st) {
  S = st; const k = regKey(S.reg), out = {};
  for (const v of VK) { if (v === 'cash') continue; const R = S.vars[v].rets.slice(-CFG.look); if (R.length < CFG.minDays) { out[v] = { e: null }; continue; }
    const m = R.reduce((a, b) => a + b, 0) / R.length, sd = Math.max(0.002, Math.sqrt(R.reduce((a, b) => a + (b - m) ** 2, 0) / R.length));
    const o = (S.rst[k] || {})[v] || { n: 0, s: 0 }, rm = o.s / (o.n + CFG.K);
    out[v] = { e: ((1 - CFG.regW) * m + CFG.regW * rm) / sd, m60: m, reg: rm, regN: o.n, sd }; }
  return out;
}
export function rebalanceNow(st, now) { S = st; NOW = now; rebalance(); }
function rebalance() {
  // Nur Varianten, die in der jetzigen Lage überhaupt einsteigen können (sonst läge ihr Geld still)
  const can = v => !CFG.can ? true : v === 'rsi2' ? (S.ab200 ?? 1) > 0 : v === 'mom' ? !!S.bull : true;
  const sc = scores(S), cand = Object.entries(sc).filter(([v, o]) => o.e != null && o.e > 0 && can(v)).sort((a, b) => b[1].e - a[1].e).slice(0, CFG.top);
  let w = {}; let tot = 0; for (const [, o] of cand) tot += CFG.eqw ? 1 : o.e;
  for (const [v, o] of cand) w[v] = Math.min(CFG.cap, (CFG.eqw ? 1 : o.e) / tot);
  const m = eqMain(), dd = (S.mainPeak - m) / S.mainPeak; if (CFG.guard && dd > CFG.guard) for (const v in w) w[v] *= 0.5;
  let used = 0; for (const v in w) used += w[v]; w.cash = (w.cash || 0) + Math.max(0, 1 - used);
  if (CFG.smooth) { const o = S.w, n = {}; for (const v of VK) { const x = CFG.smooth * (o[v] || 0) + (1 - CFG.smooth) * (w[v] || 0); if (x > 0.001) n[v] = x; } w = n; }
  let turn = 0; for (const v of VK) turn += Math.abs((w[v] || 0) * m - S.units[v] * eqV(v));
  const fee = turn * 0.001, m2 = m - fee; S.fees += fee;
  for (const v of VK) S.units[v] = (w[v] || 0) * m2 / eqV(v);
  const changed = VK.some(v => Math.abs((w[v] || 0) - (S.w[v] || 0)) > 0.02); S.w = w; S.rebN++;
  if (changed) {
    const txt = Object.entries(w).filter(([, x]) => x > 0.005).sort((a, b) => b[1] - a[1]).map(([v, x]) => `${VARS[v].n} ${Math.round(x * 100)} %`).join(' · ');
    log('b', `Wochenplan (${regKey(S.reg)}): ${txt}${CFG.guard && dd > CFG.guard ? ' – Notbremse: halber Einsatz' : ''}`);
    ev({ v: 'main', io: 'reb', w: { ...w }, reg: regKey(S.reg) });
  }
}

/* ---------- Taktgeber: eine geschlossene 4h-Kerze (Startzeit T) verarbeiten ---------- */
// h4(c) → geschlossene 4h-Kerzen bis einschließlich T (oder null), d1(c, D) → Tageskerzen bis einschließlich D
export function advance(st, T, h4, d1) {
  S = st; NOW = T + H4;
  for (const c of COINS) { const cs = h4(c); if (cs && cs.length >= 250 && cs[cs.length - 1].t === T) step4(c, cs); }
  if ((T + H4) % DAY === 0) { const D = T + H4 - DAY, dd = {}; for (const c of COINS) { const d = d1(c, D); if (d && d.length && d[d.length - 1].t === D) dd[c] = d; } stepDay(D, dd); }
  S.t4 = T;
}
export const regName = regKey;
