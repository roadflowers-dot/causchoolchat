// 데모용 백엔드: Firebase 없이 화면을 확인하기 위한 가짜 데이터 (브라우저 메모리에만 저장)
// 주소 끝에 ?demo 를 붙이면 언제든 데모 모드로 볼 수 있어요.
export function createDemoBackend() {
  const PAGE_SIZE = 10;
  const me = { uid: "me", name: "김학생", email: "student@example.com", photo: "" };
  const friend = { uid: "u2", name: "이친구", photo: "" };
  const t = (min) => new Date(Date.now() - min * 60000);
  const mk = (id, who, min, extra) => ({ id, uid: who.uid, name: who.name, photo: "", createdAt: t(min), ...extra });

  let user = null;
  let authCb = () => {};
  const rooms = [
    { id: "r1", name: "2학년 3반" },
    { id: "r2", name: "과학 동아리" },
    { id: "r3", name: "수행평가 조별과제" },
  ];
  const messages = {
    r1: [
      // 어제 대화 (이전 메시지 더 보기 확인용)
      ...Array.from({ length: 14 }, (_, i) => mk("old" + i, i % 2 ? me : friend, 1500 - i * 3, { type: "text", text: `어제 이야기 ${i + 1}` })),
      mk("m1", friend, 30, { type: "text", text: "내일 체육 수업 운동장에서 한대!", reactions: { me: "👍" } }),
      mk("m1b", friend, 29.5, { type: "text", text: "체육복 꼭 챙겨와 🏃" }),
      mk("m2", me, 28, { type: "text", text: "오 알려줘서 고마워", replyTo: { id: "m1", name: friend.name, text: "내일 체육 수업 운동장에서 한대!" } }),
      mk("m3", friend, 10, { type: "file", file: { id: "f1", name: "가정통신문_11월.pdf", size: 482133, contentType: "application/pdf" }, reactions: { me: "❤️", u3: "❤️", u4: "😂" } }),
      mk("m4", friend, 9, { type: "text", text: "준비물 목록은 https://example.com 에 있어" }),
    ],
    r2: [mk("m5", friend, 120, { type: "text", text: "이번 주 실험 준비물 정리해서 올릴게" })],
    r3: [],
  };
  const blobs = { f1: new Blob(["데모 파일입니다."], { type: "text/plain" }) };
  const roomSubs = new Set();
  const msgSubs = new Map(); // roomId -> Set(cb)

  const roomView = () => rooms.map((r) => {
    const last = messages[r.id]?.at(-1);
    return {
      ...r,
      lastMessageAt: last?.createdAt ?? null,
      lastMessage: last && { uid: last.uid, name: last.name, text: last.type === "file" ? "📎 " + last.file.name : last.text },
    };
  });
  const latest = (roomId) => (messages[roomId] || []).slice(-PAGE_SIZE).map((m) => ({ ...m, _ts: m.createdAt }));
  const emitRooms = () => roomSubs.forEach((cb) => cb(roomView()));
  const emitMsgs = (roomId) => { (msgSubs.get(roomId) || []).forEach((cb) => cb(roomId)); emitRooms(); };
  const push = (roomId, m, who = me) => {
    (messages[roomId] ||= []).push({ id: crypto.randomUUID(), uid: who.uid, name: who.name, photo: "", createdAt: new Date(), ...m });
    emitMsgs(roomId);
  };
  const sub = (roomId, cb) => {
    if (!msgSubs.has(roomId)) msgSubs.set(roomId, new Set());
    msgSubs.get(roomId).add(cb);
    return () => msgSubs.get(roomId).delete(cb);
  };
  // 데모: 친구가 가끔 다른 방에 메시지를 보냄 (알림·안 읽음 표시 확인용)
  window.demoFriendSays = (roomId = "r2", text = "다들 내일 봐!") => push(roomId, { type: "text", text }, friend);

  return {
    pageSize: PAGE_SIZE,
    onAuth(cb) { authCb = cb; cb(user); return () => {}; },
    async signIn() { user = me; authCb(user); },
    async signOut() { user = null; authCb(null); },

    listenRooms(cb) { roomSubs.add(cb); cb(roomView()); return () => roomSubs.delete(cb); },
    async createRoom(name) { rooms.push({ id: crypto.randomUUID(), name }); emitRooms(); },

    listenMessages(roomId, cb) {
      const off = sub(roomId, () => cb(latest(roomId)));
      cb(latest(roomId));
      return off;
    },
    async loadOlder(roomId, oldest) {
      const all = messages[roomId] || [];
      const idx = all.findIndex((m) => m.id === oldest.id);
      return all.slice(Math.max(0, idx - PAGE_SIZE), Math.max(0, idx)).map((m) => ({ ...m, _ts: m.createdAt }));
    },
    listenFiles(roomId, cb) {
      const send = () => cb((messages[roomId] || []).filter((m) => m.type === "file").reverse()
        .map((m) => ({ ...m.file, uploaderName: m.name })));
      const off = sub(roomId, send); send(); return off;
    },

    async sendText(roomId, text, replyTo) { push(roomId, { type: "text", text, ...(replyTo ? { replyTo } : {}) }); },
    async sendFile(roomId, file, onProgress, replyTo) {
      for (let p = 0; p <= 1; p += 0.25) { onProgress?.(p); await new Promise((r) => setTimeout(r, 120)); }
      const id = crypto.randomUUID();
      blobs[id] = file;
      push(roomId, { type: "file", file: { id, name: file.name, size: file.size, contentType: file.type }, ...(replyTo ? { replyTo } : {}) });
    },
    async deleteMessage(roomId, msg) {
      messages[roomId] = messages[roomId].filter((m) => m.id !== msg.id);
      emitMsgs(roomId);
    },
    async toggleReaction(roomId, msg, emoji) {
      const m = messages[roomId].find((x) => x.id === msg.id);
      m.reactions ||= {};
      if (m.reactions[me.uid] === emoji) delete m.reactions[me.uid]; else m.reactions[me.uid] = emoji;
      emitMsgs(roomId);
    },
    async getFileBlob(roomId, file) {
      if (!blobs[file.id]) throw new Error("삭제된 파일이에요.");
      return blobs[file.id];
    },
  };
}
