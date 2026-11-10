// 실제 서비스용 백엔드: Firebase Auth(구글 로그인) + Firestore(실시간 메시지) + Storage(파일)
const V = "10.12.2";
const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
const {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
const {
  getFirestore, collection, doc, addDoc, setDoc, query, orderBy, limit, where,
  onSnapshot, serverTimestamp,
} = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
const {
  getStorage, ref, uploadBytesResumable, getDownloadURL,
} = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-storage.js`);

export function createFirebaseBackend(config, { allowedDomain }) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const storage = getStorage(app);

  const provider = new GoogleAuthProvider();
  if (allowedDomain) provider.setCustomParameters({ hd: allowedDomain }); // 구글 로그인 창에서 학교 계정 우선 표시

  const toUser = (u) => u && { uid: u.uid, name: u.displayName, email: u.email, photo: u.photoURL };

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
      const q = query(collection(db, "rooms", roomId, "messages"), orderBy("createdAt", "desc"), limit(200));
      return onSnapshot(q, (snap) => {
        cb(snap.docs.map((d) => {
          const m = d.data();
          return { id: d.id, ...m, createdAt: m.createdAt?.toDate() ?? new Date() };
        }).reverse());
      });
    },
    listenFiles(roomId, cb) {
      const q = query(collection(db, "rooms", roomId, "messages"), where("type", "==", "file"), orderBy("createdAt", "desc"));
      return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    },

    sendText(roomId, text) {
      const u = auth.currentUser;
      return addDoc(collection(db, "rooms", roomId, "messages"), {
        type: "text", text, uid: u.uid, name: u.displayName, photo: u.photoURL, createdAt: serverTimestamp(),
      });
    },
    sendFile(roomId, file, onProgress) {
      const u = auth.currentUser;
      const path = `rooms/${roomId}/${u.uid}/${Date.now()}_${file.name}`;
      const task = uploadBytesResumable(ref(storage, path), file, { contentType: file.type });
      return new Promise((resolve, reject) => {
        task.on("state_changed",
          (s) => onProgress?.(s.bytesTransferred / s.totalBytes),
          reject,
          async () => {
            const url = await getDownloadURL(task.snapshot.ref);
            await addDoc(collection(db, "rooms", roomId, "messages"), {
              type: "file", uid: u.uid, name: u.displayName, photo: u.photoURL, createdAt: serverTimestamp(),
              file: { name: file.name, size: file.size, contentType: file.type, url, path },
            });
            resolve();
          });
      });
    },
  };
}
