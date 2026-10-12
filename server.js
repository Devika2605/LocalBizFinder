require('dotenv').config();
const express = require('express'), ExcelJS = require('exceljs'), path = require('path');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const PROVIDER = (process.env.PROVIDER || (KEY ? 'google' : 'osm')).toLowerCase();
const MAX_PAGES = Math.max(1, +process.env.MAX_PAGES || 1);
const UA = 'LocalBizFinder/1.0 (internship project)';
const CATS = {
  'Salon': { q: 'hair salon', osm: ['shop=hairdresser', 'shop=beauty'] },
  'Spa': { q: 'spa', osm: ['leisure=spa', 'amenity=spa', 'beauty=spa'] },
  'Gym': { q: 'gym fitness center', osm: ['leisure=fitness_centre'] },
  'Turf': { q: 'sports turf playground', osm: ['leisure=pitch', 'leisure=sports_centre'] },
  'Tours & Travels': { q: 'tours and travels agency', osm: ['shop=travel_agency', 'office=travel_agent'] }
};
const FIELDS = ['nextPageToken', 'places.id', 'places.displayName', 'places.formattedAddress', 'places.nationalPhoneNumber',
  'places.websiteUri', 'places.rating', 'places.userRatingCount', 'places.regularOpeningHours', 'places.googleMapsUri',
  'places.location', 'places.businessStatus'].join(',');

const cache = new Map(); // short-lived cache to protect your free quota
const memo = async (k, ttl, fn) => {
  const h = cache.get(k); if (h && Date.now() - h.t < ttl) return h.v;
  const v = await fn(); cache.set(k, { t: Date.now(), v }); return v;
};

async function google(loc, cat) {
  const out = []; let token;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = { textQuery: `${CATS[cat].q} in ${loc}`, regionCode: 'IN', pageSize: 20, ...(token && { pageToken: token }) };
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': FIELDS }
    });
    const j = await r.json();
    if (!r.ok) throw new Error('Google API: ' + (j.error?.message || r.status));
    for (const p of j.places || []) {
      if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;
      out.push({
        id: p.id, name: p.displayName?.text, category: cat, address: p.formattedAddress, phone: p.nationalPhoneNumber,
        website: p.websiteUri, rating: p.rating, reviews: p.userRatingCount, openNow: p.regularOpeningHours?.openNow ?? null,
        hours: p.regularOpeningHours?.weekdayDescriptions?.join(' | '), mapUrl: p.googleMapsUri,
        lat: p.location?.latitude, lng: p.location?.longitude
      });
    }
    token = j.nextPageToken; if (!token) break;
  }
  return out;
}

async function osm(loc, cat) {
  const g = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=' +
    encodeURIComponent(loc), { headers: { 'User-Agent': UA } })).json();
  if (!g.length) throw new Error('Location not found. Try e.g. "Indiranagar, Bengaluru".');
  const [s, n, w, e] = g[0].boundingbox, bb = `${s},${w},${n},${e}`;
  const parts = CATS[cat].osm.map(t => { const [k, v] = t.split('='); return `nwr["${k}"="${v}"]["name"](${bb});`; }).join('');
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(`[out:json][timeout:25];(${parts});out center tags 300;`)
  });
  if (!r.ok) throw new Error(`OpenStreetMap server busy (${r.status}). Try again in a minute.`);
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

const SOCIAL = /(^|\.)(facebook\.com|instagram\.com|fb\.com|wa\.me|linktr\.ee|youtube\.com|twitter\.com|x\.com|justdial\.com|sulekha\.com)$/i;
async function check(url) {
  if (!url) return 'No website';
  if (!/^https?:/i.test(url)) url = 'https://' + url;
  let host; try { host = new URL(url).hostname; } catch { return 'Inactive'; }
  if (SOCIAL.test(host)) return 'No website'; // social/listing page only = no real website
  return memo('w:' + url, 6 * 3600e3, async () => {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(7000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LocalBizFinder)' } });
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
    if (cat !== 'All' && !CATS[cat]) return res.status(400).json({ error: 'Unknown category.' });
    if (PROVIDER === 'google' && !KEY) return res.status(400).json({ error: 'PROVIDER=google but GOOGLE_PLACES_API_KEY is empty in .env' });
    const cats = cat === 'All' ? Object.keys(CATS) : [cat];
    const lists = await memo(`s:${PROVIDER}:${loc}:${cat}`, 3600e3, async () => {
      const out = []; for (const c of cats) out.push(...await (PROVIDER === 'google' ? google : osm)(loc, c)); return out; // sequential: polite to free servers
    });
    const seen = new Set(), rows = lists.filter(r => r.name && !seen.has(r.id) && seen.add(r.id)).map(r => ({ ...r }));
    await pool(rows, 10, async r => { r.websiteStatus = await check(r.website); });
    rows.forEach(r => r.score = score(r));
    const pct = f => rows.length ? Math.round(100 * rows.filter(f).length / rows.length) : 0;
    res.json({
      provider: PROVIDER, count: rows.length, rows,
      completeness: { phone: pct(r => r.phone), website: pct(r => r.website), rating: pct(r => r.rating), hours: pct(r => r.hours) }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/export', async (req, res) => {
  const { columns = [], rows = [], sheet = 'Businesses' } = req.body || {};
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(String(sheet).slice(0, 30));
  ws.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width || 22 }));
  ws.getRow(1).font = { bold: true };
  rows.forEach(r => ws.addRow(Object.fromEntries(columns.map(c => [c.key, r[c.key] == null || r[c.key] === '' ? 'Not available' : r[c.key]]))));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="export.xlsx"');
  await wb.xlsx.write(res); res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LocalBizFinder running → http://localhost:${PORT}  (data source: ${PROVIDER.toUpperCase()})`));
