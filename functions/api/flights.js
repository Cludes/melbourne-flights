/**
 * Cloudflare Pages Function - GET /api/flights
 *
 * Proxies the keyless adsb.lol community ADS-B feed (which sends no CORS), adds
 * CORS, trims it to what the map needs, and edge-caches for 10s so all visitors
 * share one upstream fetch (polite to the free API).
 */

// Keyless community ADS-B aggregators, all returning the same {ac:[...]} shape.
// Tried in order until one responds 200 - they rate-limit Cloudflare's shared
// egress IPs differently, so a fallback chain keeps the feed alive.
const SOURCES = [
  'https://opendata.adsb.fi/api/v2/lat/-37.8136/lon/144.9631/dist/130',
  'https://api.airplanes.live/v2/point/-37.8136/144.9631/130',
  'https://api.adsb.lol/v2/lat/-37.8136/lon/144.9631/dist/130',
];
const UA = 'melbourne-flights/1.0 (+https://melbourne-flights.pages.dev)';
const CACHE_TTL = 10;

export async function onRequestOptions() {
  return cors(new Response(null, { status: 204 }));
}

export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + '/__flights', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cors(cached);

  let data = null;
  let lastStatus = 0;
  for (const src of SOURCES) {
    try {
      const up = await fetch(src, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      lastStatus = up.status;
      if (!up.ok) continue;
      const j = await up.json();
      if (j && Array.isArray(j.ac)) { data = j; break; }
    } catch (e) { /* try next source */ }
  }
  if (!data) return cors(json({ error: `all upstream sources failed (last HTTP ${lastStatus})` }, 502));

  const aircraft = [];
  for (const a of data.ac || []) {
    if (a.lat == null || a.lon == null) continue;
    const onGround = a.alt_baro === 'ground';
    if (onGround) continue; // map shows airborne traffic
    aircraft.push({
      hex:    a.hex,
      flight: (a.flight || '').trim() || null,
      reg:    a.r || null,
      type:   a.t || null,
      lat:    a.lat,
      lon:    a.lon,
      alt:    typeof a.alt_baro === 'number' ? a.alt_baro : (a.alt_geom ?? null),
      speed:  a.gs ?? null,                       // knots
      track:  a.track ?? a.true_heading ?? null,  // degrees
      vsi:    a.baro_rate ?? a.geom_rate ?? null, // ft/min
      squawk: a.squawk || null,
    });
  }

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
