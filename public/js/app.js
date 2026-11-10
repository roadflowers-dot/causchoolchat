import { firebaseConfig, ALLOWED_EMAIL_DOMAIN, MAX_FILE_MB } from "./firebase-config.js";

// ---------- 백엔드 선택 (설정 전이면 데모 모드) ----------
const isConfigured = !firebaseConfig.apiKey.startsWith("YOUR_");
const backend = isConfigured
  ? (await import("./backend-firebase.js")).createFirebaseBackend(firebaseConfig, { allowedDomain: ALLOWED_EMAIL_DOMAIN })
  : (await import("./backend-demo.js")).createDemoBackend();

const $ = (id) => document.getElementById(id);
$("demo-banner").hidden = isConfigured;

// ---------- 상태 ----------
let me = null;
let currentRoom = null;
let offRooms = null, offMessages = null, offFiles = null;

// ---------- 로그인 / 로그아웃 ----------
backend.onAuth((user, error) => {
  me = user;
  $("login-view").hidden = !!user;
  $("chat-view").hidden = !user;
  $("login-error").hidden = !error;
  if (error) $("login-error").textContent = error;

  if (user) {
    $("me-name").textContent = user.name;
    $("me-email").textContent = user.email;
    $("me-photo").src = user.photo || avatarFallback(user.name);
    offRooms = backend.listenRooms(renderRooms);
  } else {
    offRooms?.(); offMessages?.(); offFiles?.();
    currentRoom = null;
  }
});

$("login-btn").onclick = () => backend.signIn().catch((e) => {
  $("login-error").hidden = false;
  $("login-error").textContent = "로그인 실패: " + e.message;
});
$("logout-btn").onclick = () => backend.signOut();

// ---------- 채팅방 목록 ----------
function renderRooms(rooms) {
  const list = $("room-list");
  list.innerHTML = "";
  for (const room of rooms) {
    const li = document.createElement("li");
    li.textContent = room.name;
    li.dataset.id = room.id;
    li.classList.toggle("active", room.id === currentRoom?.id);
    li.onclick = () => openRoom(room);
    list.append(li);
  }
  if (!currentRoom && rooms.length) openRoom(rooms[0]);
  else setComposerEnabled(!!currentRoom);
}

$("new-room-btn").onclick = async () => {
  const name = prompt("새 채팅방 이름")?.trim();
  if (name) await backend.createRoom(name.slice(0, 40));
};

function openRoom(room) {
  currentRoom = room;
  $("room-title").textContent = "# " + room.name;
  document.querySelectorAll("#room-list li").forEach((li) => li.classList.toggle("active", li.dataset.id === room.id));
  $("sidebar").classList.remove("open");
  setComposerEnabled(true);

  offMessages?.(); offFiles?.();
  offMessages = backend.listenMessages(room.id, renderMessages);
  offFiles = backend.listenFiles(room.id, renderFiles);
}

// ---------- 메시지 ----------
function renderMessages(msgs) {
  const box = $("messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = "";
  if (!msgs.length) {
    box.innerHTML = `<div class="empty">아직 메시지가 없어요.<br>첫 메시지를 보내보세요!</div>`;
    return;
  }
  for (const m of msgs) box.append(messageEl(m));
  if (nearBottom || msgs.at(-1)?.uid === me?.uid) box.scrollTop = box.scrollHeight;
}

function messageEl(m) {
  const mine = m.uid === me?.uid;
  const wrap = el("div", "msg" + (mine ? " mine" : ""));
  if (!mine) {
    const img = el("img", "avatar");
    img.src = m.photo || avatarFallback(m.name);
    wrap.append(img);
  }
  const body = el("div", "body");
  body.append(el("div", "meta", `${mine ? "" : m.name + " · "}${formatTime(m.createdAt)}`));
  body.append(m.type === "file" ? fileEl(m.file) : el("div", "bubble", m.text));
  wrap.append(body);
  return wrap;
}

// 파일은 Firestore에 조각으로 저장돼 있어서, 필요할 때 받아서 합친 뒤 Blob URL로 보여줌 (한 번 받은 건 캐시)
const blobUrlCache = new Map();
function fileUrl(file) {
  if (!blobUrlCache.has(file.id)) {
    const p = backend.getFileBlob(currentRoom.id, file).then((b) => URL.createObjectURL(b));
    p.catch(() => blobUrlCache.delete(file.id));
    blobUrlCache.set(file.id, p);
  }
  return blobUrlCache.get(file.id);
}

async function downloadFile(file) {
  try {
    const a = document.createElement("a");
    a.href = await fileUrl(file);
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
  } catch (err) {
    alert("파일을 받지 못했어요: " + err.message);
  }
}

function fileEl(file, asCard = false) {
  if (!asCard && file.contentType?.startsWith("image/")) {
    const img = el("img", "img-preview");
    img.alt = file.name;
    img.title = "클릭하면 저장";
    fileUrl(file).then((url) => (img.src = url)).catch(() => (img.alt = "이미지를 불러오지 못했어요"));
    img.onclick = () => downloadFile(file);
    return img;
  }
  const a = el("a", "file-card");
  a.href = "#";
  a.onclick = (e) => { e.preventDefault(); downloadFile(file); };
  a.append(el("span", "ico", fileIcon(file.contentType)));
  const info = el("div");
  info.append(el("div", "name", file.name), el("div", "size", formatSize(file.size)));
  a.append(info);
  return a;
}

$("composer").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("message-input");
  const text = input.value.trim();
  if (!text || !currentRoom) return;
  input.value = "";
  await backend.sendText(currentRoom.id, text);
};

// ---------- 파일 공유 ----------
$("file-input").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !currentRoom) return;
  if (file.size > MAX_FILE_MB * 1024 * 1024) return alert(`파일은 ${MAX_FILE_MB}MB 이하만 올릴 수 있어요.`);

  const bar = $("upload-progress");
  bar.hidden = false;
  try {
    await backend.sendFile(currentRoom.id, file, (p) => (bar.firstElementChild.style.width = p * 100 + "%"));
  } catch (err) {
    alert("업로드 실패: " + err.message);
  } finally {
    bar.hidden = true;
    bar.firstElementChild.style.width = "0";
  }
};

function renderFiles(files) {
  const list = $("file-list");
  list.innerHTML = "";
  if (!files.length) list.innerHTML = `<li class="empty">공유된 파일이 없어요.</li>`;
  for (const f of files) {
    const li = el("li");
    const card = fileEl(f, true); // 목록에선 이미지도 카드로 표시
    card.querySelector(".size").textContent += ` · ${f.uploaderName}`;
    li.append(card);
    list.append(li);
  }
}
$("files-btn").onclick = () => ($("files-panel").hidden = !$("files-panel").hidden);
$("files-close").onclick = () => ($("files-panel").hidden = true);
$("menu-btn").onclick = () => $("sidebar").classList.toggle("open");

// ---------- 유틸 ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text; // textContent 사용 → XSS 방지
  return e;
}
function setComposerEnabled(on) { $("composer").classList.toggle("disabled", !on); }
function formatTime(d) { return d ? new Date(d).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" }) : ""; }
function formatSize(b) { return b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB"; }
function fileIcon(type = "") {
  if (type.includes("pdf")) return "📕";
  if (type.startsWith("image/")) return "🖼️";
  if (type.startsWith("video/")) return "🎬";
  if (type.includes("sheet") || type.includes("excel")) return "📊";
  if (type.includes("presentation") || type.includes("powerpoint")) return "📽️";
  if (type.includes("zip")) return "🗜️";
  return "📄";
}
function avatarFallback(name = "?") {
  const ch = (name || "?")[0].replace(/[<>&"']/g, "?");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c9d4f5"/><text x="50%" y="54%" font-size="28" text-anchor="middle" dominant-baseline="middle" fill="#3b4a78" font-family="sans-serif">${ch}</text></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}
