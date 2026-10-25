// 離線快取：同網站的檔案一律「先問網路（並向伺服器確認是否有新版）」，
// 連不上網路時才用快取，所以更新後重新整理就會拿到新版。
// AI 服務等外部網址不經過這裡。
const CACHE = "volcablearn-c7c85914";
const FILES = ["./", "index.html", "style.css", "config.js", "cefr.js", "data.js", "app.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(FILES.map(f => fetch(f, { cache: "no-cache" }).then(r => r.ok && c.put(f, r)).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req, { cache: "no-cache" })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(r => r || caches.match(req, { ignoreSearch: true })).then(r => r || caches.match("index.html"))
      )
  );
});
