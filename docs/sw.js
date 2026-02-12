const CACHE = 'mizan-v3';

self.addEventListener('install', e => {
  console.log('[SW] install v3');
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([
    'quran-verses.min.json',
    'icon-128.png', 'icon-512.png', 'manifest.json'
  ])));
});

self.addEventListener('activate', e => {
  console.log('[SW] activate v3');
  clients.claim();
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.map(k => caches.delete(k))
  )));
});

self.addEventListener('fetch', e => {
  if (e.request.destination === 'document' || e.request.destination === '') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/mizan-checker/index.html')));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok && (e.request.url.includes('quran-verses') || e.request.url.includes('icon') || e.request.url.includes('manifest'))) {
        caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      }
      return res;
    }))
  );
});
