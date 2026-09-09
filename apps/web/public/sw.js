/* Only a build-owned, explicit app shell is cached. User/API data never enters Cache Storage. */
const PREFIX = 'webchat-shell-';
const CACHE = PREFIX + '__BUILD_ID__';
let shell;
async function manifest() {
  if (!shell) shell = fetch('/shell-manifest.json', { cache: 'no-store' }).then((r) => r.json());
  return shell;
}
self.addEventListener('install', (event) => {
  event.waitUntil(
    manifest().then(async ({ version, assets }) => {
      if (CACHE !== PREFIX + version) throw new Error('shell_version_mismatch');
      const cache = await caches.open(CACHE);
      await cache.addAll([...assets, '/shell-manifest.json']);
    }),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX));
      const previous = names.filter((name) => name !== CACHE).at(-1);
      await Promise.all(
        names
          .filter((name) => name !== CACHE && name !== previous)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('message', (event) => {
  if (event.data === 'activate-update') self.skipWaiting();
});
self.addEventListener('fetch', (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    request.headers.has('Authorization')
  )
    return;
  event.respondWith(
    (async () => {
      const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX));
      const cache = names.includes(CACHE) ? await caches.open(CACHE) : null;
      const cached = cache
        ? await cache.match(request.mode === 'navigate' ? '/' : request, { ignoreSearch: false })
        : null;
      if (request.mode === 'navigate') {
        try {
          return await fetch(request);
        } catch {
          if (cached) return cached;
          throw new Error('offline');
        }
      }
      if (cached) return cached;
      for (const name of names.filter((name) => name !== CACHE)) {
        const previous = await (await caches.open(name)).match(request);
        if (previous) return previous;
      }
      return fetch(request);
    })(),
  );
});
