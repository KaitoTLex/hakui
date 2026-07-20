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
      await worker.skipWaiting();
    })()
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Existing pages may still need their previous hashed assets after an immediate update.
      const previous = (await caches.keys()).filter((key) => key.startsWith('hakui-') && key !== cacheName);
      await Promise.all(previous.slice(0, -1).map((key) => caches.delete(key)));
    })()
  );
});

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin || url.pathname.startsWith('/api/')) return;

  if (assets.has(url.pathname) || url.pathname.startsWith('/_app/immutable/')) {
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
