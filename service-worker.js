// service-worker.js
const CACHE = 'novel-reader-cv-v2';

// These files change often — always network-first
const NETWORK_FIRST = [
  '/novel-translate-pwa/',
  '/novel-translate-pwa/index.html',
  '/novel-translate-pwa/app.js',
  '/novel-translate-pwa/app.css',
  '/novel-translate-pwa/metadata-worker.js',
  '/novel-translate-pwa/service-worker.js',
];

// These are large/stable — cache-first (engine, fonts)
const CACHE_FIRST_PATTERNS = [
  '/novel-translate-pwa/core/',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
];

self.addEventListener('install', e => {
  // Immediately take over without waiting
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Delete old caches
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const path = url.pathname;

  // Cache-first for stable large files
  const isCacheFirst = CACHE_FIRST_PATTERNS.some(p => url.href.includes(p));
  if (isCacheFirst) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return resp;
      }))
    );
    return;
  }

  // Network-first for app files — always get latest, fallback to cache offline
  e.respondWith(
    fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return resp;
    }).catch(() => caches.match(e.request))
  );
});