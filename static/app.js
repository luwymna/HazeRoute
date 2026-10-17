const map = L.map('map').setView([3.1390, 101.6869], 7);

L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 19,
    attribution: 'Tiles powered by Esri',
  }
).addTo(map);

let layers = [];
let markers = [];
let currentData = null;
let activeIdx = -1;
let expandedRoutes = new Set();
let heatLayer = null;
let showStations = true;
let showRoutes = true;

// ============================================================
// AQICN station markers
// ============================================================

function aqiColor(aqi) {
  if (aqi <= 50) return "#3ea55b";   // Good
  if (aqi <= 100) return "#e6b800";   // Moderate
  if (aqi <= 150) return "#e57a1f";   // Unhealthy for sensitive
  if (aqi <= 200) return "#d13d2e";   // Unhealthy
  if (aqi <= 300) return "#8f3f97";   // Very Unhealthy
  return "#7e0023";                    // Hazardous
}

async function loadStations() {
  try {
    const res = await fetch("/api/malaysia-stations");
    const stations = await res.json();
    if (!Array.isArray(stations)) return;

    stations.forEach((s) => {
      const aqi = parseInt(s.aqi, 10);
      if (isNaN(aqi)) return;

      const color = aqiColor(aqi);
      const size = aqi >= 100 ? "aqi-circle" : "aqi-circle aqi-small";

      L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: "aqi-marker",
          html: `<div class="${size}" style="background:${color}">${aqi}</div>`,
          iconSize: [38, 38],
          iconAnchor: [19, 19],
        }),
      })
        .addTo(map)
        .bindPopup(
          `<div style="font-family:inherit;font-size:13px;line-height:1.5">
             <b>${s.station.name}</b><br>
             AQI: <b>${aqi}</b><br>
             <a href="${s.station.url}" target="_blank" style="color:#9c4a1e">View on AQICN →</a>
           </div>`
        );
    });

    // Build heatmap from stations
    const heatPoints = [];
    for (const s of stations) {
      const aqi = parseInt(s.aqi, 10);
      if (isNaN(aqi) || !s.lat || !s.lon) continue;
      // Normalise 0–300 AQI to 0–1 for heat intensity
      const intensity = Math.min(1, aqi / 300);
      heatPoints.push([s.lat, s.lon, intensity]);
    }

    if (heatLayer) map.removeLayer(heatLayer);
    heatLayer = L.heatLayer(heatPoints, {
      radius: 45,
      blur: 30,
      maxZoom: 12,
      minOpacity: 0.25,
      gradient: {
        0.1: '#3ea55b',   // Good
        0.3: '#e6b800',   // Moderate
        0.5: '#e57a1f',   // Unhealthy for sensitive
        0.7: '#d13d2e',   // Unhealthy
        0.9: '#8f3f97',   // Very Unhealthy
        1.0: '#7e0023',   // Hazardous
      },
    }).addTo(map);

  } catch (e) {
    console.warn("Could not load AQICN stations:", e);
  }
}

// Fire after the map is created
loadStations();

function applyVisibility() {
  document.querySelectorAll(".aqi-marker").forEach(el => {
    el.style.display = showStations ? "" : "none";
  });
  layers.forEach(l => {
    if (showRoutes) l.addTo(map);
    else map.removeLayer(l);
  });
}

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const compareBtn = $('compareBtn');
const btnText = compareBtn.querySelector('.btn-text');
const spinner = compareBtn.querySelector('.spinner');
const errorBox = $('error');
const verdictBox = $('verdict');
const cardsBox = $('routeCards');
const legend = $('legend');
const emptyState = $('emptyState');
const miniStats = $('miniStats');

// ---------- Colour palette for routes ----------
const ALT_COLORS = ['#b37b28', '#a8472c', '#7a4f8f', '#3a7a8a', '#8a7a3a'];
const WINNER_COLOR = '#5c6f3a';
const DIM_WINNER = '#a8c88c';
const DIM_LOSER = '#d9a89c';
const NEUTRAL = '#7a4a2a';
const NEUTRAL_DIM = '#c0b5a0';

// ============================================================
// Helpers
// ============================================================
function setLoading(on) {
  compareBtn.disabled = on;
  spinner.hidden = !on;
  btnText.textContent = on ? 'Comparing…' : 'Compare routes';
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

function fmtDuration(s) {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtDistance(m) {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

function routeColor(idx) {
  if (!currentData) return NEUTRAL;
  const winner = currentData.verdict.winner;
  if (!winner) return NEUTRAL;

  const winnerIdx = currentData.routes.findIndex(r => r.name === winner);
  if (idx === winnerIdx) return WINNER_COLOR;

  const losers = currentData.routes
    .map((r, i) => ({ i, e: r.exposure ?? Infinity }))
    .filter(x => x.i !== winnerIdx)
    .sort((a, b) => a.e - b.e);

  const rank = losers.findIndex(x => x.i === idx);
  return ALT_COLORS[Math.min(rank, ALT_COLORS.length - 1)];
}

function routeColorDim(idx) {
  if (!currentData) return NEUTRAL_DIM;
  const winner = currentData.verdict.winner;
  if (!winner) return NEUTRAL_DIM;
  const winnerIdx = currentData.routes.findIndex(r => r.name === winner);
  return idx === winnerIdx ? DIM_WINNER : DIM_LOSER;
}

// ============================================================
// Map rendering
// ============================================================
function clearMap() {
  layers.forEach(l => map.removeLayer(l));
  markers.forEach(m => map.removeLayer(m));
  layers = [];
  markers = [];
}

function drawRoute(route, idx, color, isDimmed) {
  const geom = { type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords } };
  const weight = isDimmed ? 4 : 6;
  const opacity = isDimmed ? 0.3 : 0.95;

  const isWinner = currentData &&
    currentData.verdict &&
    currentData.verdict.winner === route.name;

  const sublayers = [];

  // Winner glow (only when not dimmed) — tracked so clearMap() removes it
  if (isWinner && !isDimmed) {
    sublayers.push(L.geoJSON(geom, {
      style: {
        color,
        weight: weight + 10,
        opacity: 0.18,
        lineCap: 'round',
        lineJoin: 'round',
      },
    }));
  }

  // Under-casing
  sublayers.push(L.geoJSON(geom, {
    style: {
      color: '#2b2419',
      weight: weight + 3,
      opacity: isDimmed ? 0.15 : 0.35,
      lineCap: 'round',
      lineJoin: 'round',
    },
  }));

  // Main line
  const line = L.geoJSON(geom, {
    style: {
      color,
      weight,
      opacity,
      lineCap: 'round',
      lineJoin: 'round',
    },
  });
  sublayers.push(line);

  const pm = route.pollution ? route.pollution.pm2_5.toFixed(1) + ' µg/m³' : 'n/a';
  line.bindTooltip(
    `Route ${route.name} · ${fmtDuration(route.duration_s)} · PM2.5 ${pm}`,
    { sticky: true }
  );

  // Use featureGroup (not layerGroup) so getBounds() works for fitBounds
  layers[idx] = L.featureGroup(sublayers).addTo(map);
}

function redrawMap() {
  clearMap();
  if (!currentData) return;

  const { routes, start, end } = currentData;

  const visible = activeIdx === -1
    ? routes.map((_, i) => i)
    : [activeIdx];

  visible.forEach(i => drawRoute(routes[i], i, routeColor(i), false));

  if (activeIdx !== -1) {
    routes.forEach((_, i) => {
      if (i !== activeIdx) drawRoute(routes[i], i, routeColorDim(i), true);
    });
  }

  if (start) {
    const startIcon = L.divIcon({
      className: 'endpoint-marker endpoint-start',
      html: '<div class="endpoint-dot"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    markers.push(
      L.marker([start.lat, start.lon], { icon: startIcon })
        .addTo(map)
        .bindPopup(`<b>Start</b><br>${start.name}`)
    );
  }
  if (end) {
    const endIcon = L.divIcon({
      className: 'endpoint-marker endpoint-end',
      html: '<div class="endpoint-dot"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    markers.push(
      L.marker([end.lat, end.lon], { icon: endIcon })
        .addTo(map)
        .bindPopup(`<b>Destination</b><br>${end.name}`)
    );
  }

  const visibleLayers = layers.filter(Boolean);
  if (visibleLayers.length) {
    const isMobile = window.innerWidth <= 640;
    const panel = document.getElementById('mainPanel');
    const bounds = L.featureGroup(visibleLayers).getBounds();

    map.fitBounds(bounds, {
      paddingTopLeft: [30, isMobile ? 90 : 50],
      paddingBottomRight: [30, isMobile ? panel.offsetHeight + 20 : 50],
      animate: true,
    });
  }
}

// ============================================================
// Route cards
// ============================================================
function selectRoute(idx) {
  if (navigator.vibrate) 
    navigator.vibrate(10);
  activeIdx = (activeIdx === idx) ? -1 : idx;
  redrawMap();
  renderCards();
}

function renderCards() {
  if (!currentData) return;
  if (emptyState) emptyState.hidden = true;
  const { routes, verdict } = currentData;

  cardsBox.innerHTML = '';

  if (activeIdx !== -1) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'show-both-btn';
    resetBtn.textContent = '↺ Show all routes';
    resetBtn.addEventListener('click', () => {
      activeIdx = -1;
      redrawMap();
      renderCards();
    });
    cardsBox.appendChild(resetBtn);
  }

  const countHeader = document.createElement('div');
  countHeader.className = 'route-count';
  countHeader.textContent = `${routes.length} route${routes.length > 1 ? 's' : ''} compared`;
  cardsBox.appendChild(countHeader);
  // ---- "Better route" summary banner ----
  const winnerRoute = verdict.winner
    ? routes.find(r => r.name === verdict.winner)
    : null;
  const loserRoute = verdict.winner
    ? routes.find(r => r.name === verdict.worst)
    : null;

  const betterBox = document.createElement('div');
  betterBox.className = 'better-banner';

  if (winnerRoute && loserRoute) {
    // There is a clear winner
    const pct = verdict.diff_pct || Math.round(
      ((loserRoute._compare_value - winnerRoute._compare_value) / loserRoute._compare_value) * 100
    );
    const co2Winner = verdict.co2_winner && verdict.co2_winner !== verdict.winner
      ? routes.find(r => r.name === verdict.co2_winner)
      : null;

    if (co2Winner) {
      // Health winner differs from carbon winner
      betterBox.classList.add('better-split');
      betterBox.innerHTML = `
        <span class="better-main">
          <b>Route ${verdict.winner}</b> is best for your lungs
        </span>
        <span class="better-sub">
          ${pct}% lower exposure than Route ${verdict.worst}
        </span>
        <span class="better-alt">
          For lowest carbon, take Route ${co2Winner.name}
        </span>
      `;
    } else {
      // Single winner on both measures
      betterBox.classList.add('better-clear');
      betterBox.innerHTML = `
        <span class="better-main">
          <b>Route ${verdict.winner}</b> is better
        </span>
        <span class="better-sub">
          ${pct}% lower exposure than Route ${verdict.worst}
        </span>
      `;
    }
  } else {
    // Tie — no winner
    betterBox.classList.add('better-tie');
    betterBox.innerHTML = `
      <span class="better-main">
        <b>Comparable routes</b>
      </span>
      <span class="better-sub">
        No meaningful difference in exposure between these routes
      </span>
    `;
  }

  cardsBox.appendChild(betterBox);

  // ---- Mini-stats row ----
  if (miniStats) {
    const best = routes.reduce((a, b) =>
      (a._compare_value ?? Infinity) < (b._compare_value ?? Infinity) ? a : b
    );
    const co2Best = routes.reduce((a, b) =>
      (a.co2_kg ?? Infinity) < (b.co2_kg ?? Infinity) ? a : b
    );

    const fastest = routes.reduce((a, b) =>
      a.duration_s < b.duration_s ? a : b
    );
    const slowest = routes.reduce((a, b) =>
      a.duration_s > b.duration_s ? a : b
    );
    const timeDelta = Math.round((slowest.duration_s - fastest.duration_s) / 60);

    const exposureClass = best.exposure >= 400 ? 'stat-bad'
      : best.exposure >= 200 ? 'stat-warn'
        : 'stat-good';

    miniStats.innerHTML = `
      <div class="mini-stat">
        <span class="mini-stat-label">Best for lungs</span>
        <span class="mini-stat-value ${exposureClass}">Route ${best.name} · ${best.exposure != null ? best.exposure.toFixed(0) : '—'}</span>
      </div>
      <div class="mini-stat">
        <span class="mini-stat-label">Best for planet</span>
        <span class="mini-stat-value">Route ${co2Best.name} · ${co2Best.co2_kg != null ? co2Best.co2_kg.toFixed(2) + ' kg' : '—'}</span>
      </div>
      <div class="mini-stat">
        <span class="mini-stat-label">Time spread</span>
        <span class="mini-stat-value">${timeDelta === 0 ? 'No difference' : '+' + timeDelta + ' min'}</span>
      </div>
    `;
    miniStats.hidden = false;
  }

  
  const track = document.createElement('div');
  track.className = 'route-track';
  cardsBox.appendChild(track);

  routes.forEach((r, i) => {
    const isWinner = verdict.winner === r.name;
    const isActive = activeIdx === i;
    const isDimmed = activeIdx !== -1 && activeIdx !== i;
    const colour = routeColor(i);
    const isExpanded = expandedRoutes.has(r.name);

    const pollution = r.pollution;
    const pollChips = pollution
      ? `
        <div class="poll">PM2.5 <b>${pollution.pm2_5.toFixed(1)}</b></div>
        <div class="poll">PM10 <b>${pollution.pm10.toFixed(1)}</b></div>
        <div class="poll">NO₂ <b>${pollution.no2.toFixed(1)}</b></div>
        <div class="poll">O₃ <b>${pollution.o3.toFixed(1)}</b></div>
      `
      : `
        <div class="poll">PM2.5 <b>—</b></div>
        <div class="poll">PM10 <b>—</b></div>
        <div class="poll">NO₂ <b>—</b></div>
        <div class="poll">O₃ <b>—</b></div>
      `;

    const co2 = r.co2_kg != null ? r.co2_kg.toFixed(2) + ' kg' : '—';

    const card = document.createElement('div');
    card.className = 'route-card'
      + (isWinner ? ' winner' : '')
      + (isActive ? ' active' : '')
      + (isDimmed ? ' dimmed' : '');
    card.style.setProperty('--card-color', colour);

    card.innerHTML = `
      <!-- Compact header (always visible, click to isolate on map) -->
      <div class="card-summary" data-action="isolate">
        <span class="card-chevron">${isExpanded ? '▾' : '▸'}</span>
        <div class="summary-title">
          Route ${r.name}
          ${isWinner ? '<span class="tag">Best</span>' : ''}
          ${isActive ? '<span class="tag tag-active">Viewing</span>' : ''}
        </div>
        <span class="summary-meta">${fmtDuration(r.duration_s)} · ${fmtDistance(r.distance_m)} · ${co2}</span>
        <span class="exposure-badge">${r.exposure != null ? r.exposure.toFixed(0) : '—'}</span>
      </div>

      <!-- Expandable detail (hidden by default) -->
      <div class="card-detail" ${isExpanded ? '' : 'hidden'}>
        <div class="card-stats">
          <div><b>${fmtDuration(r.duration_s)}</b> duration</div>
          <div><b>${fmtDistance(r.distance_m)}</b> distance</div>
        </div>

        <div class="pollution-list">${pollChips}</div>

        <div class="card-exposure">
          <div class="exp-row">
            <span class="exp-label">Now</span>
            <span class="exp-pm">PM2.5 ${pollution ? pollution.pm2_5.toFixed(1) : '—'}</span>
            <span class="exp-val">${r.exposure != null ? r.exposure.toFixed(0) : '—'}</span>
          </div>
          ${r.forecast_exposure != null ? `
            <div class="exp-row exp-row-fc">
              <span class="exp-label">Arrival</span>
              <span class="exp-pm">PM2.5 ${r.forecast_pm25.toFixed(1)}${r.forecast_margin != null && r.forecast_margin > 0
          ? ` <span class="pm-margin">±${r.forecast_margin.toFixed(1)}</span>`
          : ''
        }</span>
              <span class="exp-val">${r.forecast_exposure.toFixed(0)}${r.forecast_exposure_margin != null && r.forecast_exposure_margin > 0
          ? ` <span class="val-margin">±${r.forecast_exposure_margin.toFixed(0)}</span>`
          : ''
        }</span>
            </div>
          ` : ''}
        </div>

        <div class="card-carbon">
          <span>CO₂</span>
          <b>${co2}</b>
          <span class="carbon-note">fuel only</span>
        </div>

        ${r.reasoning && r.reasoning.why && r.reasoning.why.length ? `
          <details class="card-reasoning">
            <summary>Why this route?</summary>
            <ul>
              ${r.reasoning.why.map(w => `<li>${w}</li>`).join('')}
            </ul>
            <p class="reasoning-confidence">
              <b>Confidence:</b> ${r.reasoning.confidence || '—'}
            </p>
          </details>
        ` : ''}

        <div class="card-hint">${isActive ? 'Click again to show all routes' : 'Click header to isolate on the map'}</div>
      </div>
    `;

    // ---- Click handling ----

    // Chevron: toggle expand / collapse only
    card.querySelector('.card-chevron').addEventListener('click', (e) => {
      e.stopPropagation();
      if (expandedRoutes.has(r.name)) {
        expandedRoutes.delete(r.name);
      } else {
        expandedRoutes.add(r.name);
      }
      renderCards();
    });

    card.addEventListener('click', (e) => {
      // Let the reasoning <details> handle its own clicks
      if (e.target.closest('.card-reasoning')) return;

      // Chevron clicks are handled above — don't double-fire
      if (e.target.closest('.card-chevron')) return;

      // Clicking anywhere on the summary header → isolate on map
      if (e.target.closest('[data-action="isolate"]')) {
        selectRoute(i);
        return;
      }
    });

    track.appendChild(card);
  });

  legend.hidden = !verdict.winner;
}

function renderVerdict() {
  if (!currentData) return;
  const { verdict } = currentData;
  verdictBox.hidden = false;

  const urgency = verdict.urgency || "low";
  const urgencyIcon = {
    low: "",
    medium: "⚠️ ",
    high: "⚠️ ",
    critical: "🚨 ",
  }[urgency] || "";

  verdictBox.className = `verdict ${verdict.winner ? 'winner' : 'tie'} urgency-${urgency}`;
  verdictBox.innerHTML = `
    <div class="verdict-main">${urgencyIcon}${verdict.message}</div>
    ${verdict.confidence_pct != null ? `
      <div class="verdict-meta">
        <span class="confidence-tag">Confidence: <b>${verdict.confidence_pct}%</b></span>
        <span class="noise-tag">Uncertainty: <b>±${verdict.margin_pm25 != null ? verdict.margin_pm25 : '2.5'} µg/m³</b></span>
      </div>
    ` : ''}
  `;
}

// ============================================================
// Compare API
// ============================================================
async function compare() {
  clearError();
  verdictBox.hidden = true;
  cardsBox.innerHTML = '';
  legend.hidden = true;
  activeIdx = -1;
  currentData = null;

  if (miniStats) { miniStats.hidden = true; miniStats.innerHTML = ''; }
  if (emptyState) emptyState.hidden = false;

  const start = $('start').value.trim();
  const end = $('end').value.trim();
  const modeBtn = document.querySelector('.mode-btn.active');
  const mode = modeBtn ? modeBtn.dataset.mode : 'drive';
  const profileBtn = document.querySelector('.profile-btn.active');
  const profile = profileBtn ? profileBtn.dataset.profile : 'adult';

  if (!start || !end) {
    showError('Please enter both a start and a destination.');
    return;
  }

  setLoading(true);
  try {
    const res = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start, end, mode, profile }),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      showError(`Server error (${res.status}). Please check Flask logs.`);
      return;
    }

    if (!res.ok) {
      showError(data.error || 'Something went wrong.');
      return;
    }

    currentData = data;
    document.querySelector('.samples-row').hidden = true;
    renderCards();
    renderVerdict();
    redrawMap();
  } catch (e) {
    showError('Network error: ' + e.message);
  } finally {
    setLoading(false);
  }
}

// ============================================================
// Event wiring
// ============================================================
compareBtn.addEventListener('click', compare);

$('start').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('end').focus(); });
$('end').addEventListener('keydown', (e) => { if (e.key === 'Enter') compare(); });

// Mode buttons
document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    if (currentData) compare();
  });
});

// Swap button
const swapBtn = $('swapBtn');
if (swapBtn) {
  swapBtn.addEventListener('click', () => {
    const s = $('start').value;
    $('start').value = $('end').value;
    $('end').value = s;
    if (currentData) compare();
  });
}

// Sample chips
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    $('start').value = chip.dataset.start;
    $('end').value = chip.dataset.end;
    compare();
  });
});

// Use my location
$('locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) {
    showError('Geolocation not supported by this browser.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { longitude, latitude } = pos.coords;
      $('start').value = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
    },
    () => showError('Could not get your location (permission denied?).')
  );
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (!currentData) return;
  if (e.key === 'Escape') {
    activeIdx = -1;
    redrawMap();
    renderCards();
    return;
  }
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= currentData.routes.length) selectRoute(n - 1);
});

document.querySelectorAll('.profile-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.profile-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    // Re-run comparison if results are already showing
    if (currentData) compare();
  });
});

// ============================================================
// University AQI panel
// ============================================================

const UNIVERSITIES = [
  { short: "UPM", name: "Universiti Putra Malaysia", lat: 3.0022, lon: 101.7064, logo: "upm.png" },
  { short: "UKM", name: "Universiti Kebangsaan Malaysia", lat: 2.9258, lon: 101.7790, logo: "ukm.png" },
  { short: "UM", name: "Universiti Malaya", lat: 3.1210, lon: 101.6550, logo: "UM.png" },
  { short: "UiTM Shah Alam", name: "UiTM Shah Alam", lat: 3.0701, lon: 101.5026, logo: "uitm.png" },
  { short: "UiTM Puncak Alam", name: "UiTM Puncak Alam", lat: 3.2169, lon: 101.4432, logo: "uitm.png" },
  { short: "UPNM", name: "Universiti Pertahanan Nasional", lat: 3.0160, lon: 101.7186, logo: "upnm.png" },
  { short: "MSU", name: "Management & Science University", lat: 3.0711, lon: 101.5159, logo: "msu.png" },
  { short: "GMI", name: "German-Malaysian Institute", lat: 2.9957, lon: 101.7503, logo: "gmi.png" },
  { short: "UTM KL", name: "UTM Kuala Lumpur", lat: 3.1701, lon: 101.7203, logo: "utm.png" },
  { short: "UTM Johor", name: "UTM Skudai", lat: 1.5582, lon: 103.6405, logo: "utm.png" },
  { short: "USM", name: "Universiti Sains Malaysia", lat: 5.3571, lon: 100.3020, logo: "usm.png" },
  { short: "IIUM", name: "International Islamic University Malaysia", lat: 3.2508, lon: 101.7372, logo: "iium.png" },
  { short: "UUM", name: "Universiti Utara Malaysia", lat: 6.4667, lon: 100.5061, logo: "uum.png" },
  { short: "UNIMAS", name: "Universiti Malaysia Sarawak", lat: 1.4649, lon: 110.4277, logo: "unimas.png" },
];

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function aqiCategory(aqi) {
  if (aqi <= 50) return { label: "Good", cls: "uni-good" };
  if (aqi <= 100) return { label: "Moderate", cls: "uni-moderate" };
  if (aqi <= 150) return { label: "Unhealthy", cls: "uni-unhealthy" };
  if (aqi <= 200) return { label: "Bad", cls: "uni-bad" };
  if (aqi <= 300) return { label: "V.Bad", cls: "uni-very-bad" };
  return { label: "Hazard", cls: "uni-hazard" };
}

async function loadUniversityAQI() {
  const list = document.getElementById("uniList");
  if (!list) return;

  list.innerHTML = '<li class="uni-loading">Loading campuses…</li>';

  try {
    const res = await fetch("/api/malaysia-stations");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const stations = await res.json();

    if (!Array.isArray(stations) || stations.length === 0) {
      list.innerHTML = '<li class="uni-loading">Station data unavailable</li>';
      return;
    }

    // For each university, find the nearest station
    const rows = UNIVERSITIES.map(u => {
      let nearest = null;
      let nearestDist = Infinity;
      for (const s of stations) {
        const aqi = parseInt(s.aqi, 10);
        if (isNaN(aqi)) continue;
        const d = haversine(u.lat, u.lon, s.lat, s.lon);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = { ...s, aqi, dist: d };
        }
      }
      return { uni: u, station: nearest };
    });

    // Filter out any campuses with no station
    const validRows = rows.filter(r => r.station);

    if (validRows.length === 0) {
      list.innerHTML = '<li class="uni-loading">No stations near campuses</li>';
      return;
    }

    // Sort by AQI descending (worst first)
    validRows.sort((a, b) => b.station.aqi - a.station.aqi);

    const strip = document.getElementById('uniStrip');
    if (strip) {
      strip.innerHTML = validRows.map(r => {
        const color = aqiColor(r.station.aqi);
        const initials = r.uni.short.replace(/[^A-Z]/g, '').slice(0, 3);
        const img = r.uni.logo
          ? `<img src="/static/logos/${r.uni.logo}" alt="" onerror="this.style.display='none'">`
          : '';
        return `
          <button class="uni-chip" data-lat="${r.uni.lat}" data-lon="${r.uni.lon}">
            <span class="uni-chip-logo" style="--ring:${color}">
              <span class="uni-chip-initials">${initials}</span>
              ${img}
            </span>
            <span class="uni-chip-name">${r.uni.short}</span>
            <b style="color:${color}">${r.station.aqi}</b>
          </button>`;
      }).join('');

      strip.querySelectorAll('.uni-chip').forEach(el => {
        el.addEventListener('click', () => {
          map.flyTo([+el.dataset.lat, +el.dataset.lon], 14, { duration: 1.2 });
        });
      });
    }

    list.innerHTML = validRows.map(r => {
      const cat = aqiCategory(r.station.aqi);
      const logoSrc = r.uni.logo
        ? `/static/logos/${r.uni.logo}`
        : null;
      const logoHtml = logoSrc
        ? `<img class="uni-logo" src="${logoSrc}" alt="" onerror="this.style.display='none'">`
        : `<span class="uni-icon">${r.uni.short.replace(/[^A-Z]/g, '').slice(0, 3)}</span>`;
      return `
        <li class="uni-item" data-lat="${r.uni.lat}" data-lon="${r.uni.lon}" title="${r.uni.name}">
          ${logoHtml}
          <span class="uni-name">${r.uni.short}</span>
          <span class="uni-aqi">${r.station.aqi}</span>
          <span class="uni-badge ${cat.cls}">${cat.label}</span>
        </li>
      `;
    }).join("");

    // Click handler — pan map to the campus
    list.querySelectorAll(".uni-item").forEach(el => {
      el.addEventListener("click", () => {
        const lat = parseFloat(el.dataset.lat);
        const lon = parseFloat(el.dataset.lon);
        if (!isNaN(lat) && !isNaN(lon)) {
          map.flyTo([lat, lon], 14, { duration: 1.2 });
        }
      });
    });

  } catch (e) {
    console.warn("Could not load university AQI:", e);
    list.innerHTML = '<li class="uni-loading">Could not load campus data</li>';
  }
}

// Wire refresh button
const uniRefreshBtn = document.getElementById("uniRefreshBtn");
if (uniRefreshBtn) uniRefreshBtn.addEventListener("click", loadUniversityAQI);

// Load on startup
loadUniversityAQI();

// ---------- Mini-map overview ----------
(function initMinimap() {
  const el = document.getElementById('minimap');
  if (!el) return;

  const mini = L.map('minimap', {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
  }).setView([4.2, 108.9], 3);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }).addTo(mini);

  // Force Leaflet to recalculate container size — fixes blank tiles
  // when the container uses overflow:hidden or is initially off-screen
  setTimeout(() => mini.invalidateSize(), 100);

  // Dashed rectangle showing the main map's current viewport
  const viewportRect = L.rectangle(map.getBounds(), {
    color: '#9c4a1e',
    weight: 1.5,
    fill: false,
    dashArray: '3 3',
    interactive: false,
  }).addTo(mini);

  // Keep the rectangle in sync and minimap centred on main map
  map.on('move zoom moveend', () => {
    viewportRect.setBounds(map.getBounds());
    // Minimap stays 4 zoom levels behind the main map, centred on same point
    const targetZoom = Math.max(1, map.getZoom() - 4);
    mini.setView(map.getCenter(), targetZoom, { animate: false });
  });

  // Click on the minimap → jump the main map there
  mini.on('click', (e) => {
    map.setView(e.latlng, map.getZoom());
  });

  // Sync minimap view when theme changes (optional: swap tile style)
  document.addEventListener('theme-changed', (ev) => {
    // Hook for future dark-mode minimap tile swap
  });

  window.addEventListener('resize', () => {
    mini.invalidateSize();
  });
})();

// ============================================================
// Mobile panel collapse toggle
// ============================================================
(function initPanelToggle() {
  const toggle = document.getElementById('panelToggle');
  const panel = document.getElementById('mainPanel');
  if (!toggle || !panel) return;

  toggle.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('panel-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });
})();