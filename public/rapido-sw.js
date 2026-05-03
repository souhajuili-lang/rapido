// ═══════════════════════════════════════════════════
// RAPIDO — Service Worker
// Strategy: Cache-first for assets, Network-first for API
// ═══════════════════════════════════════════════════

const SW_VERSION = 'rapido-v1.0.0';
const STATIC_CACHE = SW_VERSION + '-static';
const DYNAMIC_CACHE = SW_VERSION + '-dynamic';

// Files to cache on install
const PRECACHE_URLS = [
  './rapido-client.html',
  './rapido-driver.html',
  './rapido-admin.html',
  './rapido-backend.js',
  './rapido-client.webmanifest',
  './rapido-driver.webmanifest',
  './rapido-admin.webmanifest',
  './rapido-icon-192.png',
  './rapido-icon-512.png',
  './rapido-icon-driver-192.png',
  './rapido-icon-driver-512.png',
  './rapido-icon-admin-192.png',
  './rapido-icon-admin-512.png',
  'https://fonts.googleapis.com/css2?family=Pacifico&family=Nunito:wght@400;600;700;800;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

// API origin — network-first, no caching
const API_ORIGIN = 'rapido-production.up.railway.app';

// ── Install ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      // Cache each URL individually so one failure doesn't block install
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Failed to cache:', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate — clean old caches ──────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== DYNAMIC_CACHE)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin API calls
  if (request.method !== 'GET') return;

  // API calls → Network-first, fallback to cache (read-only)
  if (url.hostname === API_ORIGIN || url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Socket.io handshake — always network
  if (url.pathname.includes('/socket.io/')) return;

  // Static assets → Cache-first, fallback to network + cache
  event.respondWith(cacheFirst(request));
});

// ── Strategies ────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Return offline fallback page if HTML is requested
    if (request.headers.get('accept')?.includes('text/html')) {
      const fallback = await caches.match('./rapido-client.html');
      if (fallback) return fallback;
    }
    return new Response('Hors ligne — veuillez vérifier votre connexion.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response(JSON.stringify({ error: 'Hors ligne', offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ── Push Notifications ────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  const title = data.title || 'Rapido';
  const options = {
    body: data.body || 'Nouvelle notification',
    icon: './rapido-icon-192.png',
    badge: './rapido-icon-192.png',
    tag: data.tag || 'rapido-notification',
    data: data.url ? { url: data.url } : {},
    vibrate: [100, 50, 100],
    actions: data.actions || [],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url;
  if (url) {
    event.waitUntil(clients.openWindow(url));
  }
});

// ── Background Sync (driver position) ────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'driver-position-sync') {
    event.waitUntil(syncDriverPosition());
  }
});

async function syncDriverPosition() {
  // Flush any queued position updates when back online
  const stored = await getFromIDB('pendingPositions');
  if (!stored?.length) return;
  for (const pos of stored) {
    try {
      await fetch('https://rapido-production.up.railway.app/api/drivers/' + pos.driverId + '/position', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + pos.token },
        body: JSON.stringify({ lat: pos.lat, lng: pos.lng }),
      });
    } catch { /* Will retry on next sync */ }
  }
}

// Minimal IDB helper
function getFromIDB(key) {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open('rapido-sw', 1);
      req.onsuccess = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('store')) { resolve(null); return; }
        const tx = db.transaction('store', 'readonly');
        const r = tx.objectStore('store').get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
