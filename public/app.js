const $ = id => document.getElementById(id);
const center = [59.2700, 11.5890];
const map = L.map('map', { zoomControl: true }).setView(center, 12);
const standard = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' });
const depth = L.tileLayer.wms('https://kart.nve.no/enterprise/services/Innsjodatabase2/MapServer/WMSServer', { layers: 'DybdeKurve,DybdePunkt', format: 'image/png', transparent: true, version: '1.3.0', opacity: .9, attribution: 'NVE dybdekart' });
const markerLayer = L.layerGroup().addTo(map);
let latest = null, selectedId = null, locationMarker = null;
const storageKey = 'vestfjella-fiske-catches-v1';

function esc(s = '') { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function scoreColor(s) { return s >= 86 ? '#38d477' : s >= 75 ? '#b8df45' : '#f2c94c'; }
function compass(d) { if (!Number.isFinite(d)) return '–'; const a = ['N', 'NØ', 'Ø', 'SØ', 'S', 'SV', 'V', 'NV']; return `${a[Math.round((((d % 360) + 360) % 360) / 45) % 8]} · ${Math.round(d)}°`; }
function fmtTime(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? '–' : d.toLocaleString('no-NO', { weekday: 'short', hour: '2-digit', minute: '2-digit' }); }
function fishName(v) { return v === 'abbor' ? 'Abbor' : v === 'all' ? 'Beste art' : 'Ørret'; }
function setState(t) { $('status').textContent = t; }

function rules(r) {
  $('rulesGrid').innerHTML = `<div class="rule-pill"><strong>Sesong</strong>${esc(r.season)}</div><div class="rule-pill"><strong>Minstemål ørret</strong>${r.minTroutCm} cm</div><div class="rule-pill"><strong>Ikke tillatt</strong>Levende fisk som agn</div><div class="rule-pill"><strong>Fra vannet</strong>Ingen båt/kano/packraft til fiske</div><div class="rule-pill"><strong>Bom</strong>${r.tollNok} kr</div><div class="rule-pill"><strong>Fiskekort</strong><a href="${r.inaturUrl}" target="_blank" rel="noopener" style="color:#38d477">Åpne Inatur</a></div><div class="rule-pill"><strong>Hytter</strong>${r.huts || 2} utleiehytter i området · se Inatur-kartet</div>`;
}

function renderWeather(w) {
  $('weatherGrid').innerHTML = [['Tid', fmtTime(w.time)], ['Vind', Number.isFinite(w.wind) ? w.wind.toFixed(1) + ' m/s' : '–'], ['Retning', compass(w.windDir)], ['Skydekke', Number.isFinite(w.cloud) ? Math.round(w.cloud) + ' %' : '–'], ['Lufttemp.', Number.isFinite(w.temp) ? w.temp.toFixed(1) + ' °C' : '–'], ['Nedbør', Number.isFinite(w.precip) ? w.precip.toFixed(1) + ' mm' : '–'], ['Lufttrykk', Number.isFinite(w.pressure) ? Math.round(w.pressure) + ' hPa' : '–'], ['Trykktrend', Number.isFinite(w.pressureTrend) ? `${w.pressureTrend > 0 ? '+' : ''}${w.pressureTrend} hPa / 3t` : '–']].map(([a, b]) => `<div class="weather-item"><span>${a}</span><b>${b}</b></div>`).join('');
  let note = 'Lufttemperaturen er ikke det samme som vanntemperaturen.';
  if (Number.isFinite(w.temp) && w.temp > 23) note += ' Varmt vær trekker ned: søk dypere/kjøligere partier og vurder kortere fiskeøkter.';
  else note += ' NJFF oppgir 8–15 °C som trivselssone for ørret i vannet; appen later ikke som den kjenner temperaturen i disse små tjernene.';
  $('thermalNote').textContent = note;
}

function bestHtml(w) {
  if (!w) return '<p class="muted">Ingen vann matcher filteret.</p>';
  const l = w.lure;
  const mapActions = w.mapVerified
    ? `<button data-show="${w.id}">VIS PÅ KART</button><button class="secondary" data-nav="${w.lat},${w.lon}">NAVIGER</button>`
    : `<span class="tag">KARTPOSISJON UVERIFISERT</span>`;
  return `<div class="hero-score"><div class="score-big">${w.score}<small>/100</small></div><div><span class="card-label">${esc(fishName(w.targetFish))} · ${esc(w.bestMethod)}</span><h3>${esc(w.name)}</h3><p class="muted">${esc(w.character)}</p></div></div><div class="hero-grid"><article><span>TILKOMST</span><b>${esc(w.access)}</b></article><article><span>BESTE TID</span><b>${esc(w.best || 'Morgen / kveld')}</b></article><article><span>LOVLIG METODE</span><b>${esc(w.flyOnly ? 'Kun flue' : w.methods.join(' / '))}</b></article></div><div class="lure-box"><img class="zoom-lure" src="${l.image}" alt="${esc(l.name)}"><div><span class="card-label">SETT PÅ NÅ</span><b>${esc(l.name)}</b><small>${esc(l.why)}<br><strong>${esc(l.presentation)}</strong></small></div></div><div style="display:flex;gap:6px;margin-top:9px;align-items:center;flex-wrap:wrap">${mapActions}<button class="secondary" data-source="${esc(w.source)}">VANNINFO</button></div>`;
}

function popup(w, i) { return `<b>${i + 1}. ${esc(w.name)}</b><br>Score ${w.score}/100 · ${esc(fishName(w.targetFish))}<br>${w.flyOnly ? '<b style="color:#d8bfff">Kun fluefiske</b><br>' : ''}${esc(w.character)}<hr><b>${esc(w.lure.name)}</b><br>${esc(w.lure.presentation)}`; }
function markerIcon(w) { const c = scoreColor(w.score); return L.divIcon({ className: '', html: `<div class="map-score ${w.flyOnly ? 'fly-marker' : ''}" style="color:${c}">${w.score}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }); }

function renderMarkers(rows) {
  markerLayer.clearLayers();
  rows.filter(w => w.mapVerified).forEach((w, i) => {
    const m = L.marker([w.lat, w.lon], { icon: markerIcon(w), title: w.name }).bindPopup(popup(w, i));
    m.on('click', () => selectWater(w.id));
    m.addTo(markerLayer);
  });
}

function renderList(rows) {
  const verified = rows.filter(w => w.mapVerified).length;
  $('waterCount').textContent = `${rows.length} vann · ${verified} kartverifisert`;
  $('waterList').innerHTML = rows.map((w, i) => {
    const mapButtons = w.mapVerified
      ? `<button data-show="${w.id}">Vis kart</button> <button class="secondary" data-nav="${w.lat},${w.lon}">Naviger</button>`
      : `<span class="tag" title="Appen skjuler usikre koordinater i stedet for å vise dem på land">POSISJON UVERIFISERT</span>`;
    return `<article class="water-row ${selectedId === w.id ? 'selected-water' : ''}" data-water="${w.id}"><div class="rank">${i + 1}</div><div><div class="water-title"><b>${esc(w.name)}</b><span class="tag">${esc(w.access)}</span>${w.flyOnly ? '<span class="tag flyonly">KUN FLUE</span>' : ''}<span class="tag">${esc(fishName(w.targetFish))}</span></div><p>${esc(w.tips)}</p>${mapButtons}</div><div class="mini-lure"><img class="zoom-lure" src="${w.lure.image}" alt="${esc(w.lure.name)}"></div><div class="score-pill" style="color:${scoreColor(w.score)}">${w.score}</div></article>`;
  }).join('');
}

function renderTimeHint() {
  const mode = $('timeMode').value;
  const labels = { now: 'Forhold akkurat nå', '+3': 'Prognose om tre timer', '+6': 'Prognose om seks timer', evening: 'Neste kveldsøkt', tomorrow: 'I morgen tidlig' };
  $('timeHint').innerHTML = `<p><b>${labels[mode]}</b> · ${latest ? fmtTime(latest.targetTime) : ''}</p><div class="time-buttons">${[['now', 'Nå'], ['+3', '+3 t'], ['+6', '+6 t'], ['evening', 'Kveld'], ['tomorrow', 'I morgen']].map(([v, l]) => `<button class="${mode === v ? 'active' : ''}" data-time="${v}">${l}</button>`).join('')}</div>`;
}

function render(data) {
  latest = data;
  rules(data.rules);
  renderWeather(data.weather);
  $('goalBadge').textContent = `${fishName(data.fish)} · ${data.revision}`;
  const bestVerified = data.waters.find(w => w.mapVerified) || data.waters[0];
  $('bestNow').innerHTML = bestHtml(bestVerified);
  renderMarkers(data.waters);
  renderList(data.waters);
  renderTimeHint();
  populateCatch(data.waters);
  const p = data.positioning || {};
  setState(`Oppdatert ${new Date().toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' })} · ${data.waters.length} vann rangert · ${p.verified ?? 0} kartverifisert`);
}

async function load() {
  setState('Analyserer vær og vann …');
  const q = new URLSearchParams({ fish: $('fishType').value, goal: $('goal').value, method: $('method').value, access: $('access').value, time: $('timeMode').value });
  try {
    const r = await fetch('/api/analysis?' + q, { cache: 'no-store' });
    if (!r.ok) throw new Error('Analysefeil');
    render(await r.json());
  } catch (e) {
    setState('Kunne ikke hente liveanalyse');
    $('bestNow').innerHTML = '<p class="muted">Liveanalysen feilet. Prøv igjen om litt.</p>';
  }
}

function fitAllWaters() {
  try {
    const bounds = markerLayer.getBounds();
    if (bounds && bounds.isValid()) map.fitBounds(bounds.pad(0.15));
    else map.setView(center, 12);
  } catch {
    map.setView(center, 12);
  }
}

function selectWater(id) {
  selectedId = id;
  const w = latest?.waters.find(x => x.id === id);
  if (!w) return;
  if (w.mapVerified) map.flyTo([w.lat, w.lon], 14);
  $('bestNow').innerHTML = bestHtml(w);
  renderList(latest.waters);
  $('catchWater').value = id;
  $('catchLure').value = w.lure.name;
}

function populateCatch(rows) {
  const all = latest?.waters || rows;
  $('catchWater').innerHTML = all.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
  if (selectedId && all.some(w => w.id === selectedId)) $('catchWater').value = selectedId;
}

function readCatches() { try { return JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch { return []; } }
function renderCatches() { const a = readCatches(); $('catchEntries').innerHTML = a.slice(0, 6).map(x => `<div class="catch-entry"><b>${esc(x.waterName)}</b> · ${x.result === 'fangst' ? '🎣 fangst' : '– ingen fangst'}${x.length ? ' · ' + esc(x.length) + ' cm' : ''}<br>${esc(x.lure || '')} <span class="muted">${new Date(x.time).toLocaleString('no-NO')}</span>${x.note ? '<br>' + esc(x.note) : ''}</div>`).join('') || '<p class="muted">Ingen turer lagret ennå.</p>'; }

$('catchForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = new FormData(e.currentTarget), id = f.get('water'), w = latest?.waters.find(x => x.id === id) || { name: id };
  const a = readCatches();
  a.unshift({ time: new Date().toISOString(), water: id, waterName: w.name, result: f.get('result'), length: f.get('length'), lure: f.get('lure'), note: f.get('note'), weather: latest?.weather || null });
  localStorage.setItem(storageKey, JSON.stringify(a.slice(0, 200)));
  renderCatches();
  e.currentTarget.querySelector('[name=length]').value = '';
  e.currentTarget.querySelector('[name=note]').value = '';
});

document.addEventListener('click', e => {
  const img = e.target.closest('.zoom-lure');
  if (img) { $('dialogImage').src = img.src; $('dialogCaption').textContent = img.alt; $('imageDialog').showModal(); return; }
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.show) selectWater(b.dataset.show);
  if (b.dataset.nav) { const [lat, lon] = b.dataset.nav.split(','); window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`, '_blank', 'noopener'); }
  if (b.dataset.source) window.open(b.dataset.source, '_blank', 'noopener');
  if (b.dataset.time) { $('timeMode').value = b.dataset.time; load(); }
});

$('closeImage').onclick = () => $('imageDialog').close();
for (const id of ['fishType', 'goal', 'method', 'access', 'timeMode']) $(id).addEventListener('change', load);
$('mapStyle').addEventListener('change', () => {
  for (const l of [standard, satellite, depth]) if (map.hasLayer(l)) map.removeLayer(l);
  const v = $('mapStyle').value;
  if (v === 'satellite') satellite.addTo(map);
  else if (v === 'depth') { standard.addTo(map); depth.addTo(map); }
  else standard.addTo(map);
});
$('allWaters').onclick = () => fitAllWaters();
$('locate').onclick = () => navigator.geolocation?.getCurrentPosition(p => {
  const ll = [p.coords.latitude, p.coords.longitude];
  if (locationMarker) locationMarker.remove();
  locationMarker = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#55a7ff', fillOpacity: 1 }).addTo(map).bindPopup('Din posisjon');
  map.setView(ll, 14);
}, () => alert('Posisjon kunne ikke hentes.'));

renderCatches();
load();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
