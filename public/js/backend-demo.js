// 데모용 백엔드: Firebase 없이 화면 구성을 확인하기 위한 가짜 데이터 (브라우저 메모리에만 저장)
export function createDemoBackend() {
  const me = { uid: "me", name: "김학생", email: "student@school.hs.kr", photo: "" };
  const friend = { uid: "u2", name: "이친구", photo: "" };
  const t = (min) => new Date(Date.now() - min * 60000);

  let user = null;
  let authCb = () => {};
  const rooms = [
    { id: "r1", name: "2학년 3반" },
    { id: "r2", name: "과학 동아리" },
    { id: "r3", name: "수행평가 조별과제" },
  ];
  const messages = {
    r1: [
      { id: "m1", type: "text", uid: friend.uid, name: friend.name, text: "내일 체육 수업 운동장에서 한대!", createdAt: t(30) },
      { id: "m2", type: "text", uid: me.uid, name: me.name, text: "오 알려줘서 고마워 👍", createdAt: t(28) },
      { id: "m3", type: "file", uid: friend.uid, name: friend.name, createdAt: t(10),
        file: { name: "가정통신문_11월.pdf", size: 482133, contentType: "application/pdf", url: "#" } },
    ],
    r2: [{ id: "m4", type: "text", uid: friend.uid, name: friend.name, text: "이번 주 실험 준비물 정리해서 올릴게", createdAt: t(120) }],
    r3: [],
  };
  const roomSubs = new Set();
  const msgSubs = new Map(); // roomId -> Set(cb)

  const emitRooms = () => roomSubs.forEach((cb) => cb([...rooms]));
  const emitMsgs = (roomId) => (msgSubs.get(roomId) || []).forEach((cb) => cb([...(messages[roomId] || [])]));
  const push = (roomId, m) => {
    (messages[roomId] ||= []).push({ id: crypto.randomUUID(), uid: me.uid, name: me.name, photo: "", createdAt: new Date(), ...m });
    emitMsgs(roomId);
  };
  const sub = (roomId, cb) => {
    if (!msgSubs.has(roomId)) msgSubs.set(roomId, new Set());
    msgSubs.get(roomId).add(cb);
    return () => msgSubs.get(roomId).delete(cb);
  };

  return {
    isDemo: true,
    onAuth(cb) { authCb = cb; cb(user); return () => {}; },
    async signIn() { user = me; authCb(user); },
    async signOut() { user = null; authCb(null); },

    listenRooms(cb) { roomSubs.add(cb); cb([...rooms]); return () => roomSubs.delete(cb); },
    async createRoom(name) { rooms.push({ id: crypto.randomUUID(), name }); emitRooms(); },

    listenMessages(roomId, cb) { const off = sub(roomId, cb); cb([...(messages[roomId] || [])]); return off; },
    listenFiles(roomId, cb) {
      const wrap = (list) => cb(list.filter((m) => m.type === "file").reverse());
      const off = sub(roomId, wrap); wrap(messages[roomId] || []); return off;
    },

    async sendText(roomId, text) { push(roomId, { type: "text", text }); },
    async sendFile(roomId, file, onProgress) {
      for (let p = 0; p <= 1; p += 0.25) { onProgress?.(p); await new Promise((r) => setTimeout(r, 120)); }
      push(roomId, { type: "file", file: { name: file.name, size: file.size, contentType: file.type, url: URL.createObjectURL(file) } });
    },
  };
}
