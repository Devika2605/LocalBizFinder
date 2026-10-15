// site.js - "Generate website" feature for LocalBizFinder.
// Builds ONE self-contained HTML page per business from real data only (no invented services, prices or reviews).
//
// v2: * TEMPLATE GENERATOR - every business gets its own look. A look = layout x colour palette x font pair x shape style,
//       picked from a seed (business id + "re-roll" counter), so hundreds of distinct designs come out of 4 layouts.
//     * PHOTO CHAIN - Google Maps photos -> stock photos (Pexels / Unsplash if you add a key, Wikimedia Commons with no key)
//       -> generated illustration. A page therefore never ends up without images.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FIELD_MASK = 'id,displayName,formattedAddress,nationalPhoneNumber,websiteUri,rating,userRatingCount,regularOpeningHours,googleMapsUri,location,editorialSummary,primaryTypeDisplayName,photos,paymentOptions,parkingOptions,accessibilityOptions';
const UA = 'LocalBizFinder/1.0 (internship project)';

// ---------------------------------------------------------------- seeded randomness
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
const shuffle = (r, a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------------------------------------------------------------- design parts the generator mixes
// palette = [accent, tint (light background), dark (for dark layouts)]
const NOUN = { 'Salon': 'salon', 'Spa': 'spa', 'Gym': 'gym', 'Turf': 'sports turf', 'Tours & Travels': 'tours and travels business' };
const PALETTES = {
  'Salon': [['#9d3f7a', '#fbeff6', '#2a1424'], ['#6b3fa0', '#f3edfa', '#1d1430'], ['#c2455a', '#fdecef', '#2b1218'], ['#b7791f', '#fdf5e6', '#2b2110'], ['#0f766e', '#e6f6f4', '#0e2523']],
  'Spa': [['#2f7a69', '#e9f5f1', '#10241f'], ['#6d7f3c', '#f2f5e6', '#1d2210'], ['#8a6a4f', '#f6efe8', '#251b13'], ['#4a6fa5', '#e9f0f9', '#13203a'], ['#a35d7e', '#f9eef3', '#2a1520']],
  'Gym': [['#c2410c', '#fdeee6', '#1c1410'], ['#dc2626', '#fdeaea', '#1a0f0f'], ['#1d4ed8', '#e8eefc', '#0d1530'], ['#65a30d', '#f0f7e1', '#141c08'], ['#7c3aed', '#f1eafd', '#17102b']],
  'Turf': [['#2f7d46', '#e8f5ec', '#0f2418'], ['#0f766e', '#e4f5f3', '#0b2220'], ['#ca8a04', '#fdf6dc', '#241c05'], ['#1d6aa5', '#e7f1fa', '#0e1f2e'], ['#15803d', '#eaf7ee', '#0c2013']],
  'Tours & Travels': [['#1d6aa5', '#e7f1fa', '#0e1f2e'], ['#c2410c', '#fdeee6', '#2a150c'], ['#0e7490', '#e2f4f8', '#0a222a'], ['#7c3aed', '#f1eafd', '#17102b'], ['#be123c', '#fde8ee', '#2a0d16']]
};
const FONTS = [
  { h: "Georgia,'Times New Roman',serif", b: "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", up: false },
  { h: "'Trebuchet MS','Segoe UI',system-ui,sans-serif", b: "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", up: false },
  { h: "Palatino,'Palatino Linotype','Book Antiqua',Georgia,serif", b: "Georgia,'Times New Roman',serif", up: false },
  { h: "'Arial Black','Helvetica Neue',Arial,sans-serif", b: "Arial,'Helvetica Neue',sans-serif", up: true },
  { h: "Verdana,Tahoma,system-ui,sans-serif", b: "Verdana,Tahoma,system-ui,sans-serif", up: false }
];
const SHAPES = [{ r: 4, btn: 4 }, { r: 12, btn: 10 }, { r: 22, btn: 99 }];
const LAYOUTS = ['split', 'cover', 'center', 'bold'];
const GALLERY = ['grid', 'masonry', 'strip'];
const SERVICES = ['list', 'cards'];

function mobile(p) { // 10-digit Indian mobile -> 91XXXXXXXXXX, else '' (landlines are not on WhatsApp)
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? '91' + d : '';
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'business';

// ---------------------------------------------------------------- Google details
async function details(row, ctx) { // extra info from Google Place Details (uses a little quota)
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(row.id)}`,
    { headers: { 'X-Goog-Api-Key': ctx.KEY, 'X-Goog-FieldMask': FIELD_MASK }, signal: AbortSignal.timeout(15000) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.status); return j;
}
async function toDataUri(url, opt = {}) { // download an image and embed it, so the page stays ONE file
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, ...(opt.headers || {}) } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new Error('not an image: ' + type);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 1.8e6) throw new Error('image too large');
  return `data:${type};base64,${buf.toString('base64')}`;
}

// 1) real photos from the Google Maps pin
async function googlePhotos(list, ctx, notes) {
  const out = [], errs = [];
  for (const p of (list || []).slice(0, 5)) {
    if (out.length >= 4) break;
    try { out.push({ src: await toDataUri(`https://places.googleapis.com/v1/${p.name}/media?maxWidthPx=900&key=${ctx.KEY}`),
      credit: p.authorAttributions?.[0]?.displayName || '', kind: 'google' }); }
    catch (e) { errs.push(e.message); }
  }
  if (!out.length && errs.length) notes.push(`Google listed photos but they could not be downloaded (${errs[0]}). Check that "Places API (New)" photo access is allowed for your key.`);
  return out;
}

// 2) stock photos matched to the category (never the business's own premises, so they are labelled "Sample image")
const STOCK_Q = {
  'Salon': ['hair salon interior', 'barber shop', 'beauty salon hairdresser', 'hair styling'],
  'Spa': ['spa massage', 'spa interior wellness', 'aromatherapy spa', 'wellness spa towels'],
  'Gym': ['gym interior', 'fitness center weights', 'yoga studio', 'personal trainer gym'],
  'Turf': ['football turf ground', 'cricket ground', 'artificial turf pitch', 'sports field floodlights'],
  'Tours & Travels': ['travel India tourism', 'tour bus travel', 'Kerala backwaters', 'Himalaya mountains travel']
};
const poolCache = new Map();
async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json();
}
async function pexels(q) {
  const j = await fetchJson(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=15&orientation=landscape`, { Authorization: process.env.PEXELS_API_KEY });
  return (j.photos || []).map(p => ({ url: p.src.large, credit: p.photographer, source: 'Pexels' }));
}
async function unsplash(q) {
  const j = await fetchJson(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=15&orientation=landscape&client_id=${process.env.UNSPLASH_ACCESS_KEY}`);
  return (j.results || []).map(p => ({ url: p.urls.regular, credit: p.user?.name, source: 'Unsplash' }));
}
async function commons(q) { // no key needed; only freely licensed (CC / public domain) JPEGs
  const j = await fetchJson('https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=30'
    + `&gsrsearch=${encodeURIComponent(q + ' filetype:bitmap')}&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=900&origin=*`);
  return Object.values(j.query?.pages || {}).map(p => p.imageinfo?.[0]).filter(i => i && i.mime === 'image/jpeg' && i.width >= 900 && i.height >= 500
    && /^(CC|Public domain|PD)/i.test(i.extmetadata?.LicenseShortName?.value || '')).map(i => ({
    url: i.thumburl, source: 'Wikimedia Commons', credit: String(i.extmetadata?.Artist?.value || '').replace(/<[^>]*>/g, '').trim().slice(0, 60) }));
}
async function stockPool(cat, q) {
  const key = cat + '|' + q, hit = poolCache.get(key);
  if (hit && Date.now() - hit.t < 6 * 3600e3) return hit.v;
  const order = [];
  if (process.env.PEXELS_API_KEY) order.push(pexels);
  if (process.env.UNSPLASH_ACCESS_KEY) order.push(unsplash);
  order.push(commons);
  let v = [];
  for (const fn of order) { try { v = await fn(q); if (v.length >= 4) break; } catch { /* try next source */ } }
  poolCache.set(key, { t: Date.now(), v }); return v;
}
async function stockPhotos(cat, r, notes) {
  const qs = shuffle(r, STOCK_Q[cat] || STOCK_Q['Salon']), out = [], seen = new Set();
  for (const q of qs.slice(0, 2)) {
    const pool = shuffle(r, await stockPool(cat, q));
    for (const p of pool) {
      if (out.length >= 4) break;
      if (seen.has(p.url)) continue; seen.add(p.url);
      try { out.push({ src: await toDataUri(p.url), credit: [p.credit, p.source].filter(Boolean).join(' / '), kind: 'stock' }); } catch { /* skip */ }
    }
    if (out.length >= 4) break;
  }
  if (!out.length) notes.push('Stock photo sources did not respond (network blocked or no API key). Used a generated illustration instead.');
  return out;
}

// 3) last resort that can never fail: a generated illustration in the page palette
function artImage(cat, P, r) {
  const [a, t, d] = P, W = 900, H = 560;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${d}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/>`;
  for (let i = 0; i < 7; i++) s += `<circle cx="${Math.round(r() * W)}" cy="${Math.round(r() * H)}" r="${40 + Math.round(r() * 150)}" fill="${i % 2 ? t : '#fff'}" opacity="${(0.05 + r() * 0.12).toFixed(2)}"/>`;
  s += `<path d="M0 ${H * 0.78} Q ${W * 0.25} ${H * 0.62} ${W * 0.5} ${H * 0.76} T ${W} ${H * 0.7} V ${H} H 0 Z" fill="#fff" opacity=".1"/>`;
  s += `<path d="M0 ${H * 0.88} Q ${W * 0.3} ${H * 0.76} ${W * 0.6} ${H * 0.88} T ${W} ${H * 0.84} V ${H} H 0 Z" fill="#fff" opacity=".12"/></svg>`;
  return { src: 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64'), credit: '', kind: 'art' };
}

// ---------------------------------------------------------------- merge Google details into the row
function merge(row, d) {
  const tags = [], po = d.paymentOptions || {}, pk = d.parkingOptions || {}, ac = d.accessibilityOptions || {}; // only things Google lists as true
  if (po.acceptsCreditCards || po.acceptsDebitCards) tags.push('Cards accepted');
  if (po.acceptsNfc) tags.push('Contactless payments');
  if (Object.values(pk).some(v => v === true)) tags.push('Parking available');
  if (ac.wheelchairAccessibleEntrance) tags.push('Wheelchair-accessible entrance');
  return { tags, ...row, name: d.displayName?.text || row.name, address: d.formattedAddress || row.address, phone: d.nationalPhoneNumber || row.phone,
    rating: d.rating ?? row.rating, reviews: d.userRatingCount ?? row.reviews, mapUrl: d.googleMapsUri || row.mapUrl,
    lat: d.location?.latitude ?? row.lat, lng: d.location?.longitude ?? row.lng, about: d.editorialSummary?.text || '',
    kind: d.primaryTypeDisplayName?.text || '', hoursList: d.regularOpeningHours?.weekdayDescriptions || (row.hours ? String(row.hours).split(/\s*[|;]\s*/) : []) };
}

// ---------------------------------------------------------------- pick a design
function design(d, o) {
  const r = rng(hash(`${d.id || d.name}|${o.seed || 0}`));
  const L = LAYOUTS.includes(o.template) ? o.template : pick(r, LAYOUTS), cat = PALETTES[d.category] ? d.category : 'Salon';
  const pi = Math.floor(r() * PALETTES[cat].length), fi = Math.floor(r() * FONTS.length);
  return { L, P: PALETTES[cat][pi], F: FONTS[fi], S: pick(r, SHAPES), gal: pick(r, GALLERY), svc: pick(r, SERVICES),
    dark: L === 'bold', id: `${L}-p${pi}-f${fi}` };
}

function css(g) {
  const [a, t, dk] = g.P, dark = g.dark, up = g.F.up;
  return `:root{--a:${a};--t:${t};--rad:${g.S.r}px;--btn:${g.S.btn}px;--bg:${dark ? dk : '#fff'};--ink:${dark ? '#f3f4f6' : '#1d2430'};--mut:${dark ? '#aab0bb' : '#5f6773'};--line:${dark ? 'rgba(255,255,255,.14)' : '#e6e3de'};--card:${dark ? 'rgba(255,255,255,.06)' : t}}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 ${g.F.b};color:var(--ink);background:var(--bg)}
h1,h2,h3{font-family:${g.F.h};line-height:1.15;${up ? 'text-transform:uppercase;letter-spacing:.02em;' : ''}}.w{max-width:1000px;margin:0 auto;padding:0 20px}
.pv{position:sticky;top:0;z-index:20;background:#fff3cd;color:#5b4500;font-size:13px;padding:8px 16px;text-align:center;border-bottom:1px solid #ecd58a}
nav{background:${dark ? 'rgba(0,0,0,.25)' : '#fff'};border-bottom:1px solid var(--line)}nav .w{display:flex;gap:18px;align-items:center;padding-top:12px;padding-bottom:12px;flex-wrap:wrap}
nav b{font-family:${g.F.h};margin-right:auto;color:var(--a)}nav a{color:var(--ink);text-decoration:none;font-size:14px}
.kind{color:var(--a);font-weight:700;margin:0;letter-spacing:.04em;text-transform:uppercase;font-size:13px}.hero h1{font-size:clamp(32px,6vw,56px);margin:8px 0 12px}
.chip{display:inline-block;background:${dark ? 'rgba(255,255,255,.1)' : '#fff'};color:inherit;border:1px solid var(--line);border-radius:99px;padding:3px 12px;font-size:14px}
.cta{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.btn{display:inline-block;padding:12px 22px;border-radius:var(--btn);text-decoration:none;font-weight:700;border:2px solid var(--a);color:var(--a);background:transparent}
.btn.p{background:var(--a);color:#fff}.btn.wa{background:#1f9d55;border-color:#1f9d55;color:#fff}
.hero img.hi{width:100%;height:100%;min-height:280px;max-height:440px;object-fit:cover;border-radius:var(--rad);display:block}
.hero.split{background:var(--t);padding:56px 0}.split .hg{display:grid;grid-template-columns:1.05fr 1fr;gap:36px;align-items:center}
.hero.cover{padding:120px 0 90px;color:#fff;background-size:cover;background-position:center}.cover .kind{color:#fff;opacity:.9}.cover .chip{background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.4)}.cover .btn:not(.p):not(.wa){color:#fff;border-color:#fff}
.hero.center{background:var(--t);padding:54px 0 0;text-align:center}.center .cta{justify-content:center}.center .bn{margin-top:34px;transform:translateY(34px)}.center .bn img{max-height:380px;box-shadow:0 14px 40px rgba(0,0,0,.18)}.center+main{padding-top:34px}
.hero.bold{padding:70px 0;border-left:10px solid var(--a)}.bold .hg{display:grid;grid-template-columns:1fr 1fr;gap:34px;align-items:center}.bold h1{font-size:clamp(34px,6.5vw,64px)}.bold .hi{outline:3px solid var(--a);outline-offset:6px}
section{padding:36px 0;border-bottom:1px solid var(--line)}h2{font-size:27px;margin:0 0 16px}h2::after{content:"";display:block;width:46px;height:4px;background:var(--a);border-radius:4px;margin-top:8px}
.svc,.hours{list-style:none;margin:0;padding:0;max-width:600px}.svc li,.hours li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}
.svc.cards{max-width:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.svc.cards li{flex-direction:column;border:1px solid var(--line);background:var(--card);border-radius:var(--rad);padding:16px;gap:4px}
.tags{list-style:none;display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:0}.tags li{background:var(--card);border:1px solid var(--line);border-radius:99px;padding:5px 14px;font-size:14px}
.gal{display:grid;gap:12px}.gal.grid{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}.gal.grid img{height:190px}.gal.masonry{display:block;columns:3 220px;column-gap:12px}.gal.masonry figure{break-inside:avoid;margin-bottom:12px}.gal.masonry img{height:auto}
.gal.strip{grid-auto-flow:column;grid-auto-columns:minmax(270px,1fr);overflow-x:auto}.gal.strip img{height:210px}.gal img{width:100%;object-fit:cover;border-radius:var(--rad);display:block}
figcaption{font-size:12px;color:var(--mut);margin-top:4px}figure{margin:0}iframe{width:100%;height:300px;border:0;border-radius:var(--rad);margin-top:14px}a{color:var(--a)}
footer{padding:26px 0 40px;font-size:13px;color:var(--mut)}
@media(max-width:720px){.split .hg,.bold .hg{grid-template-columns:1fr}.hero.cover{padding:80px 0 60px}}`;
}

function render(d, o = {}, ph = []) {
  const g = o._g || design(d, o), noun = NOUN[d.category] || 'local business';
  const name = esc(d.name), final = !!o.final;
  const disclaimer = `Preview prepared for ${name} by Susunetech. This is a draft preview created for demonstration purposes only. It is not the official website of the business and has not been approved or published by the owner.`;
  const wa = mobile(o.whatsapp) || mobile(d.phone), tel = String(d.phone || '').replace(/[^\d+]/g, '');
  const about = esc(o.about || d.about || `${d.name} is a ${noun}${d.address ? ' located at ' + d.address : ''}.`);
  const services = String(o.services || '').split('\n').map(s => s.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(.*?)\s*(?:[-–|:]\s*)((?:₹|rs\.?|inr)?\s*\d[\d,.]*.*)$/i); return m ? [m[1], m[2]] : [l, ''];
  });
  const maps = d.mapUrl || (d.lat ? `https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}` : '');
  const hrs = (d.hoursList || []).map(h => { const i = h.indexOf(':'); return i > 0 ? `<li><span>${esc(h.slice(0, i))}</span><b>${esc(h.slice(i + 1).trim())}</b></li>` : `<li><b>${esc(h)}</b></li>`; }).join('');
  const hero = ph[0], rest = ph.slice(1), usedStock = ph.some(p => p.kind === 'stock'), art = ph.length === 1 && ph[0].kind === 'art';
  const cap = p => p.kind === 'google' ? (p.credit ? `Photo: ${esc(p.credit)} via Google Maps` : '') : p.kind === 'stock' ? `Sample image${p.credit ? ' · ' + esc(p.credit) : ''}` : '';
  const heroImg = hero ? `<img class="hi" src="${hero.src}" alt="${name}">` : '';
  const text = `<p class="kind">${esc(d.kind || d.category)}</p><h1>${name}</h1>
${d.rating ? `<span class="chip">★ ${esc(d.rating)} on Google${d.reviews ? ` (${esc(d.reviews)} reviews)` : ''}</span>` : ''}
<div class="cta">${tel ? `<a class="btn p" href="tel:${esc(tel)}">Call now</a>` : ''}${wa ? `<a class="btn wa" href="https://wa.me/${wa}?text=${encodeURIComponent('Hello, I found ' + d.name + ' online and would like to know more.')}">WhatsApp</a>` : ''}${maps ? `<a class="btn" href="${esc(maps)}" target="_blank" rel="noopener">Get directions</a>` : ''}</div>`;
  const header = g.L === 'split' ? `<header class="hero split"><div class="w hg"><div>${text}</div><div>${heroImg}</div></div></header>`
    : g.L === 'cover' ? `<header class="hero cover" style="background-image:linear-gradient(rgba(0,0,0,.52),rgba(0,0,0,.62)),url('${hero ? hero.src : ''}')"><div class="w">${text}</div></header>`
    : g.L === 'center' ? `<header class="hero center"><div class="w">${text}<div class="bn">${heroImg}</div></div></header>`
    : `<header class="hero bold"><div class="w hg"><div>${text}</div><div>${heroImg}</div></div></header>`;
  const links = [['about', 'About'], ['services', 'Services'], hrs && ['hours', 'Hours'], rest.length && ['gallery', 'Photos'], ['contact', 'Contact']].filter(Boolean);
  const nav = g.L === 'center' || g.L === 'bold' ? `<nav><div class="w"><b>${name}</b>${links.map(([h, t]) => `<a href="#${h}">${t}</a>`).join('')}</div></nav>\n` : '';
  const gallery = rest.length && !art ? `<section id="gallery"><h2>Photos</h2><div class="gal ${g.gal}">${rest.map(p => `<figure><img src="${p.src}" alt="${name}" loading="lazy">${cap(p) ? `<figcaption>${cap(p)}</figcaption>` : ''}</figure>`).join('')}</div></section>` : '';
  const note = usedStock ? 'Images are illustrative sample photos, not pictures of this business.' : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${final ? '' : '<meta name="robots" content="noindex, nofollow">\n'}<meta name="generator" content="LocalBizFinder template ${esc(g.id)}"><title>${name}</title><meta name="description" content="${about.slice(0, 150)}">
<style>
${css(g)}
</style></head><body>
${final ? '' : `<div class="pv" role="note">${disclaimer}</div>\n`}${nav}${header}
<main class="w">
<section id="about"><h2>About</h2><p>${about}</p></section>
${services.length ? `<section id="services"><h2>Services &amp; prices</h2><ul class="svc ${g.svc === 'cards' ? 'cards' : ''}">${services.map(x => `<li><span>${esc(x[0])}</span><b>${esc(x[1])}</b></li>`).join('')}</ul></section>`
  : (tel || wa) ? `<section id="services"><h2>Services &amp; prices</h2><p>Please call${wa ? ' or message us on WhatsApp' : ''} to ask about our current services and prices.</p></section>` : ''}
${d.tags.length ? `<section id="info"><h2>Good to know</h2><ul class="tags">${d.tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>` : ''}
${hrs ? `<section id="hours"><h2>Opening hours</h2><ul class="hours">${hrs}</ul></section>` : ''}
${gallery}
<section id="contact"><h2>Contact</h2>${d.address ? `<p>${esc(d.address)}</p>` : ''}${d.phone ? `<p>Phone: <a href="tel:${esc(tel)}">${esc(d.phone)}</a></p>` : ''}
${maps ? `<p><a href="${esc(maps)}" target="_blank" rel="noopener">Open in Google Maps</a></p>` : ''}
${d.lat ? `<iframe title="Map" loading="lazy" src="https://www.google.com/maps?q=${d.lat},${d.lng}&z=16&output=embed"></iframe>` : ''}</section>
</main><footer><div class="w">${final ? `&copy; ${name}` : disclaimer}<br>Rating and map data from Google Maps.${note ? '<br>' + note : ''}</div></footer></body></html>`;
}

module.exports = (app, ctx) => {
  app.post('/api/site', async (req, res) => {
    try {
      const { row, options = {} } = req.body || {};
      if (!row || !row.name) return res.status(400).json({ error: 'Missing business data.' });
      const notes = []; let det = {};
      const isGoogle = ctx.PROVIDER === 'google' && ctx.KEY && !String(row.id).startsWith('osm-');
      if (isGoogle) { try { det = await details(row, ctx); } catch (e) { notes.push(`Extra Google details unavailable (${e.message}). Built from the search data only.`); } }
      const d = merge(row, det), g = design(d, options), r = rng(hash(`ph|${d.id || d.name}|${options.seed || 0}`));
      const wantPhotos = options.photos ?? (process.env.SITE_PHOTOS !== 'false');
      let ph = [], source = 'none';
      if (wantPhotos) {
        if (isGoogle && det.photos?.length) { ph = await googlePhotos(det.photos, ctx, notes); if (ph.length) source = 'Google Maps'; }
        if (!ph.length && process.env.STOCK_PHOTOS !== 'false') { ph = await stockPhotos(d.category, r, notes); if (ph.length) source = 'stock photos'; }
      }
      if (!ph.length) { ph = [artImage(d.category, g.P, r)]; source = 'generated illustration'; }
      if (source === 'stock photos') notes.push('No Google Maps photos for this business, so sample stock photos were used and labelled as such. Replace them with the owner\'s own photos before the final version.');
      if (options.final) notes.push('FINAL version: preview banner and noindex were removed. Only share this after the owner approved.');
      res.json({ html: render(d, { ...options, _g: g }, ph), filename: slug(d.name) + (options.final ? '' : '-preview') + '.html', notes,
        template: { layout: g.L, id: g.id }, photoSource: source });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
module.exports.render = render; module.exports.merge = merge; module.exports.design = design; module.exports.artImage = artImage;