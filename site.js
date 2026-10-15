// site.js - "Generate website" feature for LocalBizFinder.
// Builds ONE self-contained HTML page from real data only (no invented services, prices or reviews).
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const THEME = { 'Salon': ['#9d3f7a', '#fbeff6', 'salon'], 'Spa': ['#2f7a69', '#e9f5f1', 'spa'], 'Gym': ['#c2410c', '#fdeee6', 'gym'],
  'Turf': ['#2f7d46', '#e8f5ec', 'sports turf'], 'Tours & Travels': ['#1d6aa5', '#e7f1fa', 'tours and travels business'] };
const FIELD_MASK = 'id,displayName,formattedAddress,nationalPhoneNumber,websiteUri,rating,userRatingCount,regularOpeningHours,googleMapsUri,location,editorialSummary,primaryTypeDisplayName,photos,paymentOptions,parkingOptions,accessibilityOptions';

function mobile(p) { // 10-digit Indian mobile -> 91XXXXXXXXXX, else '' (landlines are not on WhatsApp)
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? '91' + d : '';
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'business';

async function details(row, ctx) { // extra info from Google Place Details (uses a little quota)
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(row.id)}`,
    { headers: { 'X-Goog-Api-Key': ctx.KEY, 'X-Goog-FieldMask': FIELD_MASK }, signal: AbortSignal.timeout(15000) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.status); return j;
}
async function photos(list, ctx) { // real photos from the Google Maps pin, embedded so the page is one file
  const out = [];
  for (const p of (list || []).slice(0, 4)) {
    try {
      const r = await fetch(`https://places.googleapis.com/v1/${p.name}/media?maxWidthPx=700&key=${ctx.KEY}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      out.push({ src: `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`,
        credit: p.authorAttributions?.[0]?.displayName || '' });
    } catch { /* skip this photo */ }
  }
  return out;
}
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

function render(d, o = {}, ph = []) {
  const [accent, tint, noun] = THEME[d.category] || THEME['Salon'];
  const name = esc(d.name), final = !!o.final;
  const disclaimer = `Preview prepared for ${name} by Susunetech. This is a draft preview created for demonstration purposes only. It is not the official website of the business and has not been approved or published by the owner.`;
  const wa = mobile(o.whatsapp) || mobile(d.phone), tel = String(d.phone || '').replace(/[^\d+]/g, '');
  const about = esc(o.about || d.about || `${d.name} is a ${noun}${d.address ? ' located at ' + d.address : ''}.`);
  const services = String(o.services || '').split('\n').map(s => s.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(.*?)\s*(?:[-–|:]\s*)((?:₹|rs\.?|inr)?\s*\d[\d,.]*.*)$/i); return m ? [m[1], m[2]] : [l, ''];
  });
  const maps = d.mapUrl || (d.lat ? `https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}` : '');
  const hrs = d.hoursList.map(h => { const i = h.indexOf(':'); return i > 0 ? `<li><span>${esc(h.slice(0, i))}</span><b>${esc(h.slice(i + 1).trim())}</b></li>` : `<li><b>${esc(h)}</b></li>`; }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${final ? '' : '<meta name="robots" content="noindex, nofollow">\n'}<title>${name}</title><meta name="description" content="${about.slice(0, 150)}">
<style>
:root{--a:${accent};--t:${tint};--ink:#1d2430;--mut:#5f6773;--line:#e6e3de}*{box-sizing:border-box}
body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:#fff}
h1,h2{font-family:Georgia,'Times New Roman',serif;line-height:1.2}.w{max-width:960px;margin:0 auto;padding:0 20px}
.pv{position:sticky;top:0;z-index:9;background:#fff3cd;color:#5b4500;font-size:13px;padding:8px 16px;text-align:center;border-bottom:1px solid #ecd58a}
.hero{background:var(--t);padding:48px 0 40px}.kind{color:var(--a);font-weight:600;margin:0}.hero h1{font-size:clamp(30px,6vw,50px);margin:6px 0 10px}
.chip{display:inline-block;background:#fff;border:1px solid var(--line);border-radius:99px;padding:3px 12px;font-size:14px}
.cta{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.btn{display:inline-block;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;border:2px solid var(--a);color:var(--a);background:#fff}
.btn.p{background:var(--a);color:#fff}.btn.wa{background:#1f9d55;border-color:#1f9d55;color:#fff}
section{padding:34px 0;border-bottom:1px solid var(--line)}h2{font-size:26px;margin:0 0 14px}
.svc,.hours{list-style:none;margin:0;padding:0;max-width:560px}.svc li,.hours li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}
.tags{list-style:none;display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:0}.tags li{background:var(--t);border-radius:99px;padding:5px 14px;font-size:14px}
.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}.gal img{width:100%;height:180px;object-fit:cover;border-radius:10px;display:block}
.gal figcaption{font-size:12px;color:var(--mut)}figure{margin:0}iframe{width:100%;height:300px;border:0;border-radius:12px;margin-top:14px}
footer{padding:26px 0 40px;font-size:13px;color:var(--mut)}.mut{color:var(--mut)}
</style></head><body>
${final ? '' : `<div class="pv" role="note">${disclaimer}</div>\n`}<header class="hero"><div class="w">
<p class="kind">${esc(d.kind || d.category)}</p><h1>${name}</h1>
${d.rating ? `<span class="chip">★ ${esc(d.rating)} on Google${d.reviews ? ` (${esc(d.reviews)} reviews)` : ''}</span>` : ''}
<div class="cta">${tel ? `<a class="btn p" href="tel:${esc(tel)}">Call now</a>` : ''}${wa ? `<a class="btn wa" href="https://wa.me/${wa}?text=${encodeURIComponent('Hello, I found ' + d.name + ' online and would like to know more.')}">WhatsApp</a>` : ''}${maps ? `<a class="btn" href="${esc(maps)}" target="_blank" rel="noopener">Get directions</a>` : ''}</div></div></header>
<main class="w">
<section id="about"><h2>About</h2><p>${about}</p></section>
${services.length ? `<section id="services"><h2>Services &amp; prices</h2><ul class="svc">${services.map(x => `<li><span>${esc(x[0])}</span><b>${esc(x[1])}</b></li>`).join('')}</ul></section>`
  : (tel || wa) ? `<section id="services"><h2>Services &amp; prices</h2><p>Please call${wa ? ' or message us on WhatsApp' : ''} to ask about our current services and prices.</p></section>` : ''}
${d.tags.length ? `<section id="info"><h2>Good to know</h2><ul class="tags">${d.tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>` : ''}
${hrs ? `<section id="hours"><h2>Opening hours</h2><ul class="hours">${hrs}</ul></section>` : ''}
${ph.length ? `<section id="gallery"><h2>Photos</h2><div class="gal">${ph.map(p => `<figure><img src="${p.src}" alt="${name}" loading="lazy">${p.credit ? `<figcaption>Photo: ${esc(p.credit)} via Google Maps</figcaption>` : ''}</figure>`).join('')}</div></section>` : ''}
<section id="contact"><h2>Contact</h2>${d.address ? `<p>${esc(d.address)}</p>` : ''}${d.phone ? `<p>Phone: <a href="tel:${esc(tel)}">${esc(d.phone)}</a></p>` : ''}
${maps ? `<p><a href="${esc(maps)}" target="_blank" rel="noopener">Open in Google Maps</a></p>` : ''}
${d.lat ? `<iframe title="Map" loading="lazy" src="https://www.google.com/maps?q=${d.lat},${d.lng}&z=16&output=embed"></iframe>` : ''}</section>
</main><footer><div class="w">${final ? `&copy; ${name}` : disclaimer}<br>Rating and map data from Google Maps.</div></footer></body></html>`;
}

module.exports = (app, ctx) => {
  app.post('/api/site', async (req, res) => {
    try {
      const { row, options = {} } = req.body || {};
      if (!row || !row.name) return res.status(400).json({ error: 'Missing business data.' });
      const notes = []; let det = {};
      const isGoogle = ctx.PROVIDER === 'google' && ctx.KEY && !String(row.id).startsWith('osm-');
      if (isGoogle) { try { det = await details(row, ctx); } catch (e) { notes.push(`Extra Google details unavailable (${e.message}). Built from the search data only.`); } }
      let ph = [];
      const wantPhotos = options.photos ?? (process.env.SITE_PHOTOS !== 'false'); // photos from the Google Maps pin; set SITE_PHOTOS=false in .env to save quota
      if (wantPhotos && isGoogle) {
        if (det.photos?.length) { ph = await photos(det.photos, ctx); if (!ph.length) notes.push('Photos could not be loaded, so the gallery was left out.'); }
        else notes.push('No photos found on the Google Maps pin, so the gallery was left out. Ask the owner to send photos.');
      }
      if (options.final) notes.push('FINAL version: preview banner and noindex were removed. Only share this after the owner approved.');
      const d = merge(row, det);
      res.json({ html: render(d, options, ph), filename: slug(d.name) + (options.final ? '' : '-preview') + '.html', notes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
module.exports.render = render; module.exports.merge = merge;