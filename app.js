'use strict';

const CONFIG = {
  CENTER: [-28.3, 134.0],
  ZOOM: 4, MIN_ZOOM: 3, MAX_ZOOM: 11,
  API: '/api/flights',
  REFRESH_MS: 20000,
  TILE: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  ATTR: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> | ADS-B: <a href="https://adsb.lol">adsb.lol</a>',
};

// Clean top-down plane silhouette pointing north (up); rotated by track.
const PLANE_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">' +
  '<path d="M22 16v-2l-8.5-5V3.5C13.5 2.67 12.83 2 12 2s-1.5.67-1.5 1.5V9L2 14v2l8.5-2.5V19L8 20.5V22l4-1 4 1v-1.5L13.5 19v-3.5L22 16z"/>' +
  '</svg>';

function altColor(alt) {
  if (alt == null) return '#9aa7b5';
  if (alt < 10000) return '#00e5ff';
  if (alt < 20000) return '#7CFC8A';
  if (alt < 30000) return '#FFD23F';
  if (alt < 40000) return '#FF8C42';
  return '#FF5A8A';
}

class FlightMap {
  constructor() {
    this.map = null;
    this.group = null;
    this.planes = new Map();   // hex -> { fromLat,fromLng,toLat,toLng,curLat,curLng,track,alt,t0,lastSeen,data }
    this.markers = new Map();  // hex -> { marker, el }
    this.selected = null;
    this.timer = null;
    this._raf = null;
  }

  async init() {
    this.initMap();
    await this.fetchFlights();
    this.startAnimation();
    this.timer = setInterval(() => this.fetchFlights(), CONFIG.REFRESH_MS);
  }

  initMap() {
    this.map = L.map('map', {
      center: CONFIG.CENTER, zoom: CONFIG.ZOOM,
      minZoom: CONFIG.MIN_ZOOM, maxZoom: CONFIG.MAX_ZOOM, zoomControl: true,
    });
    L.tileLayer(CONFIG.TILE, { attribution: CONFIG.ATTR, subdomains: 'abcd', maxZoom: 20 }).addTo(this.map);
    this.group = L.layerGroup().addTo(this.map);
    this.map.on('click', () => this.closeInfo());
  }

  async fetchFlights() {
    this.setStatus('loading');
    try {
      const res = await fetch(`${CONFIG.API}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const now = Date.now();
      const seen = new Set();

      for (const a of data.aircraft || []) {
        if (a.lat == null || a.lon == null) continue;
        seen.add(a.hex);
        const ex = this.planes.get(a.hex);
        if (ex) {
          ex.fromLat = ex.curLat; ex.fromLng = ex.curLng;
          ex.toLat = a.lat; ex.toLng = a.lon;
          ex.track = a.track; ex.alt = a.alt; ex.t0 = now; ex.lastSeen = now; ex.data = a;
        } else {
          this.planes.set(a.hex, {
            fromLat: a.lat, fromLng: a.lon, toLat: a.lat, toLng: a.lon,
            curLat: a.lat, curLng: a.lon, track: a.track, alt: a.alt,
            t0: now, lastSeen: now, data: a,
          });
        }
      }
      // drop stale (gone for >3 refreshes)
      for (const [hex, p] of this.planes) {
        if (!seen.has(hex) && now - p.lastSeen > CONFIG.REFRESH_MS * 3) {
          this.planes.delete(hex); this.removeMarker(hex);
        }
      }

      this.setCount(this.planes.size);
      this.setUpdated(data.fetched_at);
      this.setStatus('ok');
      if (this.selected && this.planes.has(this.selected)) this.renderInfo(this.selected);
    } catch (e) {
      console.error('[flights] fetch failed:', e.message);
      this.setStatus('err');
    }
  }

  startAnimation() {
    const tick = () => {
      const now = Date.now();
      for (const [hex, p] of this.planes) {
        const t = Math.min(1, (now - p.t0) / CONFIG.REFRESH_MS);
        p.curLat = p.fromLat + (p.toLat - p.fromLat) * t;
        p.curLng = p.fromLng + (p.toLng - p.fromLng) * t;
        this.upsertMarker(hex, p);
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  upsertMarker(hex, p) {
    const latlng = [p.curLat, p.curLng];
    const rot = p.track != null ? p.track : 0;
    const color = altColor(p.alt);

    if (this.markers.has(hex)) {
      const { marker, el } = this.markers.get(hex);
      marker.setLatLng(latlng);
      if (el) { el.style.transform = `rotate(${rot}deg)`; el.style.color = color; }
    } else {
      const el = document.createElement('div');
      el.className = 'plane' + (this.selected === hex ? ' sel' : '');
      el.style.color = color;
      el.style.transform = `rotate(${rot}deg)`;
      el.innerHTML = PLANE_SVG;
      const icon = L.divIcon({ html: el, className: '', iconSize: [22, 22], iconAnchor: [11, 11] });
      const marker = L.marker(latlng, { icon, zIndexOffset: 400 });
      marker.on('click', (e) => { L.DomEvent.stopPropagation(e); this.showInfo(hex); });
      this.group.addLayer(marker);
      this.markers.set(hex, { marker, el });
    }
  }

  removeMarker(hex) {
    if (this.markers.has(hex)) { this.group.removeLayer(this.markers.get(hex).marker); this.markers.delete(hex); }
  }

  showInfo(hex) {
    if (this.selected && this.markers.has(this.selected)) this.markers.get(this.selected).el.classList.remove('sel');
    this.selected = hex;
    if (this.markers.has(hex)) this.markers.get(hex).el.classList.add('sel');
    this.renderInfo(hex);
    document.getElementById('info').classList.remove('hidden');
  }

  renderInfo(hex) {
    const p = this.planes.get(hex); if (!p) return;
    const a = p.data;
    const call = a.flight || a.reg || a.hex.toUpperCase();
    const alt = a.alt != null ? `${a.alt.toLocaleString()} ft` : '-';
    const spd = a.speed != null ? `${Math.round(a.speed)} kt (${Math.round(a.speed * 1.852)} km/h)` : '-';
    const trk = a.track != null ? `${Math.round(a.track)}°` : '-';
    const vsi = a.vsi != null && Math.abs(a.vsi) > 50
      ? `<span class="fi-v">${a.vsi > 0 ? '▲ climbing' : '▼ descending'} ${Math.abs(Math.round(a.vsi))} ft/min</span>` : '<span class="fi-v">level</span>';
    document.getElementById('info-body').innerHTML = `
      <div class="fi-call" style="color:${altColor(a.alt)}">${call}</div>
      <div class="fi-type">${[a.type, a.reg].filter(Boolean).join(' · ') || 'Unknown aircraft'}</div>
      <div class="fi-row"><span class="fi-k">Altitude</span><span class="fi-v">${alt}</span></div>
      <div class="fi-row"><span class="fi-k">Speed</span><span class="fi-v">${spd}</span></div>
      <div class="fi-row"><span class="fi-k">Heading</span><span class="fi-v">${trk}</span></div>
      <div class="fi-row"><span class="fi-k">Vertical</span>${vsi}</div>
      ${a.squawk ? `<div class="fi-row"><span class="fi-k">Squawk</span><span class="fi-v">${a.squawk}</span></div>` : ''}
    `;
  }

  closeInfo() {
    if (this.selected && this.markers.has(this.selected)) this.markers.get(this.selected).el.classList.remove('sel');
    this.selected = null;
    document.getElementById('info').classList.add('hidden');
  }

  setStatus(s) {
    const el = document.getElementById('status'); if (!el) return;
    el.className = 'dot ' + ({ ok: 'ok', err: 'err', loading: 'loading' }[s] || '');
    el.title = { ok: 'live', err: 'data error', loading: 'updating' }[s] || '';
  }
  setCount(n) { const el = document.getElementById('count'); if (el) el.textContent = `· ${n} in the air`; }
  setUpdated(iso) {
    const el = document.getElementById('updated'); if (!el || !iso) return;
    el.textContent = new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}
