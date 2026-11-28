// KI-Trader: sammelt alles, was Kurse bewegen kann, wägt ab und handelt nach eigenem Ermessen (Spielgeld).
// Die KI entscheidet Richtung, Hebel, Einsatz, Stop und Ziel. Der Code setzt nur Sicherheitsgrenzen durch.
import { COINS, VARS, emergency } from './engine.js';
import { fetchNews, grade } from './news.js';

const FFEE = 0.0005, SLIP = 0.0002, MAXLEV = 10, MAXRISK = 0.03, MAXMARGIN = 0.8, MAXONE = 0.25;
const CT = { BTC: 0.01, ETH: 0.1, SOL: 1, BNB: 0.01, XRP: 100, DOGE: 1000 };   // OKX-Kontraktgrößen
const YH = { 'S&P 500': '%5EGSPC', 'Nasdaq': '%5EIXIC', 'US-Dollar (DXY)': 'DX-Y.NYB', 'Gold': 'GC%3DF', 'US-Zins 10 J.': '%5ETNX', 'Angst-Index Aktien (VIX)': '%5EVIX' };
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
const pct = (a, b) => (a / b - 1) * 100;
async function J(url) { try { const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Lern-Bot)', accept: 'application/json' } }); if (!r.ok) return null; return await r.json(); } catch (e) { return null; } }

export async function push(env, title, msg, prio = 3, tags = '') {
  try { let t = await env.STATE.get('pushTopic'); if (!t) { t = 'lernbot-' + crypto.randomUUID().slice(0, 13); await env.STATE.put('pushTopic', t); }
    await fetch('https://ntfy.sh/' + t, { method: 'POST', body: msg.slice(0, 3000), headers: { Title: encodeURIComponent(title).length === title.length ? title : title.normalize('NFKD').replace(/[^\x20-\x7e]/g, ''), Priority: String(prio), Tags: tags, Click: 'https://kontaktmatthofstetter-wq.github.io/Meme/maxbot-cloud.html' } });
  } catch (e) { }
}
export function freshKI(now) { return { start: 1000, cash: 1000, pos: {}, closed: [], eqH: [[now, 1000]], peak: 1000, t0: now, dec: [], fundRate: {}, lastFund: now, n: 0, win: 0 }; }
export function eqPos(p, px) { const ex = px * (1 - p.side * SLIP); return Math.max(0, p.margin + p.side * (ex - p.entry) * p.qty - ex * p.qty * FFEE - p.fund); }
export function eqKI(K, P) { let s = K.cash; for (const c in K.pos) s += eqPos(K.pos[c], P[c] || K.pos[c].entry); return s; }

function closeKI(K, c, why, price, now) {
  const p = K.pos[c]; if (!p) return; const back = eqPos(p, price), pnl = back - p.margin;
  K.cash += back; delete K.pos[c]; K.n++; if (pnl > 0) K.win++;
  K.closed.unshift({ c, side: p.side, lev: p.lev, entry: p.entry, exit: price, pnl: r2(pnl), pct: r1(pnl / p.margin * 100), why, grund: p.grund, t0: p.t, t: now });
  if (K.closed.length > 200) K.closed.length = 200;
}
// alle 5 Minuten: Stop, Ziel, Liquidation, Finanzierung
export function manageKI(K, c, hi, lo, now) {
  const p = K.pos[c]; if (!p) return; const sd = p.side;
  if (sd > 0 ? lo <= p.liq : hi >= p.liq) { closeKI(K, c, 'Liquidiert', p.liq, now); return; }
  if (sd > 0 ? lo <= p.sl : hi >= p.sl) { closeKI(K, c, 'Stop-Loss', p.sl, now); return; }
  if (p.tp && (sd > 0 ? hi >= p.tp : lo <= p.tp)) closeKI(K, c, 'Ziel erreicht', p.tp, now);
}
export function fundKI(K, P, now) {
  const h = (now - (K.lastFund || now)) / 3600e3; K.lastFund = now; if (h <= 0 || h > 3) return;
  for (const c in K.pos) { const p = K.pos[c], rate = K.fundRate[c] ?? 0.0001; p.fund += p.side * p.qty * (P[c] || p.entry) * rate * h / 8; }
}

/* ---------- Ausführen, was die KI entschieden hat (mit Grenzen) ---------- */
function execute(K, d, P, T, now, notes) {
  const c = String(d.coin || '').toUpperCase(); if (!COINS.includes(c) || !P[c]) return;
  const a = String(d.aktion || '').toLowerCase(), px = P[c], cur = K.pos[c];
  if (/schlie|close|raus/.test(a)) { if (cur) { closeKI(K, c, 'KI schließt: ' + String(d.grund || '').slice(0, 120), px, now); notes.push(`${c}: geschlossen`); } return; }
  if (/halt|hold/.test(a)) {
    if (cur) { const sl = +d.stop, tp = +d.ziel;
      if (sl && (cur.side > 0 ? sl < px && sl > cur.liq : sl > px && sl < cur.liq)) cur.sl = sl;
      if (tp && (cur.side > 0 ? tp > px : tp < px)) cur.tp = tp; }
    return;
  }
  const sd = /long|kauf/.test(a) ? 1 : /short/.test(a) ? -1 : 0; if (!sd) return;
  if (sd > 0 && (K.blockLong || 0) > now) { notes.push(`${c}: Crash-Schutz aktiv – keine neuen Longs`); return; }
  if (cur && cur.side === sd) return execute(K, { ...d, aktion: 'halten' }, P, T, now, notes);
  if (cur) closeKI(K, c, 'Seitenwechsel', px, now);
  const eq = eqKI(K, P); let lev = Math.max(1, Math.min(MAXLEV, Math.round(+d.hebel || 1))), mPct = Math.max(1, Math.min(MAXONE * 100, +d.einsatz || 5)) / 100;
  let sl = +d.stop; const atr = T[c] ? T[c].atrPct / 100 * px : px * 0.03;
  if (!(sl > 0) || (sd > 0 ? sl >= px : sl <= px)) { sl = px - sd * 1.5 * atr; notes.push(`${c}: Stop fehlte/falsch – auf 1,5 Tages-Schwankungen gesetzt`); }
  let dist = Math.abs(px - sl) / px; if (dist < 0.003) { dist = 0.003; sl = px - sd * px * dist; }
  if (dist > 0.2) { dist = 0.2; sl = px - sd * px * dist; }
  if (dist * lev > 0.85) { lev = Math.max(1, Math.floor(0.85 / dist)); notes.push(`${c}: Hebel gesenkt auf ${lev}x, damit der Stop vor der Liquidation kommt`); }
  let margin = eq * mPct; const maxLoss = eq * MAXRISK;
  if (margin * lev * (dist + 2 * (FFEE + SLIP)) > maxLoss) { margin = maxLoss / (lev * (dist + 2 * (FFEE + SLIP))); notes.push(`${c}: Einsatz gekürzt – höchstens 3 % Verlust pro Trade`); }
  let used = 0; for (const k in K.pos) used += K.pos[k].margin; margin = Math.min(margin, eq * MAXMARGIN - used, K.cash - 1);
  if (margin < 1) { notes.push(`${c}: kein freies Geld mehr`); return; }
  const notional = margin * lev, fill = px * (1 + sd * SLIP), qty = notional / fill;
  K.cash -= margin + notional * FFEE;
  let tp = +d.ziel; if (!(tp > 0) || (sd > 0 ? tp <= px : tp >= px)) tp = null;
  K.pos[c] = { side: sd, lev, qty, margin, entry: fill, sl, tp, liq: fill * (1 - sd * (1 / lev) * 0.995), fund: 0, t: now, grund: String(d.grund || '').slice(0, 400), sicher: +d.sicherheit || null };
  notes.push(`${c}: ${sd > 0 ? 'LONG' : 'SHORT'} ${lev}x, Einsatz ${r2(margin)} €`);
}

/* ---------- Daten sammeln (in Stufen, damit ein Lauf nicht zu viele Abfragen macht) ---------- */
async function stageMarkt(X) {
  const fg = await J('https://api.alternative.me/fng/?limit=8');
  if (fg && fg.data) X.fg = { v: +fg.data[0].value, txt: fg.data[0].value_classification, vor7: fg.data[7] ? +fg.data[7].value : null };
  X.makro = {};
  await Promise.all(Object.entries(YH).map(async ([n, s]) => {
    const j = await J(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=10d&interval=1d`);
    const r = j && j.chart && j.chart.result && j.chart.result[0]; if (!r) return;
    const cl = (r.indicators.quote[0].close || []).filter(x => x != null), p = r.meta.regularMarketPrice || cl[cl.length - 1]; if (cl.length < 6) return;
    X.makro[n] = { p: r2(p), d1: r1(pct(p, cl[cl.length - 2])), d5: r1(pct(p, cl[cl.length - 6])) };
  }));
  const g = await J('https://api.coinpaprika.com/v1/global');
  if (g && g.bitcoin_dominance_percentage) X.global = { btcDom: r1(g.bitcoin_dominance_percentage), mcap: Math.round(g.market_cap_usd / 1e9), mcap24: r1(g.market_cap_change_24h) };
  const cal = await J('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
  if (Array.isArray(cal)) X.cal = cal.filter(e => e.impact === 'High' && ['USD', 'EUR', 'CNY', 'JPY'].includes(e.country)).map(e => ({ t: Date.parse(e.date), land: e.country, name: e.title, prog: e.forecast || '', vorher: e.previous || '' })).filter(e => e.t > Date.now() - 24 * 3600e3 && e.t < Date.now() + 72 * 3600e3).slice(0, 12);
}
async function stageDerivate(X) {
  X.der = {};
  await Promise.all(COINS.map(async c => {
    const o = {}, inst = `${c}-USDT-SWAP`;
    const f = await J(`https://www.okx.com/api/v5/public/funding-rate?instId=${inst}`); if (f && f.data && f.data[0]) { o.funding = +f.data[0].fundingRate; o.fundingProzent = Math.round(o.funding * 1e6) / 1e4; }
    const ls = await J(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${c}&period=1H`);
    if (ls && ls.data && ls.data.length > 24) o.ls = { jetzt: r2(+ls.data[0][1]), vor24h: r2(+ls.data[24][1]) };
    const oi = await J(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${c}&period=1H`);
    if (oi && oi.data && oi.data.length > 24) o.oi = { mio: Math.round(+oi.data[0][1] / 1e6), ch24: r1(pct(+oi.data[0][1], +oi.data[24][1])) };
    const lq = await J(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=${c}-USDT&state=filled`);
    if (lq && lq.data && lq.data[0]) { let L = 0, S = 0, t0 = Infinity; for (const d of lq.data[0].details || []) { const usd = +d.sz * (CT[c] || 1) * +d.bkPx; t0 = Math.min(t0, +d.ts); if (d.posSide === 'long') L += usd; else S += usd; }
      o.liq = { longs: Math.round(L), shorts: Math.round(S), stunden: r1((Date.now() - t0) / 3600e3) }; }
    X.der[c] = o;
  }));
}
const ema = (v, n) => { const k = 2 / (n + 1); let e = v[0]; return v.map((x, i) => i ? (e = x * k + e * (1 - k)) : e); };
function rsi(cl, n = 14) { let g = 0, l = 0; for (let i = cl.length - n; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l -= d; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); }
async function stageTechnik(X, getJSON) {
  X.tech = {};
  await Promise.all(COINS.map(async c => {
    const h = await getJSON(`/api/v3/klines?symbol=${c}USDT&interval=1h&limit=200`), d = await getJSON(`/api/v3/klines?symbol=${c}USDT&interval=1d&limit=120`);
    if (!h || !d || d.length < 60) return;
    const hc = h.map(k => +k[4]), dc = d.map(k => +k[4]), p = hc[hc.length - 1], n = dc.length - 1;
    let tr = 0; for (let i = n - 13; i <= n; i++) tr += Math.max(+d[i][2] - +d[i][3], Math.abs(+d[i][2] - dc[i - 1]), Math.abs(+d[i][3] - dc[i - 1])); const atr = tr / 14;
    const e20h = ema(hc, 20), e50h = ema(hc, 50), e20 = ema(dc, 20), e50 = ema(dc, 50);
    let vh = 0, va = 0; for (let i = h.length - 24; i < h.length; i++) vh += +h[i][5]; for (let i = h.length - 168; i < h.length - 24; i++) va += +h[i][5]; va = va / 6;
    const hi30 = Math.max(...d.slice(-30).map(k => +k[2])), lo30 = Math.min(...d.slice(-30).map(k => +k[3]));
    const o = { preis: p, h4: r1(pct(p, hc[hc.length - 5])), h24: r1(pct(p, hc[hc.length - 25])), d7: r1(pct(p, dc[n - 7])), d30: r1(pct(p, dc[n - 30])), d90: r1(pct(p, dc[n - 90])),
      rsi1h: Math.round(rsi(hc)), rsiTag: Math.round(rsi(dc)), trend1h: p > e20h[e20h.length - 1] && e20h[e20h.length - 1] > e50h[e50h.length - 1] ? 'auf' : p < e20h[e20h.length - 1] && e20h[e20h.length - 1] < e50h[e50h.length - 1] ? 'ab' : 'unklar',
      trendTag: p > e20[n] && e20[n] > e50[n] ? 'auf' : p < e20[n] && e20[n] < e50[n] ? 'ab' : 'unklar', atrPct: r1(atr / p * 100), volumen24hVsSchnitt: r1(vh / va), hoch30: hi30, tief30: lo30 };
    const b = await J(`https://www.okx.com/api/v5/market/books?instId=${c}-USDT&sz=200`);
    if (b && b.data && b.data[0]) { let B = 0, A = 0; for (const [q, s] of b.data[0].bids) if (+q >= p * 0.99) B += +q * +s; for (const [q, s] of b.data[0].asks) if (+q <= p * 1.01) A += +q * +s; if (A + B > 0) o.orderbuch = { kaufSeiteProzent: Math.round(B / (A + B) * 100), tiefeTsd: Math.round((A + B) / 1e3) }; }
    X.tech[c] = o;
  }));
}

/* ---------- Die Abwägung ---------- */
function prompt(X, S, K, P, N, news, now) {
  const L = [], reg = S.reg ? S.reg.tr + ' · ' + S.reg.vol : 'unbekannt';
  L.push(`JETZT: ${new Date(now).toISOString().slice(0, 16)} UTC`);
  L.push(`\nDEIN KONTO (Spielgeld): ${r2(eqKI(K, P))} € (Start 1000 €), frei ${r2(K.cash)} €. Offene Positionen:`);
  for (const c in K.pos) { const p = K.pos[c], e = eqPos(p, P[c]); L.push(`- ${c} ${p.side > 0 ? 'LONG' : 'SHORT'} ${p.lev}x, Einstieg ${p.entry.toPrecision(6)}, Stop ${p.sl.toPrecision(6)}, Ziel ${p.tp ? p.tp.toPrecision(6) : '–'}, Einsatz ${r2(p.margin)} €, Ergebnis ${r2(e - p.margin)} € · damaliger Grund: ${p.grund.slice(0, 160)}`); }
  if (!Object.keys(K.pos).length) L.push('- keine');
  if (K.closed.length) { L.push('Deine letzten abgeschlossenen Trades (lerne daraus):'); for (const t of K.closed.slice(0, 8)) L.push(`- ${t.c} ${t.side > 0 ? 'Long' : 'Short'} ${t.lev}x: ${t.pct >= 0 ? '+' : ''}${t.pct} % (${t.why}) · Grund war: ${String(t.grund).slice(0, 100)}`); }
  if (N.stats && N.stats.all && N.stats.all.n) L.push(`Trefferquote deiner 24h-Prognosen bisher: ${N.stats.all.ok}/${N.stats.all.n}.`);
  if (K.dec.length) L.push(`Deine letzte Einschätzung (${new Date(K.dec[0].t).toISOString().slice(5, 16)}): ${K.dec[0].lage}`);
  L.push(`\nREGEL-BOT (getestet 2020–2026): erkannte Marktphase ${reg}. Wochenplan: ${Object.entries(S.w || {}).filter(([, x]) => x > 0.01).map(([v, x]) => (VARS[v] ? VARS[v].n : v) + ' ' + Math.round(x * 100) + '%').join(', ')}. Seine offenen Positionen: ${(() => { const o = []; for (const v in S.vars) if (S.units[v] > 0) for (const c of COINS) { const p = S.vars[v].acc[c].pos; if (p) o.push(`${c} ${p.side > 0 ? 'Long' : 'Short'} (${v})`); } return o.join(', ') || 'keine'; })()}`);
  L.push('\nTECHNIK je Coin (Binance-Kerzen; Veränderungen in %, Volumen 24h im Vergleich zum Schnitt der Vorwoche, Orderbuch: Anteil Kaufaufträge im Bereich ±1 %):');
  for (const c of COINS) if (X.tech && X.tech[c]) L.push(`${c}: ${JSON.stringify(X.tech[c])}`);
  L.push('\nDERIVATE je Coin (OKX-Futures – Binance-Futures sperren Cloud-Server): fundingProzent = Finanzierungssatz in % pro 8h (positiv = Longs zahlen, Markt überwiegend long; über 0,03 % = überhitzt), ls = Verhältnis Konten long/short, oi = offene Positionen in Mio $ und Änderung 24h %, liq = zuletzt liquidierte Longs/Shorts in $ über die genannten Stunden:');
  for (const c of COINS) if (X.der && X.der[c]) { const { funding, ...o } = X.der[c]; L.push(`${c}: ${JSON.stringify(o)}`); }
  if (X.fg) L.push(`\nANGST-&-GIER-INDEX Krypto: ${X.fg.v} (${X.fg.txt}), vor 7 Tagen ${X.fg.vor7}.`);
  if (X.global) L.push(`Gesamter Kryptomarkt: ${X.global.mcap} Mrd $ (24h ${X.global.mcap24} %), BTC-Dominanz ${X.global.btcDom} %.`);
  if (X.makro && Object.keys(X.makro).length) L.push('MAKRO (Preis, 1 Tag %, 5 Tage %): ' + Object.entries(X.makro).map(([n, o]) => `${n} ${o.p} (${o.d1}/${o.d5})`).join('; '));
  if (X.cal && X.cal.length) L.push('WICHTIGE TERMINE (Wirtschaftskalender, UTC): ' + X.cal.map(e => `${new Date(e.t).toISOString().slice(5, 16)} ${e.land} ${e.name}${e.prog ? ' (Prognose ' + e.prog + ', vorher ' + e.vorher + ')' : ''}`).join('; '));
  L.push('\nSCHLAGZEILEN (letzte 36 h, Nummer in eckigen Klammern):');
  news.slice(0, 30).forEach((n, i) => L.push(`[${i}] (${n.coins.join(',')}) ${n.title}`));
  return L.join('\n');
}
const SYS = `Du bist ein aktiver, erfahrener Krypto-Trader und verwaltest ein Spielgeld-Konto mit Futures (Long und Short, Hebel 1–10x).
Deine Aufgabe: Chancen finden und nutzen – in beide Richtungen. Ein fallender Markt ist genauso eine Chance (Short) wie ein steigender (Long).
Bewerte bei JEDER Abwägung für JEDEN Coin ein Long-Setup und ein Short-Setup mit 0–100 Punkten. Die Punkte fassen zusammen: wie wahrscheinlich die Bewegung ist UND wie gut Chance zu Risiko ist.
Ab 60 Punkten wird das Setup automatisch gehandelt. Gib also 60+ genau dann, wenn du als Profi jetzt einsteigen würdest. Extreme Angst allein ist kein Grund, nichts zu tun – sie kann für eine Gegenbewegung nach oben sprechen oder für einen fortgesetzten Abverkauf.
Nach schnellen Abstürzen oder Anstiegen: Prüfe beide Möglichkeiten – Fortsetzung (mit dem Trend) oder Gegenbewegung (Rückprall). Liquidationswellen, Finanzierung und Long/Short-Verhältnis helfen dabei.
Stop: hinter einer sinnvollen Marke (letztes Hoch/Tief, ca. 1–2 Tages-Schwankungen). Ziel: mindestens 1,5-mal so weit weg wie der Stop. Hebel: höher bei engem Stop und klarer Lage, niedriger bei weitem Stop.
Nutze alle Daten: Technik, Derivate, Orderbuch, Stimmung, Makro, Termine, Nachrichten, die Meinung des Regel-Bots und deine eigenen letzten Trades.
Schreibe auf Deutsch in einfachen, kurzen Sätzen (der Leser hat eine Lese-Rechtschreib-Schwäche). Erfinde nichts. Nenne Schlagzeilen nie als Nummer im Text. Antworte NUR mit gültigem JSON.`;
const FORMAT = `
Antworte in genau diesem JSON-Format (kurz halten!):
{"lage":"2-3 Sätze: Was ist JETZT anders als vorhin, was ist am wichtigsten?",
 "faktoren":[{"name":"z.B. Angst-Index 12","wirkung":"positiv|negativ|neutral","warum":"kurz"}],
 "coins":{"BTC":{"richtung":"steigt|fällt|seitwärts","sicherheit":0-100,"gruende":["kurz","kurz"],"news":[Nummern],
   "long":{"punkte":0-100,"stop":Preis,"ziel":Preis,"hebel":1-10,"einsatz":1-25,"grund":"1 Satz"},
   "short":{"punkte":0-100,"stop":Preis,"ziel":Preis,"hebel":1-10,"einsatz":1-25,"grund":"1 Satz"}}, "ETH":{...}, "SOL":{...}, "BNB":{...}, "XRP":{...}, "DOGE":{...}},
 "entscheidungen":[{"coin":"BTC","aktion":"halten|schliessen","stop":Preis,"ziel":Preis,"grund":"kurz"}],
 "risiken":["was deine Einschätzung kippen könnte"],
 "crashRisiko":0-100,"crashGruende":["kurz"],"notfall":false}
"faktoren": die 5-8 wichtigsten Einflüsse. "entscheidungen": NUR für schon offene Positionen (halten mit neuem Stop/Ziel oder schliessen). Neue Trades entstehen automatisch aus Setups mit 60+ Punkten.
"crashRisiko": deine ehrliche Schätzung für einen Absturz von mehr als 15 % in den nächsten Tagen. "notfall": nur true, wenn JETZT etwas Schwerwiegendes passiert (große Börse stoppt Auszahlungen, riesiger Hack, Panik läuft) – dann werden sofort alle Longs geschlossen.`;
const SETUP_MIN = 60, FLIP_MIN = 75;
// Setups in Aufträge übersetzen: pro Coin die bessere Seite, ab 60 Punkten, Chance mindestens 1,5× Risiko
function setupOrders(out, K, P) {
  const orders = [], seen = [];
  for (const c of COINS) { const o = out.coins && out.coins[c]; if (!o || !P[c]) continue;
    const L = o.long || {}, Sh = o.short || {}, lp = +L.punkte || 0, sp = +Sh.punkte || 0;
    const best = lp >= sp ? ['long', L, lp, sp] : ['short', Sh, sp, lp]; const [side, st, pts, other] = best;
    seen.push(`${c} L${lp}/S${sp}`);
    if (pts < SETUP_MIN || pts < other + 10) continue;
    const cur = K.pos[c], sd = side === 'long' ? 1 : -1;
    if (cur && cur.side === sd) continue;
    if (cur && pts < FLIP_MIN) continue;
    const px = P[c], sl = +st.stop, tp = +st.ziel;
    if (sl > 0 && tp > 0 && (sd > 0 ? sl < px && tp > px : sl > px && tp < px) && Math.abs(tp - px) < 1.5 * Math.abs(px - sl)) { orders.push({ skip: `${c} ${side}: Ziel zu nah am Stop (Chance < 1,5× Risiko)` }); continue; }
    orders.push({ coin: c, aktion: side, hebel: st.hebel, einsatz: st.einsatz, stop: st.stop, ziel: st.ziel, sicherheit: pts, grund: `Setup ${pts} Punkte: ${String(st.grund || '').slice(0, 300)}` });
  }
  return { orders, seen };
}

export async function kiStep(env, S, getJSON, now) {
  const slot = Math.floor(now / 7200e3);
  let X = JSON.parse(await env.STATE.get('ctx') || 'null');
  if (!X || X.slot !== slot) { const N0 = JSON.parse(await env.STATE.get('news') || 'null'); if (N0 && N0.slot === slot && N0.ki) return null; X = { slot, stage: 0 }; }
  if (X.stage >= 4) return null;
  if (X.stage === 0) { await stageMarkt(X); X.at = now; X.stage = 1; await env.STATE.put('ctx', JSON.stringify(X)); return 'markt'; }
  if (X.stage === 1) { await stageDerivate(X); X.stage = 2; await env.STATE.put('ctx', JSON.stringify(X)); return 'derivate'; }
  if (X.stage === 2) { await stageTechnik(X, getJSON); X.stage = 3; await env.STATE.put('ctx', JSON.stringify(X)); return 'technik'; }
  // Stufe 3: Nachrichten + Abwägung + Handeln
  await decide(env, S, X, now, null);
  X.stage = 4; await env.STATE.put('ctx', JSON.stringify(X));
  return 'entscheidung';
}

async function decide(env, S, X, now, alarm) {
  const slot = Math.floor(now / 7200e3);
  const K = S.ki, P = { ...S.px };
  let N = JSON.parse(await env.STATE.get('news') || 'null') || { open: [], hist: [], stats: {} };
  grade(N, P, now);
  for (const c in X.der || {}) if (X.der[c].funding != null) K.fundRate[c] = X.der[c].funding;
  const news = await fetchNews();
  let out = null, raw = '';
  if (env.AI) {
    try {
      const pend = !alarm && S.alarm && S.alarm.pending ? `Seit deiner letzten Abwägung ist passiert: ${S.alarm.pending}\n\n` : '';
      if (pend) { S.alarm.pending = ''; S.alarm.pendT = 0; }
      const head = pend + (alarm ? `⚡ ALARM – darum wirst du außerhalb der Reihe gefragt: ${alarm}\nPrüfe, ob du jetzt handeln musst (einsteigen, aussteigen, Stop anpassen) oder ob es nur Lärm ist. Die Technik-Daten sind frisch, Derivate/Makro sind von ${X.at ? new Date(X.at).toISOString().slice(11, 16) : 'vorhin'} UTC.\n\n` : '');
      const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [{ role: 'system', content: SYS }, { role: 'user', content: head + prompt(X, S, K, P, N, news, now) + FORMAT }], max_tokens: 3000, temperature: 0.3 });
      raw = typeof r.response === 'string' ? r.response : JSON.stringify(r.response);
      out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    } catch (e) { out = null; raw = String(e).slice(0, 300) + ' ' + raw.slice(0, 300); }
  }
  const notes = [], fc = { at: now, reg: S.reg ? S.reg.tr + ' · ' + S.reg.vol : '–', quelle: out ? 'KI (Llama 3.3 70B)' : 'KI nicht erreichbar – keine neuen Trades', coins: {}, faktoren: [], risiken: [], markt: '' };
  if (out) {
    fc.markt = String(out.lage || '').slice(0, 800);
    fc.faktoren = (out.faktoren || []).slice(0, 12).map(f => ({ name: String(f.name || '').slice(0, 80), wirkung: String(f.wirkung || 'neutral'), warum: String(f.warum || '').slice(0, 200) }));
    fc.risiken = (out.risiken || []).slice(0, 5).map(s => String(s).slice(0, 240));
    for (const c of COINS) { const o = out.coins && out.coins[c]; if (!o) continue; const dir = /steig/i.test(o.richtung) ? 'steigt' : /f[äa]ll/i.test(o.richtung) ? 'fällt' : 'seitwärts';
      const sx = x => x ? { punkte: Math.max(0, Math.min(100, Math.round(+x.punkte || 0))), stop: +x.stop || null, ziel: +x.ziel || null, hebel: +x.hebel || null, grund: String(x.grund || '').slice(0, 200) } : null;
      fc.coins[c] = { setups: { long: sx(o.long), short: sx(o.short) }, richtung: dir, sicherheit: Math.max(0, Math.min(100, Math.round(+o.sicherheit || 0))), gruende: (o.gruende || []).slice(0, 4).map(s => String(s).replace(/^\s*\(?Schlagzeile\s*\[?\d+\]?\)?\s*:?\s*/i, '').slice(0, 240)),
        news: (o.news || []).map(i => news[+i]).filter(Boolean).slice(0, 3).map(n => n.title), px: P[c], tech: X.tech && X.tech[c] ? { ch1: X.tech[c].h24, ch7: X.tech[c].d7, rsi: X.tech[c].rsiTag, trend: X.tech[c].trendTag } : null }; }
    const cr = Math.max(0, Math.min(100, Math.round(+out.crashRisiko || 0)));
    S.risk = { v: cr, gruende: (out.crashGruende || []).slice(0, 5).map(x => String(x).slice(0, 240)), t: now, notfall: out.notfall === true };
    if (out.notfall === true) await crashAction(env, S, now, 3, 'KI meldet Notfall: ' + (S.risk.gruende[0] || fc.markt.slice(0, 160)));
    else if (cr >= 75) await crashAction(env, S, now, 2, `KI schätzt das Crash-Risiko auf ${cr} %: ${S.risk.gruende[0] || ''}`);
    const decs = (Array.isArray(out.entscheidungen) ? out.entscheidungen.slice(0, 6) : []).filter(d => K.pos[String(d.coin || '').toUpperCase()]);
    const so = setupOrders(out, K, P); for (const o of so.orders) { if (o.skip) notes.push(o.skip); else decs.push(o); }
    notes.push('Punkte (Long/Short): ' + so.seen.join(' · '));
    const before = JSON.stringify(Object.keys(K.pos).map(c => c + K.pos[c].side));
    for (const d of decs) execute(K, d, P, X.tech || {}, now, notes);
    const tr = notes.filter(x => /LONG|SHORT|geschlossen/.test(x));
    if (tr.length && JSON.stringify(Object.keys(K.pos).map(c => c + K.pos[c].side)) !== before) await push(env, 'KI-Trader: neuer Trade', tr.join('\n') + '\n\n' + fc.markt.slice(0, 300), 3, 'chart_with_upwards_trend');
    K.dec.unshift({ t: now, alarm: alarm || null, lage: fc.markt, ent: decs.map(d => ({ coin: d.coin, aktion: d.aktion, hebel: d.hebel, einsatz: d.einsatz, stop: d.stop, ziel: d.ziel, grund: String(d.grund || '').slice(0, 400) })), notes });
    if (K.dec.length > 40) K.dec.length = 40;
    if (!alarm && (slot % 3 === 0 || !N.fc)) for (const c in fc.coins) if (P[c]) N.open.push({ t: now, c, richtung: fc.coins[c].richtung, sicherheit: fc.coins[c].sicherheit, px: P[c] });
  }
  if (N.open.length > 200) N.open.splice(0, N.open.length - 200);
  if (alarm && !out) { await env.STATE.put('news', JSON.stringify(N)); return false; }
  if (alarm) fc.alarm = alarm; else { N.slot = slot; N.ki = true; }
  N.fc = fc; N.at = now; N.raw = out ? '' : raw;
  N.news = news.map(n => ({ t: n.t, title: n.title, link: n.link, src: n.src, coins: n.coins, sent: n.sent }));
  N.daten = { fg: X.fg, global: X.global, makro: X.makro, cal: X.cal, der: X.der, tech: X.tech };
  await env.STATE.put('news', JSON.stringify(N));
  return !!out;
}

/* ---------- Crash-Schutz ---------- */
// Stufe 2 = Warnung (Push, KI-Longs eng absichern, 4 h keine neuen KI-Longs)
// Stufe 3 = Crash (alle Longs beider Bots schließen, Shorts absichern, 12 h keine neuen Longs, dringende Push-Nachricht)
export async function crashAction(env, S, now, lvl, why) {
  const C = S.crash = S.crash || { lvl: 0, log: [] };
  if (C.cool && C.cool[lvl] > now) return;
  C.cool = C.cool || {}; C.cool[lvl] = now + (lvl === 3 ? 6 : 3) * 3600e3; C.lvl = lvl; C.t = now; C.why = why;
  const K = S.ki, P = S.px; let txt = '';
  if (lvl >= 3) {
    let n = 0; for (const c in { ...K.pos }) { const p = K.pos[c]; if (p.side > 0) { closeKI(K, c, 'Crash-Schutz', P[c] || p.entry, now); n++; } else if (P[c] < p.entry) p.sl = Math.min(p.sl, p.entry); }
    K.blockLong = now + 12 * 3600e3; const m = S.crashRegel ? emergency(S, now, why, 12) : 0;
    txt = `KI-Trader: ${n} Long-Positionen geschlossen, Shorts mit Stop auf Einstieg abgesichert, 12 Stunden keine neuen Longs.`;
    await push(env, 'CRASH-SCHUTZ AKTIV', `${why}\n\n${txt}`, 5, 'rotating_light');
  } else {
    let n = 0; for (const c in K.pos) { const p = K.pos[c]; if (p.side > 0 && P[c]) { const ns = P[c] * 0.985; if (ns > p.sl) { p.sl = ns; n++; } } }
    K.blockLong = Math.max(K.blockLong || 0, now + 4 * 3600e3);
    txt = `KI-Longs eng abgesichert (${n}), 4 Stunden keine neuen KI-Longs. Die KI wägt sofort neu ab.`;
    await push(env, 'Markt-Warnung', `${why}\n\n${txt}`, 4, 'warning');
  }
  C.log.unshift({ t: now, lvl, why, txt }); if (C.log.length > 50) C.log.length = 50;
}
export async function crashCheck(env, S, now) {
  S.pxH = S.pxH || []; S.pxH.push([now, { ...S.px }]); while (S.pxH.length && S.pxH[0][0] < now - 65 * 60e3) S.pxH.shift();
  S.pxL = S.pxL || []; if (!S.pxL.length || now - S.pxL[S.pxL.length - 1][0] >= 15 * 60e3) S.pxL.push([now, { ...S.px }]); while (S.pxL.length && S.pxL[0][0] < now - 25 * 3600e3) S.pxL.shift();
  const at = (arr, m) => { let b = null; for (const [t, p] of arr) if (t <= now - m * 60e3 + 120e3) b = p; return b; };
  const h1 = at(S.pxH, 60), h4 = at(S.pxL, 240), h24 = at(S.pxL, 1440), ch = (o, c) => o && o[c] && S.px[c] ? pct(S.px[c], o[c]) : 0;
  const b1 = ch(h1, 'BTC'), b4 = ch(h4, 'BTC'), b24 = ch(h24, 'BTC');
  const n1 = COINS.filter(c => ch(h1, c) <= -8).length, n4 = COINS.filter(c => ch(h4, c) <= -12).length;
  S.crashInfo = { b1: r1(b1), b4: r1(b4), b24: r1(b24), t: now };
  if (b1 <= -6 || b4 <= -9 || n1 >= 4 || n4 >= 4) return crashAction(env, S, now, 3, `Crash erkannt: BTC ${r1(b1)} % in 1 h, ${r1(b4)} % in 4 h${n4 >= 4 ? `, ${n4} Coins über −12 % in 4 h` : ''}`);
  if (b1 <= -3.5 || b4 <= -6 || b24 <= -10) return crashAction(env, S, now, 2, `Starker Abverkauf: BTC ${r1(b1)} % in 1 h, ${r1(b4)} % in 4 h, ${r1(b24)} % in 24 h`);
  if (S.crash && S.crash.lvl && now - (S.crash.t || 0) > 6 * 3600e3) S.crash.lvl = 0;   // wieder ruhig
}

/* ---------- Alarm: nichts Wichtiges verpassen ---------- */
// Alle 5 Min: Kurssprünge. Alle 10 Min: Eilmeldungen und Liquidationswellen. Bei Alarm sofort abwägen.
const BREAK = /\b(hack\w*|exploit\w*|etf\w*|sec|ban\w*|approv\w*|fed|powell|rate (cut|hike)\w*|crash\w*|plunge\w*|surge\w*|soar\w*|record|liquidat\w*|bankrupt\w*|lawsuit\w*|tariff\w*|war|sanction\w*|halt\w*|delist\w*|listing|emergency|breaking|collapse\w*|seiz\w*|arrest\w*|cpi|inflation)\b/i;
const ALARM_MAX = 10, ALARM_GAP = 20 * 60e3;
export async function alarmCheck(env, S, getJSON, now) {
  const A = S.alarm = S.alarm || { day: '', n: 0, last: 0, seen: [], log: [], cool: {}, liqAvg: {} };
  const day = new Date(now).toISOString().slice(0, 10); if (A.day !== day) { A.day = day; A.n = 0; }
  S.pxH = S.pxH || [];
  const why = [], coolOk = k => !(A.cool[k] > now);
  // 1) Kurssprünge (15 Min und 1 Stunde)
  const ago = m => { let best = null; for (const [t, p] of S.pxH) if (t <= now - m * 60e3 + 90e3) best = p; return best; };
  const p15 = ago(15), p60 = ago(60);
  for (const c of COINS) { const p = S.px[c]; if (!p) continue; const lim = c === 'BTC' ? 1 : 1.5;
    const m15 = p15 && p15[c] ? pct(p, p15[c]) : 0, m60 = p60 && p60[c] ? pct(p, p60[c]) : 0;
    if (Math.abs(m15) >= 1.5 * lim && coolOk('p' + c)) { why.push(`${c} ${m15 > 0 ? '+' : ''}${r1(m15)} % in 15 Minuten`); A.cool['p' + c] = now + 2 * 3600e3; }
    else if (Math.abs(m60) >= 3 * lim && coolOk('p' + c)) { why.push(`${c} ${m60 > 0 ? '+' : ''}${r1(m60)} % in 1 Stunde`); A.cool['p' + c] = now + 2 * 3600e3; }
    const ps = S.ki.pos[c]; if (ps && coolOk('s' + c) && Math.abs(p - ps.sl) / p < 0.004) { why.push(`${c} kurz vor deinem Stop (${ps.sl.toPrecision(6)})`); A.cool['s' + c] = now + 3 * 3600e3; }
  }
  // 2) Eilmeldungen + Liquidationswellen (alle 10 Minuten)
  let fresh = [];
  if (Math.floor(now / 600e3) !== A.slot10) {
    A.slot10 = Math.floor(now / 600e3);
    const news = await fetchNews(), first = !A.seen.length;
    for (const n of news) { const k = n.title.toLowerCase().slice(0, 70); if (A.seen.includes(k)) continue; A.seen.push(k);
      if (!first && n.t > now - 45 * 60e3 && (Math.abs(n.sent) >= 1 || BREAK.test(n.title))) fresh.push(n); }
    if (A.seen.length > 300) A.seen.splice(0, A.seen.length - 300);
    if (fresh.length && coolOk('news')) { why.push('Neue wichtige Meldung' + (fresh.length > 1 ? 'en' : '') + ': ' + fresh.slice(0, 3).map(n => `„${n.title}“`).join(' · ')); A.cool.news = now + 45 * 60e3; }
    for (const c of ['BTC', 'ETH']) {
      const lq = await J(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=${c}-USDT&state=filled`);
      if (!lq || !lq.data || !lq.data[0]) continue; let L = 0, Sh = 0;
      for (const d of lq.data[0].details || []) if (+d.ts > now - 15 * 60e3) { const usd = +d.sz * CT[c] * +d.bkPx; if (d.posSide === 'long') L += usd; else Sh += usd; }
      const tot = L + Sh, avg = A.liqAvg[c] ?? tot; A.liqAvg[c] = avg * 0.9 + tot * 0.1;
      if (tot > Math.max(3 * avg, c === 'BTC' ? 2e6 : 1e6) && coolOk('l' + c)) { why.push(`Liquidationswelle ${c}: ${Math.round(tot / 1e5) / 10} Mio $ in 15 Min (${L > Sh ? 'vor allem Longs' : 'vor allem Shorts'})`); A.cool['l' + c] = now + 2 * 3600e3; }
    }
  }
  if (!why.length && !A.pending) return null;
  if (why.length) { A.pending = [A.pending, why.join(' · ')].filter(Boolean).join(' · ').slice(-900); A.pendT = A.pendT || now; }
  const txt = A.pending;
  if (A.n >= ALARM_MAX || now - A.last < ALARM_GAP) {   // nicht verwerfen: wird nachgeholt
    if (why.length) { A.log.unshift({ t: now, txt: why.join(' · '), ok: false, info: A.n >= ALARM_MAX ? 'Tageslimit erreicht – geht in die nächste reguläre Abwägung' : 'wird in wenigen Minuten nachgeholt' }); A.log.length = Math.min(A.log.length, 60); }
    return null;
  }
  // frische Technik, Rest vom letzten Durchgang
  let X = JSON.parse(await env.STATE.get('ctx') || 'null') || {}; X = { ...X }; await stageTechnik(X, getJSON); X.at = X.at || now;
  A.n++; A.last = now; A.pending = ''; A.pendT = 0;
  const ok = await decide(env, S, X, now, txt);
  A.log.unshift({ t: now, txt, ok, info: ok ? 'sofort abgewogen' : 'KI nicht erreichbar' }); A.log.length = Math.min(A.log.length, 60);
  return 'alarm';
}
