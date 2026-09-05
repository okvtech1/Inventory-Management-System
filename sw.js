// OKV Inventory Management System — Online Edition — service worker
// Caches the app shell (HTML/CSS/JS/icons) so the installed app opens
// instantly and can run offline between syncs. Business data itself lives
// in IndexedDB (synced with the Apps Script backend — see app.html's
// pushToServer_/pullFromServer_/syncNow), never in this cache.

const CACHE_NAME = 'okv-ims-online-shell-v3';
const ASSETS = [
  './',
  './index.html',
  './demo.html',
  './pricing.html',
  './login.html',
  './app.html',
  './install.html',
  './signup.html',
  './reset-password.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './manuals/OKV-IMS-Admin-Manual.pdf',
  './manuals/OKV-IMS-Staff-Manual.pdf',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Never cache calls to the Apps Script API — those must always hit the
  // network (or fail cleanly) so login/sync/admin actions are never served
  // stale from cache.
  if (event.request.url.includes('script.google.com')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
    })
  );
});
