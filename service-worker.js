// service-worker.js
const CACHE = 'novel-reader-cv-v3';

const CACHE_FIRST_PATTERNS = [
  '/novel-translate-pwa/core/',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
];

// Never cache — LFS pointer or external data handled by app/IDB
const NEVER_CACHE = [
  '/novel-translate-pwa/data/',
  'r2.dev',
];

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never cache these
  if (NEVER_CACHE.some(p => url.href.includes(p))) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first for stable large files
  if (CACHE_FIRST_PATTERNS.some(p => url.href.includes(p))) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return resp;
      }))
    );
    return;
  }

  // Network-first for all app files
  e.respondWith(
    fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return resp;
    }).catch(() => caches.match(e.request))
  );
});