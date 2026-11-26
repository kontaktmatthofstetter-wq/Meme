// Max-Bot als Cloudflare Worker – läuft rund um die Uhr (Paper-Trading, kein echtes Geld)
// Cron alle 5 Minuten: Stops prüfen, bei neuen 4h-/Tageskerzen Signale auswerten, Zustand in KV speichern.
const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'];
const FEE = 0.001, FFEE = 0.0005, SLIP = 0.0002, FUND = 0.0001, H4 = 4 * 3600e3, DAY = 864e5;
const SLV = { A: { n: 'A · Trendfolge L/S', w: 0.4 }, B: { n: 'B · RSI-2', w: 0.3 }, C: { n: 'C · Momentum + Schalter', w: 0.3 } };
const CFG = { capital: 1000, brake: 15, lvl: 3, adds: 5 };   // feste Max-Einstellung
const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api.binance.us'];

/* ---------- Daten ---------- */
let GOOD = null;   // zuletzt funktionierender Server (spart Anfragen)
async function getJSON(path) {
  for (const h of (GOOD ? [GOOD, ...HOSTS.filter(x => x !== GOOD)] : HOSTS)) {
    try { const r = await fetch(h + path, { cf: { cacheTtl: 0 } }); if (r.ok) { GOOD = h; return await r.json(); } } catch (e) { }
    if (GOOD === h) GOOD = null;
  }
  return null;
}
async function klines(sym, iv, n) {
  const j = await getJSON(`/api/v3/klines?symbol=${sym}USDT&interval=${iv}&limit=${n}`);
  return j ? j.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })) : null;
}
async function prices() {
  const o = {};
  await Promise.all([...COINS, 'EUR'].map(async c => {
    const j = await getJSON(`/api/v3/ticker/price?symbol=${c}USDT`);
    if (j && j.price) o[c] = +j.price;
  }));
  return o;
}

/* ---------- Indikatoren ---------- */
const ema = (v, n) => { const k = 2 / (n + 1); let e = v[0]; return v.map((x, i) => i ? (e = x * k + e * (1 - k)) : e); };
const rma = (v, n) => { let e = v[0]; return v.map((x, i) => i ? (e = (e * (n - 1) + x) / n) : e); };
const sma = (v, n, i) => { if (i < n - 1) return NaN; let s = 0; for (let j = i - n + 1; j <= i; j++) s += v[j]; return s / n; };
const atrA = cs => rma(cs.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - cs[i - 1].c), Math.abs(x.l - cs[i - 1].c)) : x.h - x.l), 14);
const rsiA = (cl, n) => { const g = rma(cl.map((x, i) => i ? Math.max(0, x - cl[i - 1]) : 0), n), l = rma(cl.map((x, i) => i ? Math.max(0, cl[i - 1] - x) : 0), n); return g.map((x, i) => l[i] === 0 ? 100 : 100 - 100 / (1 + x / l[i])); };
function adxA(cs) {
  const n = cs.length, pd = [0], md = [0], tr = [cs[0].h - cs[0].l];
  for (let i = 1; i < n; i++) { const u = cs[i].h - cs[i - 1].h, d = cs[i - 1].l - cs[i].l; pd.push(u > d && u > 0 ? u : 0); md.push(d > u && d > 0 ? d : 0); tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c))); }
  const a = rma(tr, 14), p = rma(pd, 14), m = rma(md, 14), dx = p.map((x, i) => { const P = 100 * x / a[i], M = 100 * m[i] / a[i]; return 100 * Math.abs(P - M) / Math.max(P + M, 1e-12); }); return rma(dx, 14);
}
function bwPct(cl, i) {
  const bw = j => { let s = 0, q = 0; for (let k = j - 19; k <= j; k++) { s += cl[k]; q += cl[k] * cl[k]; } const m = s / 20; return 4 * Math.sqrt(Math.max(0, q / 20 - m * m)) / m; };
  const cur = bw(i); let le = 0, n = 0; for (let j = i - 119; j <= i; j++) { if (j < 19) continue; n++; if (bw(j) <= cur) le++; } return n ? le / n : 0;
}

/* ---------- Konto ---------- */
function fresh(rate) {
  const u = CFG.capital / rate, acc = {};
  for (const k in SLV) { acc[k] = {}; for (const c of COINS) acc[k][c] = { cash: u * SLV[k].w / COINS.length, pos: null }; }
  return { v: 1, settings: { ...CFG, mode: 'fix', pyr: true, autoLev: true }, eurRate: rate, acc, start: u, peak: u, closed: [], equity: [], done: {}, logs: [], cool: {}, ev: [], price: {}, running: true, created: Date.now(), lastRun: 0 };
}
let S, NOW;
const px = v => v >= 1000 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4);
const eur = u => (u * S.eurRate).toFixed(2).replace('.', ',') + ' €';
function log(cls, msg) { S.logs.unshift({ t: NOW, cls, msg }); if (S.logs.length > 300) S.logs.length = 300; }
function addEv(o) { S.ev.push({ t: NOW, ...o }); if (S.ev.length > 800) S.ev.splice(0, S.ev.length - 800); }
function eqOf(a, c) {
  if (!a.pos) return a.cash; const p = a.pos, pr = S.price[c] || p.mid;
  if (p.kind === 'spot') return a.cash + p.qty * pr * (1 - SLIP) * (1 - FEE);
  const ex = pr * (1 - p.side * SLIP); return a.cash + Math.max(0, p.margin + p.side * (ex - p.entry) * p.qty - ex * p.qty * FFEE - p.fund);
}
function total() { let s = 0; for (const k in SLV) for (const c of COINS) s += eqOf(S.acc[k][c], c); return s; }
const brakeOn = () => (S.peak - total()) / S.peak * 100 > CFG.brake;
function closePos(k, c, reason, price) {
  const a = S.acc[k][c], p = a.pos; if (!p) return; if (price) S.price[c] = price;
  const before = eqOf(a, c); addEv({ c, k, io: 'out', side: p.side, px: S.price[c], pnl: before - p.cap0, why: reason });
  a.cash = before; a.pos = null; const pnl = before - p.cap0;
  S.closed.unshift({ k, c, side: p.side, reason, pnl, t: NOW }); if (S.closed.length > 400) S.closed.length = 400;
  if (k === 'A' && pnl < 0) S.cool[c] = NOW + 3 * H4;
  log(pnl >= 0 ? 'b' : 'k', `${SLV[k].n} · ${c} ${reason} · ${pnl >= 0 ? '+' : ''}${eur(pnl)}`);
}
function openSpot(k, c, frac, why) {
  const a = S.acc[k][c], pr = S.price[c], size = a.cash * frac; if (size < 1) return;
  a.pos = { kind: 'spot', side: 1, qty: size * (1 - FEE) / (pr * (1 + SLIP)), mid: pr, cap0: a.cash, t: NOW }; a.cash -= size;
  addEv({ c, k, io: 'in', side: 1, px: pr, why, amt: size }); log('b', `${SLV[k].n} · ${c} KAUF @ ${px(pr)} · ${eur(size)} · ${why}`);
}

/* ---------- A: Trendfolge (4h) ---------- */
function stopCheck(c, hi, lo) {      // Stop innerhalb der letzten Minuten berührt?
  const a = S.acc.A[c], p = a.pos; if (!p) return; const sd = p.side;
  p.best = sd > 0 ? Math.max(p.best, hi) : Math.min(p.best, lo);
  if (sd > 0 ? lo <= p.sl : hi >= p.sl) closePos('A', c, p.trail ? 'Trailing-Stop' : 'Stop-Loss', p.sl);
}
function stepA(c, cs) {
  const a = S.acc.A[c], cl = cs.map(x => x.c), n = cl.length - 1, e21 = ema(cl, 21), e50 = ema(cl, 50), e200 = ema(cl, 200), atr = atrA(cs)[n], r = rsiA(cl, 14)[n], x = cs[n];
  if (a.pos) {
    const p = a.pos, sd = p.side;
    if (sd > 0) p.fund += p.qty * x.c * FUND * 0.5;
    if (sd * (p.best - p.mid) >= p.R) p.be = true;
    const t = p.best - sd * 3 * atr; if (p.be && sd * (t - p.sl) > 0) { p.sl = t; if (!p.trail) log('i', `A · ${c}: +1R – Trailing-Stop läuft (${px(t)})`); p.trail = true; }
    const ad = p.adds || 0;
    if (ad < CFG.adds && sd * (x.c - p.mid) >= (ad + 1) * p.R) {
      const q0 = p.q0 || p.qty, maxN = eqOf(a, c) * 5 * 0.95, addN = Math.min(0.5 * q0 * x.c, maxN - p.qty * x.c), mg = addN / 5;
      if (addN > 0 && mg >= 1 && a.cash >= mg + addN * FFEE) {
        const f = x.c * (1 + sd * SLIP), aq = addN / f; p.q0 = q0; p.entry = (p.entry * p.qty + f * aq) / (p.qty + aq); p.qty += aq; p.margin += mg; a.cash -= mg + addN * FFEE; p.adds = ad + 1; p.nk = (p.nk || 0) + 1;
        p.lev = p.qty * x.c / eqOf(a, c); addEv({ c, k: 'A', io: 'add', side: sd, px: x.c, why: 'Nachkauf ' + (ad + 1), amt: mg });
        log('b', `A · ${c} Nachkauf ${ad + 1} @ ${px(x.c)} · +${ad + 1}R im Plus · ${eur(addN)} dazu`);
      } else p.adds = 99;
    }
    return;
  }
  if ((S.cool[c] || 0) > NOW) return;
  const up = x.c > e200[n] && e50[n] > e200[n], dn = x.c < e200[n] && e50[n] < e200[n]; let sd = 0;
  if (up && Math.min(cs[n].l, cs[n - 1].l, cs[n - 2].l) <= e50[n] * 1.002 && x.c > e21[n] && x.c > x.o && r < 70) sd = 1;
  else if (dn && Math.max(cs[n].h, cs[n - 1].h, cs[n - 2].h) >= e50[n] * 0.998 && x.c < e21[n] && x.c < x.o && r > 30) sd = -1;
  const ax = adxA(cs)[n], bp = bwPct(cl, n);
  if (sd && ax >= 30) { log('i', `A · ${c}: Rücksetzer verworfen – Trend überhitzt (ADX ${ax.toFixed(0)})`); sd = 0; }
  else if (sd && bp < 0.4) { log('i', `A · ${c}: Rücksetzer verworfen – Markt zu eng`); sd = 0; }
  let why = sd > 0 ? 'Rücksetzer im Aufwärtstrend' : 'Rücksetzer im Abwärtstrend';
  if (!sd) { let hi = -Infinity, vs = 0; for (let j = n - 30; j < n; j++) hi = Math.max(hi, cs[j].h); for (let j = n - 20; j < n; j++) vs += cs[j].v; if (x.c > hi && e21[n] > e50[n] && x.v > 1.2 * vs / 20) { sd = 1; why = 'Wende-Ausbruch'; } }
  if (!sd) return;
  let v20 = 0; for (let j = n - 20; j < n; j++) v20 += cs[j].v; v20 /= 20;
  const sc = (bp > 0.62 ? 1 : 0) + (x.v > 1.96 * v20 ? 1 : 0) + (atr / x.c * 100 < 1.73 ? 1 : 0), rp = [1, 2.5, 4, 6][sc] * CFG.lvl, cap = 5;
  const pr = S.price[c] || x.c, stop = 2 * atr, eq = a.cash, risk = eq * rp / 100 * (brakeOn() ? 0.5 : 1);
  const notional = Math.min(risk / (stop / pr + 2 * FFEE + 2 * SLIP), eq * cap * 0.95), margin = notional / cap; if (margin < 1) return;
  const fill = pr * (1 + sd * SLIP);
  a.pos = { kind: 'lev', side: sd, qty: notional / fill, margin, lev: notional / eq, sc, entry: fill, mid: pr, sl: pr - sd * stop, R: stop, best: pr, be: false, trail: false, fund: 0, cap0: a.cash, t: NOW };
  a.cash -= margin + notional * FFEE; addEv({ c, k: 'A', io: 'in', side: sd, px: pr, lev: notional / eq, why, amt: margin });
  log('b', `A · ${c} ${sd > 0 ? 'LONG' : 'SHORT'} @ ${px(pr)} · Sicherheit ${sc}/3 → Hebel ${(notional / eq).toFixed(1)}x · Position ${eur(notional)} · Stop ${px(pr - sd * stop)} (${why})`);
}
/* ---------- B: RSI-2 und C: Momentum (Tag) ---------- */
function stepB(c, cs) {
  const a = S.acc.B[c], cl = cs.map(x => x.c), n = cl.length - 1, r2 = rsiA(cl, 2)[n], s200 = sma(cl, 200, n), s5 = sma(cl, 5, n);
  if (a.pos) { if (cl[n] > s5) closePos('B', c, 'Schluss über 5-Tage-Schnitt'); return; }
  if (cl[n] > s200 && r2 < 10) openSpot('B', c, brakeOn() ? 0.5 : 1, `RSI(2) ${r2.toFixed(1)} im Aufwärtstrend`);
}
function stepC(c, cs, bull) {
  const a = S.acc.C[c], cl = cs.map(x => x.c), n = cl.length - 1; let w = 0; for (const k of [10, 20, 30, 60, 90]) if (cl[n] > cl[n - k]) w++;
  let target = bull ? w / 5 : 0; if (brakeOn()) target *= 0.5;
  const pr = S.price[c] || cl[n], eq = eqOf(a, c), cur = a.pos ? a.pos.qty * pr / eq : 0; if (Math.abs(target - cur) < 0.05) return;
  if (target === 0) { closePos('C', c, bull ? 'Momentum weg' : 'Bärenmodus – raus'); return; }
  const diff = (target - cur) * eq, fee = Math.abs(diff) * (FEE + SLIP), cap0 = a.pos ? a.pos.cap0 : eq;
  if (target > cur) addEv({ c, k: 'C', io: 'in', side: 1, px: pr, why: `Momentum ${Math.round(target * 100)} %`, amt: diff });
  a.cash = eq - target * eq - fee; a.pos = { kind: 'spot', side: 1, qty: target * eq / pr, mid: a.pos ? a.pos.mid : pr, cap0, t: a.pos ? a.pos.t : NOW };
  log('i', `C · ${c}: Anteil ${Math.round(cur * 100)} % → ${Math.round(target * 100)} %${bull ? '' : ' (Bärenmodus)'}`);
}

/* ---------- Ein Durchlauf ---------- */
async function run(env) {
  NOW = Date.now();
  const raw = await env.STATE.get('state'); const pr = await prices();
  const rate = pr.EUR ? 1 / pr.EUR : 0.92;
  S = raw ? JSON.parse(raw) : fresh(rate); if (!raw) log('b', 'Max-Bot in der Cloud gestartet – läuft jetzt rund um die Uhr');
  if (pr.EUR) S.eurRate = 1 / pr.EUR;
  for (const c of COINS) if (pr[c]) S.price[c] = pr[c];
  if (!S.running) { S.lastRun = NOW; await env.STATE.put('state', JSON.stringify(S)); return; }
  // 1) Stops über die 5-Minuten-Kerzen seit dem letzten Lauf prüfen
  for (const c of COINS) {
    if (!S.acc.A[c].pos) continue;
    const k5 = await klines(c, '5m', 3); if (!k5) continue;
    for (const x of k5) if (x.t + 5 * 60e3 > (S.lastRun || 0) - 5 * 60e3) stopCheck(c, x.h, x.l);
  }
  // 2) Neue Kerzen: 4h (Trendfolge) und Tag (RSI-2, Momentum)
  const last4 = Math.floor(NOW / H4) * H4 - H4, lastD = Math.floor(NOW / DAY) * DAY - DAY;
  let btcD = null;
  if (S.done.D !== lastD) {
    btcD = await klines('BTC', '1d', 260);
  }
  const bull = btcD ? (() => { const cs = btcD.filter(x => x.t <= lastD), cl = cs.map(x => x.c), n = cl.length - 1; return n >= 200 && cl[n] > sma(cl, 200, n); })() : S.bull;
  if (btcD) S.bull = bull;
  for (const c of COINS) {
    if (S.done['4' + c] !== last4) {
      const cs = await klines(c, '4h', 320);
      if (cs) { const cl = cs.filter(x => x.t <= last4); if (cl.length >= 250 && cl[cl.length - 1].t === last4) { stepA(c, cl); S.done['4' + c] = last4; } }
    }
    if (S.done.D !== lastD) {
      const d = c === 'BTC' && btcD ? btcD : await klines(c, '1d', 260);
      if (d) { const cl = d.filter(x => x.t <= lastD); if (cl.length >= 210 && cl[cl.length - 1].t === lastD) { stepB(c, cl); stepC(c, cl, bull); } }
    }
  }
  if (S.done.D !== lastD && btcD) S.done.D = lastD;
  // 3) Kontostand mitschreiben (alle 30 Minuten ein Punkt)
  const tot = total(); S.peak = Math.max(S.peak, tot);
  const lastEq = S.equity.length ? S.equity[S.equity.length - 1][0] : 0;
  if (NOW - lastEq >= 30 * 60e3) { S.equity.push([NOW, tot]); if (S.equity.length > 5000) S.equity.splice(0, S.equity.length - 5000); }
  S.lastRun = NOW;
  await env.STATE.put('state', JSON.stringify(S));
}

async function safeRun(env) {
  const t0 = Date.now();
  try { await run(env); const r = { ok: true, ms: Date.now() - t0, at: Date.now() }; await env.STATE.put('err', JSON.stringify(r)); return r; }
  catch (e) { const r = { ok: false, err: String(e && e.stack || e), at: Date.now() }; await env.STATE.put('err', JSON.stringify(r)); return r; }
}
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(safeRun(env)); },
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/api/state') { const s = await env.STATE.get('state'); return new Response(s || '{}', { headers: CORS }); }
    if (u.pathname === '/api/err') { const e = await env.STATE.get('err'); return new Response(e || '{}', { headers: CORS }); }
    if (u.pathname === '/api/run') {   // von Hand anstoßen – höchstens alle 4 Minuten
      const s = await env.STATE.get('state'), last = s ? JSON.parse(s).lastRun || 0 : 0;
      if (Date.now() - last < 4 * 60e3) return new Response('{"ok":true,"skip":true}', { headers: CORS });
      const r = await safeRun(env); return new Response(JSON.stringify(r), { headers: CORS });
    }
    return new Response('Max-Bot läuft. Zustand unter /api/state', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
};
