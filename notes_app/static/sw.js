/* Kill switch: remove every cache and this worker, then reload open tabs from the network. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.registration.unregister();
    const tabs = await self.clients.matchAll({ type: 'window' });
    tabs.forEach(t => t.navigate(t.url));
  })());
});
