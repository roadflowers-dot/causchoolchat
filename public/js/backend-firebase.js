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
  getFirestore, collection, doc, addDoc, setDoc, getDocs, query, orderBy, limit,
  onSnapshot, serverTimestamp, writeBatch, Bytes,
} = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);

// Firestore 문서 1개 최대 1MiB → 여유 있게 900KB씩 나눠 저장
const CHUNK_SIZE = 900 * 1024;
// 무료 한도(하루 읽기 5만 회)를 아끼기 위해 한 번에 불러오는 개수 제한
const MESSAGE_LIMIT = 50;
const FILE_LIST_LIMIT = 30;

export function createFirebaseBackend(config, { allowedDomain }) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);

  const provider = new GoogleAuthProvider();
  if (allowedDomain) provider.setCustomParameters({ hd: allowedDomain }); // 구글 로그인 창에서 학교 계정 우선 표시

  const toUser = (u) => u && { uid: u.uid, name: u.displayName, email: u.email, photo: u.photoURL };
  const toDate = (ts) => ts?.toDate() ?? new Date();

  return {
    onAuth(cb) {
      return onAuthStateChanged(auth, async (u) => {
        if (u && allowedDomain && !u.email.endsWith("@" + allowedDomain)) {
          await signOut(auth);
          cb(null, `@${allowedDomain} 계정만 사용할 수 있습니다.`);
          return;
        }
        if (u) {
          await setDoc(doc(db, "users", u.uid), {
            name: u.displayName, email: u.email, photo: u.photoURL, lastSeen: serverTimestamp(),
          }, { merge: true });
        }
        cb(toUser(u));
      });
    },
    signIn: () => signInWithPopup(auth, provider),
    signOut: () => signOut(auth),

    listenRooms(cb) {
      const q = query(collection(db, "rooms"), orderBy("createdAt"));
      return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    },
    createRoom(name) {
      const u = auth.currentUser;
      return addDoc(collection(db, "rooms"), { name, createdBy: u.uid, createdAt: serverTimestamp() });
    },

    listenMessages(roomId, cb) {
      const q = query(collection(db, "rooms", roomId, "messages"), orderBy("createdAt", "desc"), limit(MESSAGE_LIMIT));
      return onSnapshot(q, (snap) => {
        cb(snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: toDate(d.data().createdAt) })).reverse());
      });
    },
    listenFiles(roomId, cb) {
      const q = query(collection(db, "rooms", roomId, "files"), orderBy("createdAt", "desc"), limit(FILE_LIST_LIMIT));
      return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: toDate(d.data().createdAt) }))));
    },

    sendText(roomId, text) {
      const u = auth.currentUser;
      return addDoc(collection(db, "rooms", roomId, "messages"), {
        type: "text", text, uid: u.uid, name: u.displayName, photo: u.photoURL, createdAt: serverTimestamp(),
      });
    },

    // ① 파일 내용을 900KB 조각으로 나눠 하나씩 저장 (진행률 표시)
    // ② 마지막에 파일 정보 + 메시지를 한 번에 저장 → 이때 비로소 채팅방에 보임
    async sendFile(roomId, file, onProgress) {
      const u = auth.currentUser;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const chunkCount = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE));
      const fileRef = doc(collection(db, "rooms", roomId, "files"));

      for (let i = 0; i < chunkCount; i++) {
        await setDoc(doc(fileRef, "chunks", String(i)), {
          i, uid: u.uid, data: Bytes.fromUint8Array(bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)),
        });
        onProgress?.((i + 1) / (chunkCount + 1));
      }

      const meta = { name: file.name, size: file.size, contentType: file.type || "application/octet-stream" };
      const batch = writeBatch(db);
      batch.set(fileRef, { ...meta, chunkCount, uid: u.uid, uploaderName: u.displayName, createdAt: serverTimestamp() });
      batch.set(doc(collection(db, "rooms", roomId, "messages")), {
        type: "file", file: { id: fileRef.id, ...meta },
        uid: u.uid, name: u.displayName, photo: u.photoURL, createdAt: serverTimestamp(),
      });
      await batch.commit();
      onProgress?.(1);
    },

    // 조각들을 읽어 원래 파일(Blob)로 합치기
    async getFileBlob(roomId, file) {
      const snap = await getDocs(query(collection(db, "rooms", roomId, "files", file.id, "chunks"), orderBy("i")));
      return new Blob(snap.docs.map((d) => d.data().data.toUint8Array()), { type: file.contentType });
    },
  };
}
