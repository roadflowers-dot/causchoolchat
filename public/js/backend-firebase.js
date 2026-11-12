// 실제 서비스용 백엔드 — Firebase 무료(Spark) 요금제 안에서 동작하도록 구성
//   - 구글 로그인: Firebase Authentication
//   - 실시간 메시지: Cloud Firestore
//   - 파일: Cloud Storage는 무료 요금제에서 쓸 수 없어서, Firestore 문서에 나눠서(청크) 저장
const V = "10.12.2";
const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
const {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
const {
  getFirestore, collection, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, query, orderBy, limit, startAfter, where,
  onSnapshot, serverTimestamp, writeBatch, deleteField, Bytes,
} = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);

// Firestore 문서 1개 최대 1MiB → 여유 있게 900KB씩 나눠 저장
const CHUNK_SIZE = 900 * 1024;
// 무료 한도(하루 읽기 5만 회)를 아끼기 위해 한 번에 불러오는 개수 제한
export const PAGE_SIZE = 50;
const FILE_LIST_LIMIT = 30;

export function createFirebaseBackend(config, { allowedDomain }) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account", ...(allowedDomain ? { hd: allowedDomain } : {}) });

  let myName = null; // 닉네임을 정하면 그 이름으로 메시지를 보냄
  const nameOf = (u) => myName || u.displayName;
  const toUser = (u) => u && { uid: u.uid, name: u.displayName, email: u.email, photo: u.photoURL };
  // 아직 서버에 저장 중인 메시지도 시간이 보이도록 'estimate' 사용
  const toMsg = (d) => {
    const m = d.data({ serverTimestamps: "estimate" });
    return { id: d.id, ...m, _ts: m.createdAt, createdAt: m.createdAt?.toDate() ?? new Date() };
  };
  // 1:1 채팅방(dm_로 시작)은 'dms', 단체방은 'rooms'에 저장
  const top = (roomId) => (roomId.startsWith("dm_") ? "dms" : "rooms");
  const messagesCol = (roomId) => collection(db, top(roomId), roomId, "messages");
  const preview = (text) => (text.length > 60 ? text.slice(0, 60) + "…" : text);

  // 메시지 저장 + 채팅방 '마지막 메시지' 갱신(목록 미리보기·안 읽음 표시용)을 한 번에
  function addMessage(batch, roomId, data, previewText) {
    const u = auth.currentUser;
    batch.set(doc(messagesCol(roomId)), {
      ...data, uid: u.uid, name: nameOf(u), photo: u.photoURL, createdAt: serverTimestamp(),
    });
    batch.update(doc(db, top(roomId), roomId), {
      lastMessageAt: serverTimestamp(),
      lastMessage: { uid: u.uid, name: nameOf(u), text: preview(previewText) },
    });
  }

  return {
    pageSize: PAGE_SIZE,

    onAuth(cb) {
      return onAuthStateChanged(auth, async (u) => {
        if (u && allowedDomain && !u.email.endsWith("@" + allowedDomain)) {
          await signOut(auth);
          cb(null, `@${allowedDomain} 계정만 사용할 수 있습니다.`);
          return;
        }
        if (!u) return cb(null);
        const user = toUser(u);
        // 관리자 확인: 관리자만 읽을 수 있는 문서를 읽어 봄 (관리자 이메일은 보안 규칙에만 있음)
        user.isAdmin = await getDoc(doc(db, "admin", "check")).then(() => true, () => false);
        cb(user);
        setDoc(doc(db, "users", u.uid), {
          name: u.displayName, email: u.email, photo: u.photoURL, admin: user.isAdmin, lastSeen: serverTimestamp(),
        }, { merge: true }).catch(console.warn); // 차단된 사용자는 실패 (정상)
      });
    },
    signIn: () => signInWithPopup(auth, provider),
    signOut: () => signOut(auth),

    listenRooms(cb) {
      const q = query(collection(db, "rooms"), orderBy("createdAt"));
      return onSnapshot(q, (snap) => cb(snap.docs.map((d) => {
        const r = d.data({ serverTimestamps: "estimate" });
        return { id: d.id, ...r, kind: "group", lastMessageAt: r.lastMessageAt?.toDate() ?? null };
      })), console.warn);
    },
    createRoom(name) {
      const u = auth.currentUser;
      return setDoc(doc(collection(db, "rooms")), { name, createdBy: u.uid, createdAt: serverTimestamp() });
    },

    // 최근 메시지 PAGE_SIZE개를 실시간으로
    listenMessages(roomId, cb) {
      const q = query(messagesCol(roomId), orderBy("createdAt", "desc"), limit(PAGE_SIZE));
      return onSnapshot(q, (snap) => cb(snap.docs.map(toMsg).reverse()), console.warn);
    },
    // 그보다 오래된 메시지 PAGE_SIZE개를 한 번만 불러오기 ("이전 메시지 더 보기")
    async loadOlder(roomId, oldest) {
      const q = query(messagesCol(roomId), orderBy("createdAt", "desc"), startAfter(oldest._ts), limit(PAGE_SIZE));
      const snap = await getDocs(q);
      return snap.docs.map(toMsg).reverse();
    },
    listenFiles(roomId, cb) {
      const q = query(collection(db, top(roomId), roomId, "files"), orderBy("createdAt", "desc"), limit(FILE_LIST_LIMIT));
      return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), console.warn);
    },

    async sendText(roomId, text, replyTo) {
      const batch = writeBatch(db);
      addMessage(batch, roomId, { type: "text", text, ...(replyTo ? { replyTo } : {}) }, text);
      await batch.commit();
    },

    // ① 파일 내용을 900KB 조각으로 나눠 하나씩 저장 (진행률 표시)
    // ② 마지막에 파일 정보 + 메시지를 한 번에 저장 → 이때 비로소 채팅방에 보임
    async sendFile(roomId, file, onProgress, replyTo) {
      const u = auth.currentUser;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const chunkCount = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE));
      const fileRef = doc(collection(db, top(roomId), roomId, "files"));

      for (let i = 0; i < chunkCount; i++) {
        await setDoc(doc(fileRef, "chunks", String(i)), {
          i, uid: u.uid, data: Bytes.fromUint8Array(bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)),
        });
        onProgress?.((i + 1) / (chunkCount + 1));
      }

      const meta = { name: file.name, size: file.size, contentType: file.type || "application/octet-stream" };
      const batch = writeBatch(db);
      batch.set(fileRef, { ...meta, chunkCount, uid: u.uid, uploaderName: nameOf(u), createdAt: serverTimestamp() });
      addMessage(batch, roomId, { type: "file", file: { id: fileRef.id, ...meta }, ...(replyTo ? { replyTo } : {}) }, "📎 " + file.name);
      await batch.commit();
      onProgress?.(1);
    },

    // 내 메시지 삭제 (파일이면 파일 조각까지 함께 지워서 저장 공간 확보)
    async deleteMessage(roomId, msg) {
      const batch = writeBatch(db);
      batch.delete(doc(messagesCol(roomId), msg.id));
      if (msg.type === "file" && msg.file?.id) {
        const fileRef = doc(db, top(roomId), roomId, "files", msg.file.id);
        const fileSnap = await getDoc(fileRef);
        if (fileSnap.exists()) {
          for (let i = 0; i < fileSnap.data().chunkCount; i++) batch.delete(doc(fileRef, "chunks", String(i)));
          batch.delete(fileRef);
        }
      }
      await batch.commit();
    },

    // 반응: 한 사람당 하나. 같은 이모지를 다시 누르면 취소
    toggleReaction(roomId, msg, emoji) {
      const uid = auth.currentUser.uid;
      const current = msg.reactions?.[uid];
      return updateDoc(doc(messagesCol(roomId), msg.id), {
        [`reactions.${uid}`]: current === emoji ? deleteField() : emoji,
      });
    },

    // ----- 1:1 채팅 -----
    listenDms(cb) {
      const q = query(collection(db, "dms"), where("members", "array-contains", auth.currentUser.uid));
      return onSnapshot(q, (snap) => cb(snap.docs.map((d) => {
        const r = d.data({ serverTimestamps: "estimate" });
        return { id: d.id, ...r, kind: "dm", lastMessageAt: r.lastMessageAt?.toDate() ?? null };
      })), console.warn);
    },
    // 상대와의 1:1 채팅방을 열기 (없으면 새로 만듦). 방 이름은 두 사람 uid로 정해져서 중복되지 않음
    async openDm(otherUid) {
      const members = [auth.currentUser.uid, otherUid].sort();
      const id = `dm_${members[0]}_${members[1]}`;
      const ref = doc(db, "dms", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) await setDoc(ref, { members, createdAt: serverTimestamp() });
      return { id, kind: "dm", members };
    },

    // ----- 초대 -----
    // 내가 초대 목록에 있는지 실시간 확인
    listenMyInvite(cb) {
      const email = (auth.currentUser.email || "").toLowerCase();
      return onSnapshot(doc(db, "invites", email), (d) => cb(d.exists()), () => cb(false));
    },
    listenInvites(cb) {
      return onSnapshot(collection(db, "invites"), (snap) => {
        cb(new Map(snap.docs.map((d) => [d.id, { ...d.data(), at: d.data().at?.toDate?.() ?? null }])));
      }, console.warn);
    },
    async invite(emails) {
      for (let i = 0; i < emails.length; i += 400) {
        const batch = writeBatch(db);
        for (const e of emails.slice(i, i + 400)) batch.set(doc(db, "invites", e.toLowerCase()), { by: auth.currentUser.uid, at: serverTimestamp() });
        await batch.commit();
      }
    },
    uninvite(email) { return deleteDoc(doc(db, "invites", email.toLowerCase())); },

    // ----- 프로필 -----
    listenUsers(cb) {
      return onSnapshot(collection(db, "users"), (snap) => {
        cb(Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])));
      }, console.warn);
    },
    // 내가 차단됐는지 실시간 확인
    listenMyBan(cb) {
      return onSnapshot(doc(db, "banned", auth.currentUser.uid), (d) => cb(d.exists()), () => cb(false));
    },
    setMyName(name) { myName = name || null; },
    updateProfile({ nickname, avatar }) {
      return setDoc(doc(db, "users", auth.currentUser.uid), { nickname, avatar }, { merge: true });
    },

    // ----- 관리자 -----
    listenBanned(cb) {
      return onSnapshot(collection(db, "banned"), (snap) => cb(new Set(snap.docs.map((d) => d.id))), console.warn);
    },
    ban(uid) { return setDoc(doc(db, "banned", uid), { by: auth.currentUser.uid, at: serverTimestamp() }); },
    unban(uid) { return deleteDoc(doc(db, "banned", uid)); },
    renameRoom(roomId, name) { return updateDoc(doc(db, "rooms", roomId), { name }); },
    setNotice(roomId, text) {
      return updateDoc(doc(db, "rooms", roomId), { notice: text ? { text, at: serverTimestamp() } : deleteField() });
    },
    // 방 삭제: 메시지·파일·파일 조각을 모두 지운 뒤 방을 지움 (Firestore는 하위 데이터를 자동으로 지우지 않음)
    async deleteRoom(roomId) {
      const refs = [];
      const msgs = await getDocs(messagesCol(roomId));
      msgs.forEach((d) => refs.push(d.ref));
      const files = await getDocs(collection(db, "rooms", roomId, "files"));
      for (const f of files.docs) {
        const chunks = await getDocs(collection(f.ref, "chunks"));
        chunks.forEach((c) => refs.push(c.ref));
        refs.push(f.ref);
      }
      for (let i = 0; i < refs.length; i += 400) {
        const batch = writeBatch(db);
        refs.slice(i, i + 400).forEach((r) => batch.delete(r));
        await batch.commit();
      }
      await deleteDoc(doc(db, "rooms", roomId));
    },

    // 조각들을 읽어 원래 파일(Blob)로 합치기
    async getFileBlob(roomId, file) {
      const snap = await getDocs(query(collection(db, top(roomId), roomId, "files", file.id, "chunks"), orderBy("i")));
      if (snap.empty) throw new Error("삭제된 파일이에요.");
      return new Blob(snap.docs.map((d) => d.data().data.toUint8Array()), { type: file.contentType });
    },
  };
}
