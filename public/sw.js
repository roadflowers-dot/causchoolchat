// 알림을 눌렀을 때 채팅 화면으로 이동시키는 역할 (안드로이드 크롬은 알림에 서비스 워커가 필요)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const roomId = event.notification.data?.roomId;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = all[0];
    if (client) {
      await client.focus();
      client.postMessage({ roomId });
    } else {
      await self.clients.openWindow("./");
    }
  })());
});
