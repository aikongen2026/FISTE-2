const CACHE = 'vestfjella-fiste-stable-1-3';
const SHELL = ["/", "/index.html", "/style.css?v=1.3", "/fishing-insights.js?v=1.3", "/app.js?v=1.3", "/manifest.webmanifest?v=1.3", "/icon.svg", "/data/user-lures.json", "/data/vestfjella-waters.json", "/lures/vestfjella/fly_hvit_baitfish.jpg", "/lures/vestfjella/fly_hvit_zonker.jpg", "/lures/vestfjella/fly_kobber_streamer.jpg", "/lures/vestfjella/fly_rosa_bugger.jpg", "/lures/vestfjella/gronn-svart.jpg", "/lures/vestfjella/gul-oransje-prikket.jpg", "/lures/vestfjella/oransje-skje.jpg", "/lures/vestfjella/perch_frog_gul.jpg", "/lures/vestfjella/perch_softbait_bla.jpg", "/lures/vestfjella/perch_spinnerbait_oransje.jpg", "/lures/vestfjella/rod-bred-prikket.jpg", "/lures/vestfjella/rod-smal-prikket.jpg", "/lures/vestfjella/rosa-solv-prikket.jpg", "/lures/vestfjella/solv-bla.jpg", "/lures/vestfjella/solv-sorte-prikker.jpg", "/lures/vestfjella/svart-gule-prikker.jpg", "/lures/vestfjella/trout_langsluk_gul.jpg", "/lures/vestfjella/trout_langsluk_solv_rosa.jpg", "/lures/vestfjella/trout_spinner_holo_bla_hvit.jpg", "/lures/vestfjella/trout_spinner_mepps_gull_rod.jpg", "/lures/vestfjella/trout_spinner_mepps_hvit_rod.jpg", "/lures/vestfjella/trout_spinner_svart_rod_fjaer.jpg", "/lures/vestfjella/trout_spoon_gull_rod_18.jpg", "/lures/vestfjella/trout_spoon_solv_rod_dots.jpg", "/lures/vestfjella/trout_spoon_solv_rod_dots_fjaer.jpg", "/lures/vestfjella/trout_wobbler_brunorret.jpg", "/lures/vestfjella/trout_wobbler_gull.jpg", "/lures/vestfjella/trout_wobbler_orretpattern.jpg", "/lures/vestfjella/trout_wobbler_regnbue.jpg"];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) { event.respondWith(fetch(request)); return; }
  if (url.origin !== self.location.origin) return;
  const networkFirst = request.mode === 'navigate' || ['style','script'].includes(request.destination);
  if (networkFirst) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request).then(cached => cached || caches.match('/index.html'))));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
    return response;
  }).catch(() => caches.match('/index.html'))));
});
