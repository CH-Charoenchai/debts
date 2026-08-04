const CACHE = "debts-v1";

const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json"
];

self.addEventListener("install", e=>{
    e.waitUntil(
        caches.open(CACHE).then(c=>c.addAll(ASSETS))
    );
});

self.addEventListener("fetch",e=>{
    e.respondWith(
        caches.match(e.request).then(r=>r||fetch(e.request))
    );
});

self.addEventListener("push", e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || "แจ้งเตือนหนี้", {
      body: data.body || "",
      icon: "./icon-192.png"
    })
  );
});
