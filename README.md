# LocalBizFinder — Group C Location Finder

Finds salons, spas, gyms, turfs/playgrounds and tours & travels in any Indian city or area, checks whether each
business has an **Active / Inactive / No website**, ranks prospects with a lead score, exports to Excel, and
keeps a lead-tracking sheet. The API key stays on the server (`.env`), never in the browser or GitHub.

**Deployed web** : https://localbizfinder.onrender.com/

## 1. Run it
1. Install **Node.js 18 or newer** (https://nodejs.org). Check with `node -v`.
2. Open a terminal in this folder and run:
   ```
   npm install
   cp .env.example .env        (Windows: copy .env.example .env)
   npm start
   ```
3. Open **http://localhost:3000**. Type a location (e.g. `Indiranagar, Bengaluru`), pick a category, press Search.

With an empty `.env` it uses free **OpenStreetMap** (no card, no key, but few phone numbers/ratings).

## 2. (Recommended) Use Google Places for accurate data
1. Google Cloud Console → create a project → enable billing → enable **Places API (New)**.
2. Credentials → Create API key → restrict it to *Places API (New)* only.
3. **Set a quota** (APIs & Services → Places API (New) → Quotas) and a budget alert, so you can't be billed by surprise.
4. Put the key in `.env`: `GOOGLE_PLACES_API_KEY=your_key` and restart `npm start`.
- Each search = 1 request per category per page (`MAX_PAGES`, 20 results/page). "All" categories = 5 requests.
  Results are cached for 1 hour. Free monthly caps are per SKU (phone/website/rating/hours fields use the
  smaller Enterprise cap) — check Google's current pricing page.
- Ask your mentor to confirm Google's terms allow your Excel export before relying on it.

## 3. How to use it
- **Search → table**: Name, Category, Address, Rating, Opening hours, Website, Status (green/red/grey), Phone, Score, Map.
  Missing data shows "Not available".
- Click a **stat card** to filter; tick **Only no website / inactive**; use **Sort by**; **Export Excel** downloads exactly what the table shows.
- ☆ saves a lead → **Saved Leads** is your tracking sheet (contact status, preview link, feedback, agreed charge, outcome, notes) with Excel export. Data is stored in your browser only.
- **Reports** shows data completeness (phone/website/rating/hours %) for your final report. **About** has the preview disclaimer and noindex line.
- Lead score (0–100): no website +40, inactive +35, phone +20, rating above 3 up to +15, review count up to +15, open now +5.
- Websites using only Facebook / Instagram / Justdial etc. are labelled **No website** (they still need a real site).

