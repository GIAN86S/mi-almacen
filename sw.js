// Guarda la app y los últimos datos vistos para que funcione sin internet.
// Con internet siempre pide lo más nuevo; sin internet usa lo guardado.
// Al publicar archivos nuevos, subir VERSION para que los aparatos los actualicen.
const VERSION = 'v5';
const CACHE_APP = 'app-' + VERSION;
const CACHE_DATOS = 'datos';

const ARCHIVOS = [
  './',
  'index.html',
  'css/estilos.css',
  'fuentes/nunito.woff2',
  'js/app.js',
  'js/cola.js',
  'js/config.js',
  'js/iconos.js',
  'js/catalogo.js',
  'js/vendor/supabase.js',
  'manifest.webmanifest',
  'icono.svg',
  'iconos/icono-192.png',
  'iconos/icono-512.png',
  'iconos/icono-maskable-512.png',
  'iconos/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_APP).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const nombre of await caches.keys()) {
      if (nombre.startsWith('app-') && nombre !== CACHE_APP) await caches.delete(nombre);
    }
    await self.clients.claim();
  })());
});

// Pide a internet; si no responde a tiempo o no hay señal, usa lo guardado
async function primeroInternet(pedido, cache, espera, alternativa) {
  const guardado = caches.open(cache);
  const deInternet = fetch(pedido).then(async r => {
    if (r.ok) (await guardado).put(pedido, r.clone());
    return r;
  });
  const tiempo = new Promise(ok => setTimeout(ok, espera));
  try {
    const r = await Promise.race([deInternet, tiempo]);
    if (r) return r;
  } catch { /* sin señal */ }
  const copia = await (await guardado).match(pedido, { ignoreVary: true })
    || (alternativa && await (await guardado).match(alternativa));
  if (copia) return copia;
  return deInternet; // no hay copia: esperar a internet (o fallar)
}

self.addEventListener('fetch', e => {
  const pedido = e.request;
  if (pedido.method !== 'GET') return;
  const url = new URL(pedido.url);

  if (url.origin === self.location.origin) {
    e.respondWith(primeroInternet(pedido, CACHE_APP, 4000, pedido.mode === 'navigate' ? 'index.html' : null));
  } else if (url.pathname.startsWith('/rest/v1/')) {
    e.respondWith(primeroInternet(pedido, CACHE_DATOS, 6000));
  }
});

// Al cerrar sesión se borran los datos guardados del aparato
self.addEventListener('message', e => {
  if (e.data === 'borrar-datos') e.waitUntil(caches.delete(CACHE_DATOS));
});
