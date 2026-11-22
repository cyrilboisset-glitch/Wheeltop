// Service worker : fonctionnement hors ligne (l'appli doit avoir été ouverte une fois en ligne).
const CACHE = 'wheeltop-v1';
const FILES = [
  './', 'index.html', 'manifest.json', 'css/style.css',
  'js/app.js', 'js/protocol.js', 'js/eds-session.js', 'js/web-bluetooth.js', 'js/simulator.js', 'js/tuning.js', 'js/storage.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Réseau d'abord (pour recevoir les mises à jour), cache en secours hors ligne.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
