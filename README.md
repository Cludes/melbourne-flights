# Australia Flights

Live map of aircraft across Australia, on a dark Leaflet map. Planes are coloured by
altitude, rotated to their heading, smoothed at 60fps between updates, and clickable
for callsign / type / altitude / speed / climb-descent.

No API key required - data comes from the keyless community ADS-B aggregators
([adsb.fi](https://adsb.fi), [airplanes.live](https://airplanes.live),
[adsb.lol](https://adsb.lol)), proxied through a Cloudflare Pages Function (`/api/flights`).

## Australia-wide coverage
The keyless ADS-B APIs cap each query at ~250nm, so the Function fetches a **grid of points**
across the populated arc + interior (Perth, Adelaide, Melbourne/Tasmania, Sydney, Brisbane,
north QLD, Darwin, Alice Springs), merges them and de-dupes by ICAO hex. Each point tries the
aggregators in order (they rate-limit Cloudflare's shared egress IPs differently), and the result
is edge-cached for 20s so all visitors share one upstream sweep. Typically ~300 aircraft.

## Architecture
- **Frontend** (`index.html`, `styles.css`, `app.js`) - Leaflet dark map; polls `/api/flights`
  every 20s and interpolates each aircraft to its new position each animation frame.
- **`functions/api/flights.js`** - Cloudflare Pages Function: the grid fetch + merge + CORS + cache.
- **Deploy** - GitHub Action ships the site + Function to Cloudflare Pages on every push to `master`
  (secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).

Live: https://australia-flights.pages.dev
