// Nachrichten holen, den Coins zuordnen, Stimmung bewerten, Prognose erstellen und später prüfen.
// Die Prognosen handeln (noch) nicht – sie werden gemessen, damit man sieht, ob sie etwas taugen.
import { COINS } from './engine.js';

const FEEDS = [
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['Cointelegraph', 'https://cointelegraph.com/rss'],
  ['Decrypt', 'https://decrypt.co/feed'],
  ['Google News', 'https://news.google.com/rss/search?q=bitcoin+OR+crypto+OR+%22federal+reserve%22+when:1d&hl=en-US&gl=US&ceid=US:en'],
];
const TAGS = {
  BTC: /\b(bitcoin|btc)\b/i, ETH: /\b(ethereum|ether|eth)\b/i, SOL: /\b(solana|sol)\b/i, BNB: /\b(bnb|binance)\b/i,
  XRP: /\b(xrp|ripple)\b/i, DOGE: /\b(dogecoin|doge)\b/i,
  Markt: /\b(fed|federal reserve|powell|inflation|cpi|interest rate|rate cut|rate hike|sec|etf|regulat\w*|tariff|recession|treasury|stablecoin|crypto market)\b/i,
};
const NEGX = /\b(no|not|without|unlikely|delay\w*|pause\w*)\b[^.]{0,20}\brate cuts?\b/i;
const POS = /\b(surge\w*|rall(y|ies|ied)|soar\w*|jump\w*|gain\w*|record high|all-time high|approv\w*|inflow\w*|bullish|adopt\w*|partnership|upgrade\w*|rebound\w*|recover\w*|rise\w*|rising|climb\w*|breakout|accumulat\w*|buy(s|ing)?|rate cut\w*|green light|win\w*|boost\w*)\b/gi;
const NEG = /\b(plunge\w*|crash\w*|drop\w*|fall\w*|slump\w*|tumble\w*|hack\w*|exploit\w*|lawsuit\w*|sue[sd]?|ban\w*|outflow\w*|bearish|liquidat\w*|sell-?off\w*|fraud\w*|delay\w*|reject\w*|fine[sd]?|investigat\w*|probe\w*|decline\w*|fear\w*|dump\w*|warn\w*|rate hike\w*|collapse\w*|risk\w*|slide\w*|sink\w*|loss(es)?)\b/gi;
const unx = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8217;/g, "'").replace(/&#\d+;/g, '').trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i')); return m ? unx(m[1]) : ''; };

export function parseRSS(xml, src) {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const x = m[0]; let title = tag(x, 'title'); const link = tag(x, 'link'), t = Date.parse(tag(x, 'pubDate')) || 0;
    if (!title) continue; title = title.replace(/\s+-\s+[^-]{2,40}$/, src === 'Google News' ? '' : '$&');
    out.push({ t, title: title.slice(0, 220), link: link.slice(0, 400), src });
  }
  return out;
}
export function score(title) {
  let p = (title.match(POS) || []).length, n = (title.match(NEG) || []).length; if (NEGX.test(title)) { p = Math.max(0, p - 1); n++; }
  const coins = Object.keys(TAGS).filter(k => TAGS[k].test(title));
  return { sent: Math.max(-1, Math.min(1, (p - n) / 2)), coins };
}
export async function fetchNews() {
  const all = [];
  await Promise.all(FEEDS.map(async ([src, url]) => {
    try { const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Lern-Bot RSS)' }, cf: { cacheTtl: 300 } }); if (r.ok) all.push(...parseRSS(await r.text(), src)); } catch (e) { }
  }));
  const seen = new Set(), now = Date.now();
  return all.filter(n => n.t > now - 36 * 3600e3 && n.t <= now + 600e3).sort((a, b) => b.t - a.t)
    .filter(n => { const k = n.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; })
    .map(n => ({ ...n, ...score(n.title) })).filter(n => n.coins.length).slice(0, 40);
}

/* ---------- Technik je Coin (aus Tageskerzen) ---------- */
const ema = (v, n) => { const k = 2 / (n + 1); let e = v[0]; return v.map((x, i) => i ? (e = x * k + e * (1 - k)) : e); };
function techOf(d, px) {
  const cl = d.map(x => x.c), n = cl.length - 1, p = px || cl[n], e20 = ema(cl, 20)[n], e50 = ema(cl, 50)[n];
  let g = 0, l = 0; for (let i = n - 13; i <= n; i++) { const ch = cl[i] - cl[i - 1]; if (ch > 0) g += ch; else l -= ch; }
  const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l), hi = Math.max(...d.slice(-30).map(x => x.h)), lo = Math.min(...d.slice(-30).map(x => x.l));
  return { px: p, ch1: (p / cl[n - 1] - 1) * 100, ch7: (p / cl[n - 7] - 1) * 100, ch30: (p / cl[n - 30] - 1) * 100, rsi, trend: p > e20 && e20 > e50 ? 'aufwärts' : p < e20 && e20 < e50 ? 'abwärts' : 'unklar', hi30: hi, lo30: lo };
}

/* ---------- Prognose: KI (Workers AI) mit Regel-Ersatz ---------- */
const r1 = x => Math.round(x * 10) / 10, de = x => (x >= 0 ? '+' : '') + String(r1(x)).replace('.', ',');
function ruleForecast(T, news, reg) {
  const coins = {};
  for (const c of COINS) {
    const t = T[c]; if (!t) continue; const ns = news.filter(n => n.coins.includes(c) || n.coins.includes('Markt')), s = ns.length ? ns.reduce((a, n) => a + n.sent, 0) / ns.length : 0;
    const sc = (t.trend === 'aufwärts' ? 1 : t.trend === 'abwärts' ? -1 : 0) + s * 1.5 + (t.rsi < 30 ? 0.5 : t.rsi > 70 ? -0.5 : 0);
    const dir = sc > 0.6 ? 'steigt' : sc < -0.6 ? 'fällt' : 'seitwärts', why = [];
    why.push(`Trend auf Tageskerzen: ${t.trend} (7 Tage ${de(t.ch7)} %).`);
    if (t.rsi < 30) why.push(`RSI ${Math.round(t.rsi)} – stark überverkauft, Gegenbewegung möglich.`); else if (t.rsi > 70) why.push(`RSI ${Math.round(t.rsi)} – überkauft, Rücksetzer möglich.`);
    why.push(ns.length ? `Nachrichten-Stimmung ${s > 0.15 ? 'eher positiv' : s < -0.15 ? 'eher negativ' : 'gemischt'} (${ns.length} Meldungen).` : 'Kaum Nachrichten zu diesem Coin.');
    coins[c] = { richtung: dir, sicherheit: Math.round(Math.min(70, 35 + Math.abs(sc) * 15)), gruende: why, news: ns.slice(0, 3).map(n => n.title) };
  }
  return { quelle: 'Regeln', markt: `Marktphase laut Bot: ${reg}. Die Prognose kommt aus Trend, RSI und der Stimmung der Schlagzeilen.`, coins, risiken: [] };
}
async function aiForecast(env, T, news, reg, posTxt) {
  if (!env.AI) return null;
  const tech = COINS.filter(c => T[c]).map(c => { const t = T[c]; return `${c}: Preis ${t.px}, 24h ${r1(t.ch1)} %, 7 Tage ${r1(t.ch7)} %, 30 Tage ${r1(t.ch30)} %, RSI14 ${Math.round(t.rsi)}, Trend ${t.trend}, 30-Tage-Hoch ${t.hi30}, -Tief ${t.lo30}`; }).join('\n');
  const nl = news.slice(0, 30).map((n, i) => `[${i}] (${n.coins.join(',')}) ${n.title}`).join('\n');
  const sys = 'Du bist ein nüchterner Krypto-Analyst. Schreibe auf Deutsch in einfachen, kurzen Sätzen (der Leser hat eine Lese-Rechtschreib-Schwäche). Sei ehrlich über Unsicherheit, erfinde keine Fakten und nutze nur die gegebenen Daten. Antworte NUR mit gültigem JSON.';
  const user = `Datum: ${new Date().toISOString().slice(0, 16)} UTC\nMarktphase (vom Bot erkannt): ${reg}\nOffene Positionen des Bots: ${posTxt || 'keine'}\n\nTECHNIK (Tageskerzen):\n${tech}\n\nSCHLAGZEILEN der letzten 36 Stunden:\n${nl || 'keine'}\n\nAufgabe: Schätze für jeden Coin, was in den nächsten 24 Stunden am wahrscheinlichsten passiert, und erkläre warum.\nJSON-Format:\n{"markt":"2-3 Sätze zur Gesamtlage","coins":{"BTC":{"richtung":"steigt|fällt|seitwärts","sicherheit":0-100,"gruende":["kurzer Grund","kurzer Grund","kurzer Grund"],"news":[Nummern der wichtigsten Schlagzeilen]}, ...für ETH, SOL, BNB, XRP, DOGE},"risiken":["was die Prognose kippen könnte", "..."]}\nSicherheit über 70 nur bei sehr klarer Lage. Wenn eine Schlagzeile wichtig ist, beschreibe ihren Inhalt kurz auf Deutsch in den Gründen – schreibe nie "Schlagzeile 11" oder Nummern in die Gründe, Nummern gehören nur in "news". Behaupte nichts über Inflation, Fed oder andere Daten, wenn es nicht in den Schlagzeilen steht.`;
  try {
    const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], max_tokens: 1400, temperature: 0.2 });
    const txt = typeof r.response === 'string' ? r.response : JSON.stringify(r.response);
    const j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    const coins = {};
    for (const c of COINS) { const o = j.coins && j.coins[c]; if (!o) continue; const dir = /steig/i.test(o.richtung) ? 'steigt' : /f[äa]ll/i.test(o.richtung) ? 'fällt' : 'seitwärts';
      coins[c] = { richtung: dir, sicherheit: Math.max(0, Math.min(100, Math.round(+o.sicherheit || 0))), gruende: (o.gruende || []).slice(0, 4).map(s => String(s).replace(/^\s*\(?Schlagzeile\s*\[?\d+\]?\)?\s*:?\s*/i, '').slice(0, 240)),
        news: (o.news || []).map(i => news[+i]).filter(Boolean).slice(0, 3).map(n => n.title) }; }
    if (Object.keys(coins).length < 4) return null;
    return { quelle: 'KI (Llama 3.3 70B)', markt: String(j.markt || '').slice(0, 600), coins, risiken: (j.risiken || []).slice(0, 4).map(s => String(s).slice(0, 240)) };
  } catch (e) { return null; }
}

/* ---------- Prognosen nach 24 h prüfen ---------- */
function judge(f, px) {
  const ch = (px / f.px - 1) * 100;
  return { ch, ok: f.richtung === 'steigt' ? ch > 0 : f.richtung === 'fällt' ? ch < 0 : Math.abs(ch) < 1.5 };
}
export function grade(N, px, now) {
  for (const f of N.open || []) { if (f.done || now - f.t < 24 * 3600e3 || !px[f.c]) continue; const j = judge(f, px[f.c]); f.done = true; f.ch = j.ch; f.ok = j.ok;
    const s = N.stats[f.c] = N.stats[f.c] || { n: 0, ok: 0 }; s.n++; if (j.ok) s.ok++; N.stats.all = N.stats.all || { n: 0, ok: 0 }; N.stats.all.n++; if (j.ok) N.stats.all.ok++;
    N.hist.unshift({ t: f.t, c: f.c, richtung: f.richtung, sicherheit: f.sicherheit, ch: +j.ch.toFixed(2), ok: j.ok }); }
  N.open = (N.open || []).filter(f => !f.done); if (N.hist.length > 300) N.hist.length = 300;
}

// alle 2 Stunden (ungerade UTC-Stunden, damit es nicht mit den 4h-Kerzen zusammenfällt)
export async function analyze(env, S, getJSON, now) {
  let N = JSON.parse(await env.STATE.get('news') || 'null') || { open: [], hist: [], stats: {}, at: 0 };
  const slot = Math.floor(now / 7200e3);
  if (N.slot === slot && N.fc) return null;   // schon erledigt
  const px = {}; for (const c of COINS) px[c] = S.px[c];
  grade(N, px, now);
  const news = await fetchNews(), T = {};
  await Promise.all(COINS.map(async c => { const j = await getJSON(`/api/v3/klines?symbol=${c}USDT&interval=1d&limit=60`); if (j && j.length > 35) T[c] = techOf(j.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] })), px[c]); }));
  const reg = S.reg ? S.reg.tr + ' · ' + S.reg.vol : 'unbekannt';
  const pos = []; for (const v in S.vars) if (S.units[v] > 0) for (const c of COINS) { const p = S.vars[v].acc[c].pos; if (p) pos.push(`${c} ${p.side > 0 ? 'Long' : 'Short'}`); }
  const fc = (await aiForecast(env, T, news, reg, [...new Set(pos)].join(', '))) || ruleForecast(T, news, reg);
  fc.at = now; fc.reg = reg;
  for (const c in fc.coins) { if (!T[c]) continue; fc.coins[c].px = T[c].px; fc.coins[c].tech = { ch1: r1(T[c].ch1), ch7: r1(T[c].ch7), rsi: Math.round(T[c].rsi), trend: T[c].trend };
    if (slot % 3 === 0 || !N.fc) N.open.push({ t: now, c, richtung: fc.coins[c].richtung, sicherheit: fc.coins[c].sicherheit, px: T[c].px }); }   // alle 6 h eine Prognose zur Prüfung
  if (N.open.length > 200) N.open.splice(0, N.open.length - 200);
  N.fc = fc; N.news = news.map(n => ({ t: n.t, title: n.title, link: n.link, src: n.src, coins: n.coins, sent: n.sent })); N.slot = slot; N.at = now;
  await env.STATE.put('news', JSON.stringify(N));
  return N;
}
