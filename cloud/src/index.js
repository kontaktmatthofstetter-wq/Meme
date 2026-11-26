// Lern-Bot als Cloudflare Worker – läuft rund um die Uhr (Paper-Trading, kein echtes Geld)
// Alle 5 Minuten: Kurse holen, Stops prüfen, neue 4h-/Tageskerzen der Reihe nach an die Engine geben, Zustand in KV speichern.
import * as E from './engine.js';
import { kiStep, freshKI, manageKI, fundKI, eqKI, alarmCheck } from './ki.js';
const { COINS, H4, DAY } = E;
const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api.binance.us'];
const INIT = 'https://raw.githubusercontent.com/kontaktmatthofstetter-wq/Meme/main/cloud/init-state.json';

let GOOD = null;
async function getJSON(path) {
  for (const h of (GOOD ? [GOOD, ...HOSTS.filter(x => x !== GOOD)] : HOSTS)) {
    try { const r = await fetch(h + path, { cf: { cacheTtl: 0 } }); if (r.ok) { GOOD = h; return await r.json(); } } catch (e) { }
    if (GOOD === h) GOOD = null;
  }
  return null;
}
async function klines(c, iv, n) {
  const j = await getJSON(`/api/v3/klines?symbol=${c}USDT&interval=${iv}&limit=${n}`);
  return j ? j.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })) : null;
}
async function prices() {
  const o = {};
  await Promise.all(COINS.map(async c => { const j = await getJSON(`/api/v3/ticker/price?symbol=${c}USDT`); if (j && j.price) o[c] = +j.price; }));
  return o;
}
const hasLev = (S, c) => Object.values(S.vars).some(V => V.acc[c].pos && V.acc[c].pos.kind === 'lev');

export async function run(env, now = Date.now()) {
  let raw = await env.STATE.get('state'), S = raw ? JSON.parse(raw) : null;
  if (!S || S.v !== 2) {   // Start: Zustand aus dem Rückblick übernehmen (bis kurz vor heute durchgerechnet, nur Vergangenheit)
    const r = await fetch(INIT + '?' + now); if (!r.ok) throw new Error('Startzustand nicht ladbar');
    S = await r.json(); S.logs.unshift({ t: now, cls: 'b', msg: 'Lern-Bot in der Cloud gestartet – übernimmt seine Erfahrung aus dem Rückblick und läuft jetzt rund um die Uhr' });
    S.mainI = []; S.live0 = now; S.liveEq0 = null;
  }
  E.bind(S);
  if (!S.ki) {   // Neustart auf Wunsch: KI-Trader mit 1.000 €, Lern-Bot ebenfalls auf 1.000 € (Erfahrung bleibt)
    S.ki = freshKI(now); const m = E.eqMain(); const f = 1000 / m; for (const v in S.units) S.units[v] *= f;
    S.mainD = []; S.mainI = []; S.mainPeak = 1000; S.liveEq0 = 1000; S.live0 = now; S.resetAt = now;
    S.logs.unshift({ t: now, cls: 'b', msg: 'Neustart: Konto auf 1.000 € gesetzt. Neu: KI-Trader mit eigenem Konto, der alles abwägt und selbst über Trades und Hebel entscheidet.' });
  }
  const px = await prices();
  // 1) Stops zwischen den Kerzen mit 5-Minuten-Kerzen prüfen (Regel-Bot und KI-Trader)
  for (const c of COINS) {
    if (!hasLev(S, c) && !S.ki.pos[c]) continue;
    const k5 = await klines(c, '5m', 4); if (!k5) continue;
    for (const x of k5) if (x.t + 5 * 60e3 <= now && x.t + 5 * 60e3 > (S.lastRun || 0) - 5 * 60e3) { E.touch(S, c, x.h, x.l, x.t + 5 * 60e3); manageKI(S.ki, c, x.h, x.l, x.t + 5 * 60e3); }
  }
  // 2) Alle neu geschlossenen 4h-Kerzen der Reihe nach verarbeiten (holt auch verpasste nach)
  const last = Math.floor(now / H4) * H4 - H4; let caught = false;
  if (S.t4 == null || S.t4 < last) {
    caught = true;
    const from = S.t4 == null ? last : Math.max(S.t4 + H4, last - 39 * H4), to = Math.min(last, from + 3 * H4), miss = (last - from) / H4 + 1, K = {}, Dd = {};   // höchstens 4 Kerzen pro Lauf (Rechenzeit)
    const needDay = Math.floor((to + H4) / DAY) > Math.floor(from / DAY);
    await Promise.all(COINS.map(async c => {
      K[c] = await klines(c, '4h', Math.min(1000, E.W4 + miss + 3));
      if (needDay) Dd[c] = await klines(c, '1d', E.WD + 5);
    }));
    const I4 = {}; for (const c of COINS) I4[c] = K[c] ? new Map(K[c].map((x, i) => [x.t, i])) : null;
    for (let T = from; T <= to; T += H4) {
      E.advance(S, T,
        c => { const i = I4[c] && I4[c].get(T); return i == null ? null : K[c].slice(Math.max(0, i - E.W4 + 1), i + 1); },
        (c, D) => { const a = Dd[c]; if (!a) return null; const i = a.findIndex(x => x.t === D); return i < 0 ? null : a.slice(Math.max(0, i - E.WD + 1), i + 1); });
    }
  }
  for (const c in px) S.px[c] = px[c];
  fundKI(S.ki, S.px, now);
  // 3) Ansicht für die Seite + Verlauf alle 30 Minuten
  const veq = {}; for (const v in E.VARS) veq[v] = +E.eqV(v).toFixed(2);
  S.view = { main: +E.eqMain().toFixed(2), veq, sc: E.scores(S), at: now };
  if (S.liveEq0 == null) S.liveEq0 = S.view.main;
  if (!S.mainI.length || now - S.mainI[S.mainI.length - 1][0] >= 30 * 60e3) { S.mainI.push([now, S.view.main]); if (S.mainI.length > 2000) S.mainI.shift(); }
  for (const v in S.vars) if (S.vars[v].eqD.length > 400) S.vars[v].eqD.splice(0, S.vars[v].eqD.length - 400);
  if (S.ev.length > 700) S.ev.splice(0, S.ev.length - 700);
  if (S.regH.length > 400) S.regH.splice(0, S.regH.length - 400);
  // KI-Trader: alle 2 Stunden Daten in Stufen sammeln, dann abwägen und handeln (ungerade UTC-Stunden, nicht zeitgleich mit 4h-Kerzen)
  let did = null;
  if (new Date(now).getUTCHours() % 2 === 1 || !S.ki.dec.length) { try { did = await kiStep(env, S, getJSON, now); S.kiStage = did || S.kiStage; } catch (e) { S.kiErr = String(e && e.stack || e).slice(0, 500); } }
  // Alarm-Prüfung in jedem Lauf, in dem nicht schon gesammelt/abgewogen wurde und keine 4h-Kerzen nachgeholt wurden
  if (!did && !caught) { try { await alarmCheck(env, S, getJSON, now); } catch (e) { S.kiErr = 'Alarm: ' + String(e && e.stack || e).slice(0, 400); } }
  const ke = eqKI(S.ki, S.px); S.ki.peak = Math.max(S.ki.peak, ke); S.ki.eq = +ke.toFixed(2);
  if (now - S.ki.eqH[S.ki.eqH.length - 1][0] >= 30 * 60e3) { S.ki.eqH.push([now, S.ki.eq]); if (S.ki.eqH.length > 3000) S.ki.eqH.shift(); }
  S.lastRun = now;
  await env.STATE.put('state', JSON.stringify(S));
  return S;
}

async function safeRun(env) {
  const t0 = Date.now();
  try { await run(env); const r = { ok: true, ms: Date.now() - t0, at: Date.now() }; if (new Date().getUTCMinutes() < 5) await env.STATE.put('err', JSON.stringify(r)); return r; }
  catch (e) { const r = { ok: false, err: String(e && e.stack || e), at: Date.now() }; await env.STATE.put('err', JSON.stringify(r)); return r; }
}
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(safeRun(env)); },
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/api/state') { const s = await env.STATE.get('state'); return new Response(s || '{}', { headers: CORS }); }
    if (u.pathname === '/api/probe') {   // prüft, welche Datenquellen aus der Cloud erreichbar sind
      const L = ['https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', 'https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=2',
        'https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=2', 'https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=1h&limit=2',
        'https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP', 'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H',
        'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1H', 'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT',
        'https://api.alternative.me/fng/?limit=2', 'https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://api.coingecko.com/api/v3/global',
        'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=5d&interval=1d', 'https://stooq.com/q/l/?s=%5Espx&f=sd2t2ohlcv&h&e=csv',
        'https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=100', 'https://api.coinbase.com/v2/prices/BTC-USD/spot', 'https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=BTC-USDT&state=filled'];
      const out = await Promise.all(L.map(async x => { try { const r = await fetch(x, { headers: { 'user-agent': 'Mozilla/5.0 Lern-Bot' } }); const t = await r.text(); return [x, r.status, t.slice(0, 160)]; } catch (e) { return [x, 0, String(e)]; } }));
      return new Response(JSON.stringify({ colo: req.cf && req.cf.colo, out }, null, 1), { headers: CORS });
    }
    if (u.pathname === '/api/news') { const s = await env.STATE.get('news'); return new Response(s || '{}', { headers: CORS }); }
    if (u.pathname === '/api/k') {   // Kerzen für die Seite (falls Binance im Browser nicht lädt)
      const c = u.searchParams.get('c'), iv = u.searchParams.get('i') === '1d' ? '1d' : '4h'; if (!COINS.includes(c)) return new Response('[]', { status: 400, headers: CORS });
      const j = await getJSON(`/api/v3/klines?symbol=${c}USDT&interval=${iv}&limit=120`); return new Response(JSON.stringify(j || []), { headers: CORS });
    }
    if (u.pathname === '/api/err') { const e = await env.STATE.get('err'); return new Response(e || '{}', { headers: CORS }); }
    if (u.pathname === '/api/run') {   // von Hand anstoßen – höchstens alle 4 Minuten
      const s = await env.STATE.get('state'); let last = 0; try { last = s ? JSON.parse(s).lastRun || 0 : 0; } catch (e) { }
      if (Date.now() - last < 4 * 60e3) return new Response('{"ok":true,"skip":true}', { headers: CORS });
      return new Response(JSON.stringify(await safeRun(env)), { headers: CORS });
    }
    return new Response('Lern-Bot läuft. Zustand unter /api/state', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
};
