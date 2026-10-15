require('dotenv').config();
const express = require('express'), ExcelJS = require('exceljs'), path = require('path');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const PROVIDER = (process.env.PROVIDER || (KEY ? 'google' : 'osm')).toLowerCase();
const UA = 'LocalBizFinder/1.0 (internship project)';
const MAX_REQ = Math.max(1, +process.env.MAX_REQUESTS || 150), MAX_DEPTH = +process.env.MAX_DEPTH || 4;
const GRID = Math.max(1, +process.env.GRID || 2), SPLIT_AT = +process.env.SPLIT_AT || 40;
require('./site')(app, { KEY, PROVIDER, UA }); // "Generate site" feature

const CATS = {
  'Salon': { qs: ['hair salon', 'beauty parlour', 'barber shop'], osm: ['shop=hairdresser', 'shop=beauty'] },
  'Spa': { qs: ['spa', 'massage center'], osm: ['leisure=spa', 'amenity=spa', 'beauty=spa'] },
  'Gym': { qs: ['gym', 'fitness center', 'yoga studio'], osm: ['leisure=fitness_centre'] },
  'Turf': { qs: ['sports turf', 'cricket turf', 'football ground', 'playground'], osm: ['leisure=pitch', 'leisure=sports_centre'] },
  'Tours & Travels': { qs: ['travel agency', 'tours and travels', 'tour operator'], osm: ['shop=travel_agency', 'office=travel_agent'] }
};
const FIELDS = ['nextPageToken', 'places.id', 'places.displayName', 'places.formattedAddress', 'places.nationalPhoneNumber',
  'places.websiteUri', 'places.rating', 'places.userRatingCount', 'places.regularOpeningHours', 'places.googleMapsUri',
  'places.location', 'places.businessStatus'].join(',');

const cache = new Map(); // short-lived cache to protect your quota
const memo = async (k, ttl, fn) => {
  const h = cache.get(k); if (h && Date.now() - h.t < ttl) return h.v;
  const v = await fn(); cache.set(k, { t: Date.now(), v });
  if (cache.size > 300) cache.delete(cache.keys().next().value); // drop the oldest entry
  return v;
};

async function geo(loc) { // free OpenStreetMap geocoder: place name -> bounding box
  const gr = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=' +
    encodeURIComponent(loc), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!gr.ok) throw new Error(`Location lookup failed (${gr.status}). Wait a moment and try again.`);
  const g = await gr.json();
  if (!g.length) throw new Error('Location not found. Try e.g. "Shivamogga, Karnataka".');
  const [s, n, w, e] = g[0].boundingbox.map(Number); return { s, n, w, e, name: g[0].display_name };
}

// Google returns max 60 results per search (often fewer). So: start from a GRID x GRID set of map tiles, search each tile
// with several keyword variants, and split any tile that returns SPLIT_AT+ results into 4 smaller ones.
async function google(loc, cat, budget) {
  const box = await geo(loc), out = []; budget.area = box; budget.place = box.name;
  async function cell(qText, b, depth) {
    const got = []; let token;
    for (let i = 0; i < 3; i++) {
      if (budget.used >= budget.limit) { budget.truncated = true; break; }
      budget.used++;
      const body = { textQuery: qText, regionCode: 'IN', pageSize: 20,
        locationRestriction: { rectangle: { low: { latitude: b.s, longitude: b.w }, high: { latitude: b.n, longitude: b.e } } },
        ...(token && { pageToken: token }) };
      const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': FIELDS }
      });
      const j = await r.json();
      if (!r.ok) throw new Error('Google API: ' + (j.error?.message || r.status));
      for (const p of j.places || []) {
        if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;
        got.push({
          id: p.id, name: p.displayName?.text, category: cat, address: p.formattedAddress, phone: p.nationalPhoneNumber,
          website: p.websiteUri, rating: p.rating, reviews: p.userRatingCount, openNow: p.regularOpeningHours?.openNow ?? null,
          hours: p.regularOpeningHours?.weekdayDescriptions?.join(' | '), mapUrl: p.googleMapsUri,
          lat: p.location?.latitude, lng: p.location?.longitude
        });
      }
      token = j.nextPageToken; if (!token) break;
    }
    out.push(...got);
    if (got.length >= SPLIT_AT && depth < MAX_DEPTH && budget.used < budget.limit) {
      const mn = (b.s + b.n) / 2, mw = (b.w + b.e) / 2;
      for (const q of [{ s: b.s, n: mn, w: b.w, e: mw }, { s: b.s, n: mn, w: mw, e: b.e }, { s: mn, n: b.n, w: b.w, e: mw }, { s: mn, n: b.n, w: mw, e: b.e }])
        await cell(qText, q, depth + 1);
    }
  }
  const dw = (box.e - box.w) / GRID, dh = (box.n - box.s) / GRID;
  for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) for (const qText of CATS[cat].qs)
    await cell(qText, { s: box.s + j * dh, n: box.s + (j + 1) * dh, w: box.w + i * dw, e: box.w + (i + 1) * dw }, 0);
  return out;
}

async function osm(loc, cat, budget) {
  const { s, n, w, e, name } = await geo(loc), bb = `${s},${w},${n},${e}`; budget.area = { s, n, w, e }; budget.place = name;
  const parts = CATS[cat].osm.map(t => { const [k, v] = t.split('='); return `nwr["${k}"="${v}"]["name"](${bb});`; }).join('');
  const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
  const data = 'data=' + encodeURIComponent(`[out:json][timeout:40];(${parts});out center tags 2000;`);
  let r, last = 'no response';
  for (let attempt = 0; attempt < 6 && !(r && r.ok); attempt++) { // rotate through mirrors, wait a little between tries
    if (attempt) await new Promise(ok => setTimeout(ok, 1500 * attempt));
    try {
      r = await fetch(MIRRORS[attempt % MIRRORS.length], { method: 'POST', signal: AbortSignal.timeout(45000),
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: data });
      if (!r.ok) last = r.status;
    } catch (err) { last = err.message; r = null; }
  }
  if (!r || !r.ok) throw new Error(`OpenStreetMap servers are busy (${last}). Wait a minute, or search one category in a smaller area.`);
  const j = await r.json();
  return j.elements.map(el => {
    const t = el.tags, c = el.center || el;
    const addr = ['addr:housenumber', 'addr:street', 'addr:suburb', 'addr:city', 'addr:postcode'].map(k => t[k]).filter(Boolean).join(', ');
    return {
      id: 'osm-' + el.type + el.id, name: t.name, category: cat, address: addr, phone: t.phone || t['contact:phone'],
      website: t.website || t['contact:website'], rating: null, reviews: null, openNow: null, hours: t.opening_hours,
      mapUrl: `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}`, lat: c.lat, lng: c.lon
    };
  });
}

// ---- website status: "quick" answer instantly, real check runs afterwards in batches (/api/check) ----
const SOCIAL = /(^|\.)(facebook\.com|instagram\.com|fb\.com|wa\.me|linktr\.ee|youtube\.com|twitter\.com|x\.com|justdial\.com|sulekha\.com)$/i;
const norm = u => /^https?:/i.test(u) ? u : 'https://' + u;
const PRIVATE = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*|\[?::1?\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;
function quick(url) {
  if (!url || typeof url !== 'string') return 'No website';
  let host; try { const u = new URL(norm(url)); if (!/^https?:$/.test(u.protocol)) return 'Inactive'; host = u.hostname; } catch { return 'Inactive'; }
  if (PRIVATE.test(host)) return 'Inactive'; // never fetch internal addresses
  if (SOCIAL.test(host)) return 'No website'; // social/listing page only = no real website
  const h = cache.get('w:' + norm(url)); if (h && Date.now() - h.t < 6 * 3600e3) return h.v;
  return 'Checking';
}
async function check(url) {
  const q = quick(url); if (q !== 'Checking') return q;
  url = norm(url);
  return memo('w:' + url, 6 * 3600e3, async () => {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LocalBizFinder)' } });
      return (r.status < 400 || [401, 403, 405, 429].includes(r.status)) ? 'Active' : 'Inactive';
    } catch { return 'Inactive'; }
  });
}
async function pool(items, n, fn) {
  let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}
function score(r) { // lead score 0-100: best prospects = no/dead website + phone + good rating
  let s = r.websiteStatus === 'No website' ? 40 : r.websiteStatus === 'Inactive' ? 35 : 0;
  if (r.phone) s += 20;
  if (r.rating > 3) s += Math.min(15, (r.rating - 3) * 7.5);
  if (r.reviews) s += Math.min(15, Math.log10(r.reviews + 1) * 5);
  if (r.openNow === true) s += 5;
  return Math.round(s);
}

app.get('/api/search', async (req, res) => {
  try {
    const loc = (req.query.location || '').trim(), cat = req.query.category || 'All';
    if (!loc) return res.status(400).json({ error: 'Enter a location.' });
    if (loc.length > 120) return res.status(400).json({ error: 'Location is too long.' });
    if (cat !== 'All' && !CATS[cat]) return res.status(400).json({ error: 'Unknown category.' });
    if (PROVIDER === 'google' && !KEY) return res.status(400).json({ error: 'PROVIDER=google but GOOGLE_PLACES_API_KEY is empty in .env' });
    const cats = cat === 'All' ? Object.keys(CATS) : [cat];
    const got = await memo(`s:${PROVIDER}:${loc}:${cat}`, 3600e3, async () => {
      const budget = { used: 0, limit: MAX_REQ, truncated: false, area: null, place: '' }, out = [];
      for (const [k, c] of cats.entries()) { // sequential and with a fair share of the request budget per category
        budget.limit = Math.round(MAX_REQ * (k + 1) / cats.length);
        out.push(...await (PROVIDER === 'google' ? google : osm)(loc, c, budget));
      }
      return { out, budget };
    });
    const seen = new Set(), rows = got.out.filter(r => r.name && !seen.has(r.id) && seen.add(r.id)).map(r => ({ ...r }));
    rows.forEach(r => { r.websiteStatus = quick(r.website); r.score = score(r); });
    const pct = f => rows.length ? Math.round(100 * rows.filter(f).length / rows.length) : 0;
    res.json({
      provider: PROVIDER, count: rows.length, rows, place: got.budget.place, area: got.budget.area,
      requests: got.budget.used, truncated: got.budget.truncated,
      completeness: { phone: pct(r => r.phone), website: pct(r => r.website), rating: pct(r => r.rating), hours: pct(r => r.hours) }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/check', async (req, res) => { // the page calls this in batches after the table is shown
  try {
    const items = (Array.isArray(req.body?.rows) ? req.body.rows : []).filter(r => r && typeof r === 'object').slice(0, 40);
    await pool(items, 15, async r => { r.websiteStatus = await check(r.website); r.score = score(r); });
    res.json({ results: items.map(r => ({ id: r.id, websiteStatus: r.websiteStatus, score: r.score })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/export', async (req, res) => {
  try {
    const { columns = [], rows = [], sheet = 'Businesses' } = req.body || {};
    if (!Array.isArray(columns) || !Array.isArray(rows)) return res.status(400).json({ error: 'Invalid export data.' });
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(String(sheet).replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 30) || 'Sheet1'); // Excel forbids \ / ? * [ ] : in sheet names
    ws.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width || 22 }));
    ws.getRow(1).font = { bold: true };
    rows.forEach(r => ws.addRow(Object.fromEntries(columns.map(c => [c.key, r[c.key] == null || r[c.key] === '' ? 'Not available' : r[c.key]]))));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="export.xlsx"');
    await wb.xlsx.write(res); res.end();
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); else res.end(); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LocalBizFinder running → http://localhost:${PORT}  (data source: ${PROVIDER.toUpperCase()})`));