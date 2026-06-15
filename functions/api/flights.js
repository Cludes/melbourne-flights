/**
 * Cloudflare Pages Function - GET /api/flights
 *
 * Australia-wide live aircraft. The keyless community ADS-B APIs cap each query at
 * ~250nm, so we fetch a grid of points across the populated arc + interior, merge and
 * de-dupe by ICAO hex. Each point tries several keyless aggregators in order (they
 * rate-limit Cloudflare's shared egress IPs differently). Adds CORS, edge-caches 20s.
 */

const UA = 'australia-flights/1.0 (+https://melbourne-flights.pages.dev)';
const CACHE_TTL = 20;

// [lat, lon, radius_nm] - capitals + interior, ~250nm each, covering populated Australia.
const POINTS = [
  [-31.95, 115.86, 250], // Perth
  [-34.0, 138.0, 250],   // Adelaide / west VIC
  [-39.0, 146.0, 250],   // Melbourne / Tasmania / Bass Strait
  [-34.0, 150.5, 250],   // Sydney / ACT / NSW
  [-27.5, 152.0, 250],   // Brisbane / SE QLD
  [-19.0, 146.0, 250],   // Townsville / north QLD
  [-13.5, 131.5, 250],   // Darwin / Top End
  [-24.0, 134.0, 250],   // Alice Springs / interior
];

const HOSTS = [
  (la, lo, d) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${d}`,
  (la, lo, d) => `https://api.airplanes.live/v2/point/${la}/${lo}/${d}`,
  (la, lo, d) => `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/${d}`,
];

async function fetchPoint([la, lo, d]) {
  for (const host of HOSTS) {
    try {
      const r = await fetch(host(la, lo, d), { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && Array.isArray(j.ac)) return j.ac;
    } catch (e) { /* try next host */ }
  }
  return [];
}

export async function onRequestOptions() {
  return cors(new Response(null, { status: 204 }));
}

export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + '/__flights_au', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cors(cached);

  const results = await Promise.all(POINTS.map(fetchPoint));

  const seen = new Set();
  const aircraft = [];
  for (const arr of results) {
    for (const a of arr) {
      if (a.lat == null || a.lon == null) continue;
      if (a.alt_baro === 'ground') continue;
      if (seen.has(a.hex)) continue;
      seen.add(a.hex);
      aircraft.push({
        hex: a.hex,
        flight: (a.flight || '').trim() || null,
        reg: a.r || null,
        type: a.t || null,
        lat: a.lat,
        lon: a.lon,
        alt: typeof a.alt_baro === 'number' ? a.alt_baro : (a.alt_geom ?? null),
        speed: a.gs ?? null,
        track: a.track ?? a.true_heading ?? null,
        vsi: a.baro_rate ?? a.geom_rate ?? null,
        squawk: a.squawk || null,
      });
    }
  }

  if (!aircraft.length) return cors(json({ error: 'all upstream sources failed' }, 502));

  const resp = json({ fetched_at: new Date().toISOString(), count: aircraft.length, aircraft });
  resp.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
  context.waitUntil(cache.put(cacheKey, resp.clone()));
  return cors(resp);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function cors(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  return new Response(resp.body, { status: resp.status, headers: h });
}
