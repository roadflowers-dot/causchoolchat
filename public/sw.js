// 서비스 워커: ① 앱 설치(홈 화면에 추가) ② 인터넷이 잠깐 끊겨도 화면 열기 ③ 알림 클릭 처리
const CACHE = "causchoolchat-v6";
const SHELL = [
  "./", "index.html", "css/style.css", "manifest.json",
  "js/app.js", "js/firebase-config.js", "js/backend-firebase.js", "js/backend-demo.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/favicon-64.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// 항상 최신 파일을 먼저 받고(네트워크 우선), 인터넷이 안 될 때만 저장해 둔 파일 사용
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const firebaseSdk = url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  if (!(sameOrigin && !url.pathname.startsWith("/__/")) && !firebaseSdk) return; // 채팅 데이터·로그인은 건드리지 않음

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: req.mode === "navigate" });
      if (cached) return cached;
      if (req.mode === "navigate") return caches.match("index.html");
      throw err;
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const roomId = event.notification.data?.roomId;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = all[0];
    if (client) {
      await client.focus();
      client.postMessage({ roomId, admin: !!event.notification.data?.admin });
    } else {
      await self.clients.openWindow("./");
    }
  })());
});
