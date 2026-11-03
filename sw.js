// Receives content shared to the app from other apps (Android) and hands it to the page.
const SHARE_CACHE = "share-target-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith((async () => {
      try {
        const form = await event.request.formData();
        const cache = await caches.open(SHARE_CACHE);
        for (const k of await cache.keys()) await cache.delete(k);
        const meta = { title: form.get("title") || "", text: form.get("text") || "", url: form.get("url") || "", files: [] };
        let i = 0;
        for (const f of form.getAll("photos")) {
          if (!f || !f.size) continue;
          const key = "shared-file-" + (i++);
          await cache.put(new Request(self.registration.scope + key),
            new Response(f, { headers: { "Content-Type": f.type || "image/jpeg" } }));
          meta.files.push({ key, type: f.type });
        }
        await cache.put(new Request(self.registration.scope + "shared-meta"),
          new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
      } catch (e) {}
      return Response.redirect(self.registration.scope + "?share-target=1", 303);
    })());
  }
});
