/* ==========================================================================
   远程电脑控制 · Service Worker
   - app shell 缓存优先（同源静态资源）
   - /api/* 一律 network-only，不缓存
   - 版本化缓存，activate 时清理旧版本
   ========================================================================== */

const CACHE_VERSION = "v5";
const CACHE_NAME = `powercard-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/native-bridge.js",
  "/shared/native-api.js",
  "/shared/parser.js",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /* API 永远走网络，不缓存、不读取缓存 */
  if (url.pathname.startsWith("/api/")) return;

  /* 页面导航：网络优先，离线时回退 app shell */
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put("/index.html", copy))
            .catch(() => {});
          return response;
        })
        .catch(() =>
          caches
            .match("/index.html")
            .then((cached) => cached || caches.match("/"))
            .then(
              (cached) =>
                cached ||
                new Response("当前处于离线状态。", {
                  status: 503,
                  headers: { "Content-Type": "text/plain; charset=utf-8" },
                })
            )
        )
    );
    return;
  }

  /* 静态资源：缓存优先，未命中再请求网络并写入缓存 */
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === "basic") {
            const copy = response.clone();
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(request, copy))
              .catch(() => {});
          }
          return response;
        })
        .catch(
          () =>
            new Response("资源暂时不可用。", {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            })
        );
    })
  );
});
