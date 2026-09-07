const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const waters = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'waters.json'), 'utf8'));
const UA = process.env.MET_USER_AGENT || 'vestfjella-fiske/1.0 contact: local-app';
const cache = new Map();

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function hashKey(str = '') { let h = 0; for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; } return Math.abs(h); }
function pickFromPool(pool, key, offset = 0) { return pool[(hashKey(key) + offset) % pool.length]; }

function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.value);
  return Promise.resolve(fn()).then(value => (cache.set(key, { until: Date.now() + ms, value }), value));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function targetDate(mode, now = new Date()) {
  const d = new Date(now);
  if (mode === '+3') return new Date(d.getTime() + 3 * 3600000);
  if (mode === '+6') return new Date(d.getTime() + 6 * 3600000);
  if (mode === 'evening') { const x = new Date(d); x.setHours(19, 0, 0, 0); if (x <= d) x.setDate(x.getDate() + 1); return x; }
  if (mode === 'tomorrow') { const x = new Date(d); x.setDate(x.getDate() + 1); x.setHours(7, 30, 0, 0); return x; }
  return d;
}

function fallbackForecast() {
  const out = [];
  const start = new Date();
  start.setMinutes(0, 0, 0);
  for (let i = 0; i < 60; i++) {
    const t = new Date(start.getTime() + i * 3600000);
    out.push({
      time: t.toISOString(),
      temp: 14 + (i % 6 <= 2 ? 1 : -1),
      wind: 2.4 + ((i % 5) * 0.4),
      windDir: 180,
      cloud: 55 + ((i % 4) * 8),
      pressure: 1014 + ((i % 6) - 2),
      precip: i % 7 === 0 ? 0.3 : 0,
      symbol: 'partlycloudy_day'
    });
  }
  return out;
}

async function forecast(lat, lon) {
  const key = `met:${lat.toFixed(3)},${lon.toFixed(3)}`;
  return cached(key, 10 * 60 * 1000, async () => {
    try {
      const j = await fetchJson(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
      return j.properties.timeseries.slice(0, 60).map(x => {
        const d = x.data.instant.details || {};
        const n = x.data.next_1_hours || x.data.next_6_hours || {};
        return {
          time: x.time,
          temp: d.air_temperature ?? null,
          wind: d.wind_speed ?? null,
          windDir: d.wind_from_direction ?? null,
          cloud: d.cloud_area_fraction ?? null,
          pressure: d.air_pressure_at_sea_level ?? null,
          precip: n.details?.precipitation_amount ?? 0,
          symbol: n.summary?.symbol_code || ''
        };
      });
    } catch (e) {
      return fallbackForecast();
    }
  });
}

function nearest(series, target) {
  let best = series[0], dist = Infinity;
  for (const x of series) {
    const d = Math.abs(new Date(x.time) - target);
    if (d < dist) { dist = d; best = x; }
  }
  return best;
}

function pressureTrend(series, item) {
  const i = series.indexOf(item);
  if (i < 0) return null;
  const j = Math.min(series.length - 1, i + 3);
  const a = Number(item.pressure), b = Number(series[j]?.pressure);
  return Number.isFinite(a) && Number.isFinite(b) ? Number((b - a).toFixed(1)) : null;
}

function troutScore(w, wth, { goal = 'numbers', method = 'all' } = {}) {
  if (method !== 'all' && !w.methods.includes(method)) return null;
  let s = goal === 'big' ? w.big : w.base;
  const hour = new Date(wth.time).getHours();
  s += Number(w.troutBias || 0);
  if (hour <= 9 || hour >= 17) s += 8; else if (hour <= 12) s += 4; else s -= 2;
  if (Number.isFinite(wth.wind)) {
    if (w.flyOnly) s += (wth.wind >= 0.4 && wth.wind <= 4) ? 8 : (wth.wind > 7 ? -10 : 2);
    else if (w.waterBody === 'open_lake') s += (wth.wind >= 1.8 && wth.wind <= 6.5) ? 9 : (wth.wind > 10 ? -8 : (wth.wind < 0.5 ? -2 : 2));
    else s += (wth.wind >= 1.2 && wth.wind <= 5) ? 7 : (wth.wind > 10 ? -9 : (wth.wind < 0.4 ? -3 : 1));
  }
  if (Number.isFinite(wth.cloud)) {
    if (w.waterTone === 'clear') s += wth.cloud >= 25 && wth.cloud <= 80 ? 7 : (wth.cloud > 90 ? 3 : -2);
    else if (w.waterTone === 'dark') s += wth.cloud >= 20 && wth.cloud <= 95 ? 4 : 0;
    else s += wth.cloud >= 35 && wth.cloud <= 90 ? 6 : (wth.cloud > 90 ? 4 : -2);
  }
  if (Number.isFinite(wth.temp)) {
    if (wth.temp >= 6 && wth.temp <= 16) s += 5;
    else if (wth.temp > 23) s -= 7;
    else s += 1;
  }
  if (Number.isFinite(wth.precip)) {
    if (wth.precip > 0 && wth.precip <= 2) s += 2;
    else if (wth.precip > 5) s -= 5;
  }
  if (w.accessScore <= 2 && goal === 'big') s += 2;
  return clamp(Math.round(s), 20, 99);
}

function perchScore(w, wth, { goal = 'numbers', method = 'all' } = {}) {
  if (method === 'flue' && w.flyOnly === false) return null;
  if (method !== 'all' && !w.methods.includes(method)) return null;
  let s = 63 + (w.accessScore - 3) * 2 + Number(w.perchBias || 0);
  const hour = new Date(wth.time).getHours();
  if (hour >= 7 && hour <= 20) s += 5;
  if (Number.isFinite(wth.temp) && wth.temp >= 10) s += 7;
  if (Number.isFinite(wth.wind) && wth.wind <= 6) s += 4;
  if (Number.isFinite(wth.cloud) && wth.cloud >= 25 && wth.cloud <= 85) s += 3;
  if (w.flyOnly) s -= 5;
  if (w.waterBody === 'open_lake') s += 2;
  if (goal === 'big' && ['skibuvannet', 'laua', 'fyldengorvann', 'ostre-krokvann', 'sondre-krokvann'].includes(w.id)) s += 7;
  return clamp(Math.round(s), 20, 96);
}


function lurePool(w, wth, fish = 'orret') {
  const hour = new Date(wth.time).getHours();
  const low = hour <= 9 || hour >= 17;
  const cloud = Number(wth.cloud) || 0;
  const wind = Number(wth.wind) || 0;
  const wet = Number(wth.precip) || 0;
  const clear = cloud <= 30 && wet < 0.2;
  const dark = cloud >= 75 || wet > 0.3;
  const shallow = (Number(w.depth) || 0) <= 4;
  const large = (Number(w.size) || 0) >= 120;
  const tone = w.waterTone || 'mixed';
  const open = w.waterBody === 'open_lake';

  const troutFlyTop = [
    { method: 'Flue', name: 'Hvit baitfish / liten streamer', image: '/lures/fly_hvit_baitfish.jpg', why: 'Rolig morgen- eller kveldsfiske i vaksoner. Fisk høyt og lett over marbakken.', presentation: 'Lange pauser og korte rykk. Kast langs siv, odder og innløp.' },
    { method: 'Flue', name: 'Liten mørk nymfe / våtflue', image: '/lures/fly_kobber_streamer.jpg', why: 'Når det ikke vaker jevnt er en diskret flue tryggest start i fly-only-vann.', presentation: 'Drift sakte eller fisk korte rolige trekk med lange stopp.' },
    { method: 'Flue', name: 'Lys zonker / streamer', image: '/lures/fly_hvit_zonker.jpg', why: 'Når du vil dekke mer vann uten å ofre et naturtro uttrykk.', presentation: 'Trekk i korte serier og la flua henge i pausene.' },
    { method: 'Flue', name: 'Rosa bugger / triggerflue', image: '/lures/fly_rosa_bugger.jpg', why: 'Fin joker når flere standardmønstre er testet uten reaksjon.', presentation: 'Trekk rolig og jevnt med små stopp.' }
  ];
  const troutFlySub = [
    { method: 'Flue', name: 'Liten nymfe / våtflue', image: '/lures/fly_kobber_streamer.jpg', why: 'Litt vind eller mindre aktivitet gjør nymfe/våtflue til sikrere førstevalg.', presentation: 'Fisk sakte, gjerne på skrått inn over grunnkant og marbakke.' },
    { method: 'Flue', name: 'Liten streamer', image: '/lures/fly_hvit_baitfish.jpg', why: 'Bruk streamer når du vil søke litt raskere av større flater.', presentation: 'Korte trekk i serier, deretter pause så flua henger og jobber.' },
    { method: 'Flue', name: 'Lys zonker / streamer', image: '/lures/fly_hvit_zonker.jpg', why: 'Bra når du vil fiske litt større profil under vakende fisk.', presentation: 'Trekk i korte serier med lange heng.' },
    { method: 'Flue', name: 'Rosa bugger / triggerflue', image: '/lures/fly_rosa_bugger.jpg', why: 'Fin joker når flere standardmønstre er testet uten reaksjon.', presentation: 'Trekk rolig og jevnt med små stopp.' }
  ];
  const troutDarkSearch = [
    { method: 'Sluk', name: 'Gul/oransje prikket', image: '/lures/gul-oransje-prikket.jpg', why: 'Sterk kontrast når lyset er flatt, vannet er farget eller regn har trigget ørreten.', presentation: 'Middels fart med korte spinnstopp. Start grunt og jobb deg nedover.' },
    { method: 'Sluk', name: 'Sølv med røde prikker og fjær', image: '/lures/trout_spoon_solv_rod_dots_fjaer.jpg', why: 'Blink og tydelige prikker gjør den god som søkesluk i gråvær og lett krusning.', presentation: 'Kast på tvers av vind og sveiv jevnt med 1–2 små stopp per kast.' },
    { method: 'Spinner', name: 'Mepps hvit/rød', image: '/lures/trout_spinner_mepps_hvit_rod.jpg', why: 'Spinner er ofte rå når ørreten står aktivt langs kanter, os og bekkeutløp.', presentation: 'Start så fort bladet går rundt og varier mellom jevn fart og små akselerasjoner.' },
    { method: 'Spinner', name: 'Sort/rød spinner med fjær', image: '/lures/trout_spinner_svart_rod_fjaer.jpg', why: 'Mye puls og tydelig silhuett når fisken jakter tett på land.', presentation: 'Fisk langs stein, nes og sivkanter med jevn fart og korte stopp.' },
    { method: 'Sluk', name: 'Gull/rød skjesluk', image: '/lures/trout_spoon_gull_rod_18.jpg', why: 'Varme toner og godt flimmer gjør den veldig anvendelig i myrpregede vann.', presentation: 'Rolig sveiv i bue over grunner og langs myrkanter.' }
  ];
  const troutLowWarm = [
    { method: 'Sluk', name: 'Rød bred prikket', image: '/lures/rod-bred-prikket.jpg', why: 'Stor silhuett og god synlighet gjør den sterk i dempet morgen- og kveldslys.', presentation: 'La sluken synke 1–3 sekunder før rolig innsveiving.' },
    { method: 'Sluk', name: 'Oransje skjesluk', image: '/lures/oransje-skje.jpg', why: 'Varm kobbertone er ofte giftig når lyset er lavt og vannet har litt farge.', presentation: 'Sveiv sakte til middels. Gi sluken tid til å vugge bredt.' },
    { method: 'Sluk', name: 'Rød smal prikket', image: '/lures/rod-smal-prikket.jpg', why: 'Et sikkert allround-valg når fisken ikke viser seg klart.', presentation: 'Jevn fart og små stopp. La sluken synke litt dypere hvert femte kast.' },
    { method: 'Sluk', name: 'Gull/rød skjesluk', image: '/lures/trout_spoon_gull_rod_18.jpg', why: 'Fin blanding av varme toner og ekstra flimmer.', presentation: 'Rolig sveiv i bue over grunner og langs myrkanter.' },
    { method: 'Sluk', name: 'Sølv/sorte prikker', image: '/lures/solv-sorte-prikker.jpg', why: 'Fin kontrast når du vil nedskalere litt uten å miste synlighet.', presentation: 'Jevn middels fart med et lite stopp før land.' }
  ];
  const troutClearNatural = [
    { method: 'Sluk', name: 'Sølv/blå', image: '/lures/solv-bla.jpg', why: 'Naturtro flash passer fint i klart vann og ved roligere forhold.', presentation: 'Rolig innsveiving høyt i vannet. Vær lett på hånden og hold god avstand.' },
    { method: 'Wobbler', name: 'Liten ørretmønstret wobbler', image: '/lures/trout_wobbler_orretpattern.jpg', why: 'Diskret wobbling og naturfarge fungerer godt i klart vann på sky ørret.', presentation: 'Stopp-and-go med korte pauser. Fisk ekstra nøye langs marbakken.' },
    { method: 'Sluk', name: 'Sølv med røde prikker', image: '/lures/trout_spoon_solv_rod_dots.jpg', why: 'Mer diskret enn rene signalfarger, men med nok kontrast til å synes.', presentation: 'Lange kast og rolig fart. Bytt vinkel ofte før du bytter plass.' },
    { method: 'Spinner', name: 'Spinner sølv/blå-holo', image: '/lures/trout_spinner_holo_bla_hvit.jpg', why: 'Fin i solgløtt og småkrusning der du vil ha mer vibrasjon uten grove farger.', presentation: 'Jevn fart like over kantene.' },
    { method: 'Wobbler', name: 'Vobler ørret/natur', image: '/lures/vobler-orret.jpg', why: 'Gir en roligere, naturtro presentasjon i klart vann.', presentation: 'Trekk rykkvis med korte pauser langs marbakken.' }
  ];
  const troutMixedAllround = [
    { method: 'Sluk', name: 'Rosa/sølv prikket', image: '/lures/rosa-solv-prikket.jpg', why: 'Svært god søkesluk når du trenger både flash og farge.', presentation: 'Middels fart og et lite spinnstopp halvveis i kastet.' },
    { method: 'Spinner', name: 'Mepps gull/rød', image: '/lures/trout_spinner_mepps_gull_rod.jpg', why: 'God kombinasjon av varme toner og vibrasjon i lett farget eller småkruset vann.', presentation: 'Sveiv akkurat raskt nok til stabil gange og hold spinneren nær struktur.' },
    { method: 'Wobbler', name: 'Liten brunørret-wobbler', image: '/lures/trout_wobbler_brunorret.jpg', why: 'Bra valg i små tjern og vann der fisken beiter på småfisk eller insekt klekkingsnært.', presentation: 'Rolig rykkvis føring med pauser helt inn mot land.' },
    { method: 'Sluk', name: 'Blå/pars-sluk', image: '/lures/trout_sluk_bla_parr.jpg', why: 'Naturpreg med litt mer kropp og flukt i vannet.', presentation: 'Fiskes med rolig til middels fart og små stopp.' },
    { method: 'Sluk', name: 'Svart/gule prikker', image: '/lures/svart-gule-prikker.jpg', why: 'Bra kontrastagn når lyset skifter raskt eller fisken virker selektiv.', presentation: 'Rolig innsveiving med små stopp ved viker og myrkanter.' },
    { method: 'Sluk', name: 'Grønn/svart', image: '/lures/gronn-svart.jpg', why: 'Et litt annerledes natur/kontrast-valg når standardrødt ikke leverer.', presentation: 'Prøv korte synk og rolig innsveiving langs kantene.' }
  ];
  const troutOpenWater = [
    { method: 'Sluk', name: 'Langsluk sølv/rosa', image: '/lures/trout_langsluk_solv_rosa.jpg', why: 'Dekker mye vann og fisker stabilt i vindutsatte større vann.', presentation: 'Lange kast i vifteform, middels innsveiving.' },
    { method: 'Sluk', name: 'Blå/rød skjesluk med fjær', image: '/lures/trout_spoon_bla_rod_fjaer.jpg', why: 'Tydelig profil og fin gang når bølgene bygger seg opp.', presentation: 'La den synke litt før jevn innsveiving.' },
    { method: 'Spinner', name: 'Sølvspinner', image: '/lures/trout_spinner_solv.jpg', why: 'Et effektivt søkeagn når fisken følger landkanter i større vann.', presentation: 'Sveiv jevnt og hold kontakt hele veien inn.' },
    { method: 'Wobbler', name: 'Liten regnbuewobbler', image: '/lures/trout_wobbler_regnbue.jpg', why: 'Fin joker når fisken vil ha litt mer liv og farge i åpne vann.', presentation: 'Kort stopp-and-go over marbakker og vindsider.' },
    { method: 'Sluk', name: 'Langsluk gul', image: '/lures/trout_langsluk_gul.jpg', why: 'God på lange kast i større vann når du vil ha litt mer farge.', presentation: 'Jevn fart gjennom vindbaner og skrånende dyp.' }
  ];

  const perchContrast = [
    { method: 'Spinner', name: 'Sort/gul spinner', image: '/lures/trout_spinner_svart_gul.jpg', why: 'Kontrastfarger og mye vibrasjon trigger aktiv abbor i gråvær eller skumring.', presentation: 'Kast tett på vegetasjon og sveiv jevnt med små pauser.' },
    { method: 'Softbait/jigg', name: 'Blå softbait på jigg', image: '/lures/perch_softbait_bla.jpg', why: 'Fin når abboren står litt dypere og vil ha noe som fiskes saktere.', presentation: 'La jiggen synke til bunn eller ønsket dyp. To små løft og pause.' },
    { method: 'Spinnerbait', name: 'Oransje spinnerbait', image: '/lures/perch_spinnerbait_oransje.jpg', why: 'God i litt grumsete forhold eller rundt siv og spredt vegetasjon.', presentation: 'Sveiv jevnt med korte løft gjennom kantsonene.' }
  ];
  const perchShallow = [
    { method: 'Topwater/frog', name: 'Frog-lure', image: '/lures/perch_frog_gul.jpg', why: 'I varme, grunne partier med vegetasjon kan topwater være både effektivt og moro.', presentation: 'Fisk over vegetasjon med korte nikk og pauser i åpne lommer.' },
    { method: 'Spinner', name: 'Sort/gul spinner', image: '/lures/trout_spinner_svart_gul.jpg', why: 'Når vegetasjonen ikke er helt tett er spinner fortsatt et sikkert søkeagn for abbor.', presentation: 'Middels fart og la den passere tett forbi siv og stein.' },
    { method: 'Softbait/jigg', name: 'Blå softbait på jigg', image: '/lures/perch_softbait_bla.jpg', why: 'Et roligere alternativ når toppvannsaktiviteten dabber av.', presentation: 'Korte hopp nær vegetasjonskanter.' }
  ];
  const perchClear = [
    { method: 'Wobbler', name: 'Liten gullfarget wobbler', image: '/lures/trout_wobbler_gull.jpg', why: 'Liten profil og naturpreg passer godt når abboren følger etter uten å hugge hardt.', presentation: 'Fisk rykkvis og legg inn lengre stopp nær stein og dypkanter.' },
    { method: 'Softbait/jigg', name: 'Blå softbait på jigg', image: '/lures/perch_softbait_bla.jpg', why: 'Jigg er ofte best når fisken står litt under jagende småfisk og vil ha roligere presentasjon.', presentation: 'Tell ned til ønsket dyp og jobb med små løft.' },
    { method: 'Spinner', name: 'Sølvspinner', image: '/lures/trout_spinner_solv.jpg', why: 'Når du vil søke av mer vann med litt mer fart.', presentation: 'Jevn fart gjennom stimer og langs steinpartier.' }
  ];

  if (w.flyOnly) return (low && wind <= 3) ? troutFlyTop : troutFlySub;

  if (fish === 'abbor') {
    let pool = [];
    if (shallow && low) pool = pool.concat(perchShallow);
    if (dark || wind >= 4 || tone === 'dark') pool = pool.concat(perchContrast);
    pool = pool.concat(perchClear);
    return pool;
  }

  let pool = [];
  if (open) pool = pool.concat(troutOpenWater);
  if (dark || tone === 'dark') pool = pool.concat(troutDarkSearch);
  if (low && !clear) pool = pool.concat(troutLowWarm);
  if (clear && wind < 2 && tone === 'clear') pool = pool.concat(troutClearNatural);
  if (large && !open) pool = pool.concat(troutOpenWater.slice(0, 3));
  pool = pool.concat(troutMixedAllround);
  if (tone === 'clear') pool = pool.concat(troutClearNatural.slice(0, 3));
  if (tone === 'dark') pool = pool.concat(troutLowWarm.slice(0, 3));

  const seen = new Set();
  return pool.filter(item => {
    const key = item.image;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function diversifyLures(rows, wth) {
  const recentImages = [];
  const topBlockImages = new Set();
  return rows.map((w, index) => {
    const pool = lurePool(w, wth, w.targetFish);
    const signature = hashKey(`${w.id}-${w.targetFish}-${w.waterTone || 'mixed'}-${w.waterBody || ''}`) % 7;
    const start = hashKey(`${w.id}-${w.targetFish}-${new Date(wth.time).getHours()}-${Math.round(wth.cloud || 0)}-${Math.round(wth.wind || 0)}-${signature}`) % pool.length;

    const rotated = [];
    for (let i = 0; i < pool.length; i++) rotated.push(pool[(start + i) % pool.length]);

    let choice = rotated.find(item => !recentImages.slice(-4).includes(item.image) && (index >= 15 || !topBlockImages.has(item.image)));
    if (!choice) choice = rotated.find(item => !recentImages.slice(-3).includes(item.image));
    if (!choice) choice = rotated.find(item => !recentImages.slice(-2).includes(item.image));
    if (!choice) choice = rotated[0];

    recentImages.push(choice.image);
    if (index < 15) topBlockImages.add(choice.image);
    return { ...w, lure: choice };
  });
}

function bestMethod(w, wth, fish) {
  if (w.flyOnly) return 'flue';
  const hour = new Date(wth.time).getHours();
  const clear = (wth.cloud ?? 50) < 30 && (wth.wind ?? 2) < 2;
  if (fish === 'abbor') return (w.waterBody === 'open_lake' || (w.perchBias || 0) >= 6) ? 'spinner' : 'mark';
  if (hour >= 11 && hour <= 15 && clear && w.accessScore >= 3) return 'mark';
  if ((w.waterBody === 'open_lake' && (wth.wind ?? 0) >= 3) || (w.waterTone === 'dark' && hour <= 9)) return 'spinner';
  return 'sluk';
}

async function analysis(query) {
  const mode = query.get('time') || 'now';
  const fish = query.get('fish') || 'orret';
  const goal = query.get('goal') || 'numbers';
  const method = query.get('method') || 'all';
  const access = query.get('access') || 'all';

  const target = targetDate(mode);
  const center = { lat: 59.2700, lon: 11.5890 };
  const series = await forecast(center.lat, center.lon);
  const wth = nearest(series, target);
  wth.pressureTrend = pressureTrend(series, wth);

  let rows = waters.waters.map(w => {
    let score = fish === 'abbor' ? perchScore(w, wth, { goal, method }) : troutScore(w, wth, { goal, method });
    if (fish === 'all') {
      const ts = troutScore(w, wth, { goal, method });
      const ps = perchScore(w, wth, { goal, method });
      if (ts === null && ps === null) return null;
      const targetFish = (ts ?? 0) >= (ps ?? 0) ? 'orret' : 'abbor';
      score = Math.max(ts ?? 0, ps ?? 0);
      return { ...w, score, targetFish, bestMethod: bestMethod(w, wth, targetFish) };
    }
    if (score === null) return null;
    return { ...w, score, targetFish: fish, bestMethod: bestMethod(w, wth, fish) };
  }).filter(Boolean);

  if (access !== 'all') rows = rows.filter(w => access === 'easy' ? w.accessScore >= 4 : w.accessScore <= 3);
  rows.sort((a, b) => b.score - a.score || b.accessScore - a.accessScore || a.name.localeCompare(b.name, 'no'));
  rows = diversifyLures(rows, wth);

  return {
    revision: 'REV 3',
    generatedAt: new Date().toISOString(),
    targetTime: wth.time,
    weather: wth,
    fish,
    goal,
    method,
    access,
    rules: waters.official,
    waters: rows
  };
}

function mime(f) {
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
  }[path.extname(f)] || 'application/octet-stream');
}

function serve(req, res) {
  let p = new URL(req.url, 'http://x').pathname;
  if (p === '/') p = '/index.html';
  p = path.normalize(p).replace(/^([.][.][/\\])+/, '');
  const f = path.join(PUBLIC, p);
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); res.end('Not found'); }
    else {
      res.writeHead(200, { 'Content-Type': mime(f), 'Cache-Control': p === '/index.html' ? 'no-store' : 'public, max-age=300' });
      res.end(b);
    }
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, app: 'Vestfjella Fiske', revision: 'REV 3', waters: waters.waters.length }));
    }
    if (u.pathname === '/api/analysis') {
      const data = await analysis(u.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    serve(req, res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || String(e) }));
  }
});

if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log(`Vestfjella Fiske REV 3 på http://0.0.0.0:${PORT}`));
module.exports = { server, analysis, targetDate, troutScore, diversifyLures };
