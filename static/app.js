const map = L.map('map').setView([3.1390, 101.6869], 7);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

// ============================================================
// AQICN station markers
// ============================================================

function aqiColor(aqi) {
  if (aqi <= 50) return "#00e400";   // Good — green
  if (aqi <= 100) return "#ffff00";   // Moderate — yellow
  if (aqi <= 150) return "#ff7e00";   // Unhealthy for sensitive — orange
  if (aqi <= 200) return "#ff0000";   // Unhealthy — red
  if (aqi <= 300) return "#8f3f97";   // Very Unhealthy — purple
  return "#7e0023";                    // Hazardous — maroon
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

      L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: "aqi-marker",
          html: `<div class="aqi-circle" style="background:${color}">${aqi}</div>`,
          iconSize: [40, 40],
          iconAnchor: [20, 20],
        }),
      })
        .addTo(map)
        .bindPopup(
          `<b>${s.station.name}</b><br>AQI: ${aqi}<br><a href="${s.station.url}" target="_blank">View on AQICN →</a>`
        );
    });
  } catch (e) {
    console.warn("Could not load AQICN stations:", e);
  }
}

// Fire after the map is created
loadStations();

let showStations = true;
let showRoutes = true;

function applyVisibility() {
  document.querySelectorAll(".aqi-marker").forEach(el => {
    el.style.display = showStations ? "" : "none";
  });
  layers.forEach(l => {
    if (showRoutes) l.addTo(map);
    else map.removeLayer(l);
  });
}

// ---------- State ----------
let layers = [];
let markers = [];
let currentData = null;
let activeIdx = -1;

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const compareBtn = $('compareBtn');
const btnText = compareBtn.querySelector('.btn-text');
const spinner = compareBtn.querySelector('.spinner');
const errorBox = $('error');
const verdictBox = $('verdict');
const cardsBox = $('routeCards');
const legend = $('legend');

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
  const line = L.geoJSON(
    { type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords } },
    { style: { color, weight: isDimmed ? 4 : 6, opacity: isDimmed ? 0.3 : 0.85 } }
  ).addTo(map);

  const pm = route.pollution ? route.pollution.pm2_5.toFixed(1) + ' µg/m³' : 'n/a';
  line.bindTooltip(`Route ${route.name} · ${fmtDuration(route.duration_s)} · PM2.5 ${pm}`, { sticky: true });
  layers[idx] = line;
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
    markers.push(L.marker([start.lat, start.lon]).addTo(map).bindPopup('Start: ' + start.name));
  }
  if (end) {
    markers.push(L.marker([end.lat, end.lon]).addTo(map).bindPopup('End: ' + end.name));
  }

  const visibleLayers = layers.filter(Boolean);
  if (visibleLayers.length) {
    map.fitBounds(L.featureGroup(visibleLayers).getBounds().pad(0.15));
  }
}

// ============================================================
// Route cards
// ============================================================
function selectRoute(idx) {
  activeIdx = (activeIdx === idx) ? -1 : idx;
  redrawMap();
  renderCards();
}

function renderCards() {
  if (!currentData) return;
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

  routes.forEach((r, i) => {
    const isWinner = verdict.winner === r.name;
    const isActive = activeIdx === i;
    const isDimmed = activeIdx !== -1 && activeIdx !== i;
    const colour = routeColor(i);

    const card = document.createElement('div');
    card.className = 'card route-card' +
      (isWinner ? ' winner' : '') +
      (isActive ? ' active' : '') +
      (isDimmed ? ' dimmed' : '');
    card.style.setProperty('--card-color', colour);

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

    card.innerHTML = `
      <div class="card-header">
        <div class="card-title">
          Route ${r.name}
          ${isWinner ? '<span class="tag">Lowest exposure</span>' : ''}
          ${isActive ? '<span class="tag tag-active">Viewing</span>' : ''}
        </div>
        <div class="exposure-badge" style="color:${colour}">
          ${r.exposure != null ? r.exposure.toFixed(0) : '—'}
        </div>
      </div>
      <div class="card-stats">
        <div><b>${fmtDuration(r.duration_s)}</b> duration</div>
        <div><b>${fmtDistance(r.distance_m)}</b> distance</div>
      </div>
      <div class="card-exposure">
        <div class="exp-row">
          <span class="exp-label">Now</span>
          <span class="exp-pm">PM2.5 ${pollution ? pollution.pm2_5.toFixed(1) : "-"}</span>
          <span class="exp-val">${r.exposure != null ? r.exposure.toFixed(0) : "-"}</span>
        </div>
        ${r.forecast_exposure != null ? `
          <div class="exp-row exp-row-fc">
            <span class="exp-label">Arrival</span>
            <span class="exp-pm">PM2.5 ${r.forecast_pm25.toFixed(1)}${r.forecast_margin != null ? `<span class="pm-margin">±${r.forecast_margin.toFixed(1)}</span>` : ''}</span>
            <span class="exp-val">${r.forecast_exposure.toFixed(0)}${r.forecast_exposure_margin != null ? `<span class="val-margin">±${r.forecast_exposure_margin.toFixed(0)}</span>` : ''}</span>
          </div>
        `: ''}
      </div>
      <div class="pollution-list">${pollChips}</div>
      <div class="card-carbon">
        <span class="carbon-label">CO₂</span>
        <span class="carbon-value">${r.co2_kg != null ? r.co2_kg.toFixed(2) : '—'} kg</span>
        <span class="carbon-note">fuel only</span>
      </div>
      <div class="card-hint">${isActive ? 'Click again to show all routes' : 'Click to isolate on the map'}</div>
    `;

    card.addEventListener('click', () => selectRoute(i));
    cardsBox.appendChild(card);
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
    redrawMap();
    renderVerdict();
    renderCards();
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

// Profile buttons
document.querySelectorAll('.profile-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.profile-btn').forEach((b) => b.classList.remove('active'));
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