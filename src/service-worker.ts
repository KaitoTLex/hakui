import { build, files, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;
const cacheName = `hakui-${version}`;
const assets = new Set([...build, ...files]);
const routes = ['/', '/transactions', '/capture', '/settings'];

worker.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      await cache.addAll([...assets]);
      await Promise.allSettled(routes.map((route) => cache.add(route)));
    })()
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith('hakui-') && key !== cacheName).map((key) => caches.delete(key)));
      await worker.clients.claim();
    })()
  );
});

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin || url.pathname.startsWith('/api/')) return;

  if (assets.has(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(cacheName);
        try {
          const response = await fetch(request);
          if (response.ok) await cache.put(url.pathname, response.clone());
          return response;
        } catch {
          return (await cache.match(url.pathname)) ?? (await cache.match('/')) ?? Response.error();
        }
      })()
    );
  }
});
