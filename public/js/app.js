import { firebaseConfig, ALLOWED_EMAIL_DOMAIN, MAX_FILE_MB } from "./firebase-config.js";

const SITE_TITLE = "중대부초 실시간 채팅방";
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];
const ROOM_COLORS = ["#3b6cf6", "#f2994a", "#27ae60", "#eb5757", "#9b51e0", "#2d9cdb", "#e2b93b", "#f06292"];

// ---------- 백엔드 선택 (설정 전이거나 주소에 ?demo 가 있으면 데모 모드) ----------
const isDemo = firebaseConfig.apiKey.startsWith("YOUR_") || new URLSearchParams(location.search).has("demo");
let backend;
try {
  backend = isDemo
    ? (await import("./backend-demo.js")).createDemoBackend()
    : (await import("./backend-firebase.js")).createFirebaseBackend(firebaseConfig, { allowedDomain: ALLOWED_EMAIL_DOMAIN });
} catch (err) {
  // Firebase 라이브러리를 못 불러오면(네트워크 차단 등) 빈 화면 대신 안내 표시
  document.body.innerHTML = `<p style="margin:auto;padding:24px;text-align:center">
    서버에 연결하지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.</p>`;
  throw err;
}

const $ = (id) => document.getElementById(id);
$("demo-banner").hidden = !isDemo;

// ---------- 상태 ----------
let me = null;
let rooms = [];
let currentRoom = null;
let liveMsgs = [];      // 최근 메시지 (실시간)
let olderMsgs = [];     // "이전 메시지 더 보기"로 불러온 메시지
let hasMore = false;
let loadingOlder = false;
let replyTo = null;
let openActionsId = null, pickerId = null;
let offRooms = null, offMessages = null, offFiles = null;
let prevLastAt = null;  // 방별 마지막 메시지 시간 (새 메시지 알림 판단용)
let firstRenderOfRoom = false;

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
    prevLastAt = null;
    offRooms = backend.listenRooms(onRooms);
  } else {
    offRooms?.(); offMessages?.(); offFiles?.();
    currentRoom = null;
    document.title = SITE_TITLE;
  }
});

$("login-btn").onclick = () => backend.signIn().catch((e) => {
  if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
  $("login-error").hidden = false;
  $("login-error").textContent = e.code === "auth/popup-blocked"
    ? "팝업이 차단됐어요. 주소창 옆에서 팝업을 허용한 뒤 다시 눌러 주세요."
    : "로그인 실패: " + e.message;
});
$("logout-btn").onclick = () => confirm("로그아웃할까요?") && backend.signOut();

// ---------- 채팅방 목록 ----------
function onRooms(list) {
  rooms = list;
  notifyNewMessages(list);
  if (!currentRoom && rooms.length) {
    const saved = safeGet("lastRoom");
    openRoom(rooms.find((r) => r.id === saved) || rooms[0]);
  } else {
    if (currentRoom) currentRoom = rooms.find((r) => r.id === currentRoom.id) || currentRoom;
    renderRooms();
  }
  setComposerEnabled(!!currentRoom);
}

function renderRooms() {
  const list = $("room-list");
  list.innerHTML = "";
  if (!rooms.length) list.innerHTML = `<li class="empty" style="cursor:default">아직 채팅방이 없어요.<br>＋ 버튼으로 만들어 보세요!</li>`;
  for (const room of rooms) {
    const unread = isUnread(room);
    const li = el("li", (room.id === currentRoom?.id ? "active " : "") + (unread ? "unread" : ""));
    li.append(roomIcon(room));
    const text = el("div", "room-text");
    text.append(el("div", "room-name", room.name));
    const lm = room.lastMessage;
    text.append(el("div", "room-preview", lm ? `${lm.uid === me?.uid ? "나" : lm.name}: ${lm.text}` : "새 채팅방"));
    li.append(text);
    if (unread) li.append(el("span", "unread-dot"));
    li.onclick = () => openRoom(room);
    list.append(li);
  }
  const unreadCount = rooms.filter(isUnread).length;
  document.title = unreadCount ? `(${unreadCount}) ${SITE_TITLE}` : SITE_TITLE;
  $("menu-dot").hidden = !rooms.some((r) => r.id !== currentRoom?.id && isUnread(r));
}

function roomIcon(room) {
  const icon = el("span", "room-icon", Array.from(room.name.trim())[0] || "#");
  let h = 0;
  for (const ch of room.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  icon.style.background = ROOM_COLORS[h % ROOM_COLORS.length];
  return icon;
}

$("new-room-btn").onclick = async () => {
  const name = prompt("새 채팅방 이름을 입력하세요 (40자까지)")?.trim();
  if (!name) return;
  try { await backend.createRoom(name.slice(0, 40)); toast(`'${name.slice(0, 40)}' 방을 만들었어요`); }
  catch (e) { toast("방을 만들지 못했어요: " + e.message); }
};

function openRoom(room) {
  if (currentRoom?.id !== room.id) clearReply();
  currentRoom = room;
  safeSet("lastRoom", room.id);
  $("room-title").textContent = room.name;
  $("room-icon").replaceWith(Object.assign(roomIcon(room), { id: "room-icon" }));
  closeSidebar();
  setComposerEnabled(true);

  liveMsgs = []; olderMsgs = []; hasMore = false; openActionsId = pickerId = null;
  firstRenderOfRoom = true;
  $("messages").innerHTML = "";
  $("jump-btn").hidden = true;
  markRead(room);
  renderRooms();

  offMessages?.(); offFiles?.();
  offMessages = backend.listenMessages(room.id, (msgs) => {
    liveMsgs = msgs;
    if (!olderMsgs.length) hasMore = msgs.length >= backend.pageSize;
    renderMessages();
    if (!document.hidden) { markRead(currentRoom); renderRooms(); }
  });
  offFiles = backend.listenFiles(room.id, renderFiles);
  if (!matchMedia("(pointer: coarse)").matches) $("message-input").focus();
}

// ---------- 안 읽은 메시지 (이 기기 기준) ----------
const readKey = (roomId) => `lastRead:${me?.uid}:${roomId}`;
function markRead(room) {
  const at = Math.max(Date.now(), room?.lastMessageAt?.getTime() ?? 0);
  safeSet(readKey(room.id), String(at));
}
function isUnread(room) {
  if (!room.lastMessageAt || !room.lastMessage || room.lastMessage.uid === me?.uid) return false;
  if (room.id === currentRoom?.id && !document.hidden) return false;
  return room.lastMessageAt.getTime() > Number(safeGet(readKey(room.id)) || 0);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && currentRoom) { markRead(currentRoom); renderRooms(); }
});

// ---------- 메시지 표시 ----------
function allMessages() {
  const liveIds = new Set(liveMsgs.map((m) => m.id));
  return [...olderMsgs.filter((m) => !liveIds.has(m.id)), ...liveMsgs];
}

function renderMessages({ prepend = false } = {}) {
  const box = $("messages");
  const distFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
  const prevLastId = box.dataset.lastId;
  const msgs = allMessages();

  box.innerHTML = "";
  if (hasMore) {
    const btn = el("button", "load-more", loadingOlder ? "불러오는 중…" : "↑ 이전 메시지 더 보기");
    btn.disabled = loadingOlder;
    btn.onclick = loadOlder;
    box.append(btn);
  } else if (olderMsgs.length) {
    box.append(el("div", "history-end", "대화의 처음이에요"));
  }
  if (!msgs.length) {
    box.append(Object.assign(el("div", "empty"), { innerHTML: "아직 메시지가 없어요.<br>첫 메시지를 보내보세요! 👋" }));
    box.dataset.lastId = "";
    return;
  }

  let prev = null;
  for (const m of msgs) {
    const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
    if (newDay) box.append(el("div", "day-divider", formatDay(m.createdAt)));
    const grouped = !newDay && prev.uid === m.uid && !m.replyTo && m.createdAt - prev.createdAt < 5 * 60000;
    box.append(messageEl(m, grouped));
    prev = m;
  }

  const last = msgs.at(-1);
  box.dataset.lastId = last.id;
  if (prepend) {
    box.scrollTop = box.scrollHeight - box.clientHeight - distFromBottom; // 보던 위치 유지
  } else if (firstRenderOfRoom || distFromBottom < 120 || (last.id !== prevLastId && last.uid === me?.uid)) {
    box.scrollTop = box.scrollHeight;
    $("jump-btn").hidden = true;
  } else if (last.id !== prevLastId) {
    box.scrollTop = box.scrollHeight - box.clientHeight - distFromBottom;
    $("jump-btn").hidden = false; // 위쪽을 보고 있을 때 새 메시지가 오면 버튼 표시
  } else {
    box.scrollTop = box.scrollHeight - box.clientHeight - distFromBottom;
  }
  firstRenderOfRoom = false;
}

async function loadOlder() {
  const oldest = allMessages()[0];
  if (!oldest || loadingOlder) return;
  loadingOlder = true; renderMessages({ prepend: true });
  try {
    const older = await backend.loadOlder(currentRoom.id, oldest);
    olderMsgs = [...older, ...olderMsgs];
    hasMore = older.length >= backend.pageSize;
  } catch (e) {
    toast("이전 메시지를 불러오지 못했어요");
  } finally {
    loadingOlder = false;
    renderMessages({ prepend: true });
  }
}

$("messages").addEventListener("scroll", () => {
  const box = $("messages");
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) $("jump-btn").hidden = true;
});
$("jump-btn").onclick = () => { $("messages").scrollTo({ top: $("messages").scrollHeight, behavior: "smooth" }); };

function messageEl(m, grouped) {
  const mine = m.uid === me?.uid;
  const wrap = el("div", "msg" + (mine ? " mine" : "") + (grouped ? " grouped" : "") + (openActionsId === m.id ? " show-actions" : ""));
  wrap.dataset.id = m.id;

  if (!mine) {
    const img = el("img", "avatar");
    img.referrerPolicy = "no-referrer";
    img.src = m.photo || avatarFallback(m.name);
    img.onerror = () => { img.onerror = null; img.src = avatarFallback(m.name); };
    wrap.append(img);
  }

  const body = el("div", "body");
  if (!grouped) {
    const meta = el("div", "meta");
    if (!mine) meta.append(el("b", null, m.name));
    meta.append(formatTime(m.createdAt));
    body.append(meta);
  }
  if (m.replyTo) {
    const q = el("div", "quote");
    q.append(el("b", null, m.replyTo.name), " " + m.replyTo.text);
    q.onclick = () => jumpTo(m.replyTo.id);
    body.append(q);
  }
  if (m.type === "file") body.append(fileEl(m.file));
  else {
    const bubble = el("div", "bubble" + (isEmojiOnly(m.text) ? " emoji-only" : ""));
    linkify(bubble, m.text);
    bubble.onclick = (e) => { if (e.target.tagName !== "A") toggleActions(m.id); };
    body.append(bubble);
  }
  const reactions = reactionsEl(m);
  if (reactions) body.append(reactions);
  wrap.append(body);
  wrap.append(actionsEl(m, mine));

  // 모바일: 길게 누르면 메뉴 (PC: 마우스를 올리면 자동 표시)
  wrap.addEventListener("contextmenu", (e) => { e.preventDefault(); toggleActions(m.id, true); });
  return wrap;
}

function reactionsEl(m) {
  const entries = Object.entries(m.reactions || {});
  if (!entries.length) return null;
  const counts = new Map();
  for (const [, emoji] of entries) counts.set(emoji, (counts.get(emoji) || 0) + 1);
  const row = el("div", "reactions");
  for (const emoji of REACTIONS.filter((e) => counts.has(e))) {
    const chip = el("button", "reaction" + (m.reactions[me?.uid] === emoji ? " mine" : ""), `${emoji} ${counts.get(emoji)}`);
    chip.title = m.reactions[me?.uid] === emoji ? "반응 취소" : "나도 이 반응 남기기";
    chip.onclick = () => react(m, emoji);
    row.append(chip);
  }
  return row;
}

function actionsEl(m, mine) {
  const bar = el("div", "actions");
  if (pickerId === m.id) {
    for (const emoji of REACTIONS) {
      const b = el("button", null, emoji);
      b.title = emoji;
      b.onclick = () => react(m, emoji);
      bar.append(b);
    }
    const close = el("button", null, "✕");
    close.title = "닫기";
    close.onclick = () => { pickerId = null; renderMessages(); };
    bar.append(close);
    return bar;
  }
  const add = (icon, title, fn, cls) => { const b = el("button", cls, icon); b.title = title; b.onclick = fn; bar.append(b); };
  add("😊", "반응 남기기", () => { pickerId = m.id; openActionsId = m.id; renderMessages(); });
  add("↩", "답장", () => setReply(m));
  if (mine) add("🗑", "삭제", () => removeMessage(m), "del");
  return bar;
}

function toggleActions(id, forceOpen = false) {
  openActionsId = forceOpen || openActionsId !== id ? id : null;
  if (pickerId !== openActionsId) pickerId = null;
  renderMessages();
}
document.addEventListener("click", (e) => {
  if (openActionsId && !e.target.closest(".msg")) { openActionsId = pickerId = null; renderMessages(); }
});

async function react(m, emoji) {
  openActionsId = pickerId = null;
  try {
    await backend.toggleReaction(currentRoom.id, m, emoji);
    // 실시간 목록 밖(이전 메시지)은 직접 반영
    const old = olderMsgs.find((x) => x.id === m.id);
    if (old && !liveMsgs.some((x) => x.id === m.id)) {
      old.reactions = { ...(old.reactions || {}) };
      if (old.reactions[me.uid] === emoji) delete old.reactions[me.uid]; else old.reactions[me.uid] = emoji;
    }
  } catch (e) {
    toast("반응을 남기지 못했어요");
  }
  renderMessages();
}

async function removeMessage(m) {
  if (!confirm(m.type === "file" ? `'${m.file.name}' 파일을 삭제할까요?\n다른 사람도 더 이상 받을 수 없어요.` : "이 메시지를 삭제할까요?")) return;
  openActionsId = pickerId = null;
  try {
    await backend.deleteMessage(currentRoom.id, m);
    olderMsgs = olderMsgs.filter((x) => x.id !== m.id);
    if (replyTo?.id === m.id) clearReply();
    toast("삭제했어요");
  } catch (e) {
    toast("삭제하지 못했어요: " + e.message);
  }
  renderMessages();
}

function jumpTo(id) {
  const target = $("messages").querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (!target) return toast(hasMore ? "더 이전 메시지예요. 위에서 '이전 메시지 더 보기'를 눌러 주세요." : "삭제된 메시지예요");
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("flash"); void target.offsetWidth; target.classList.add("flash");
}

// ---------- 답장 ----------
function setReply(m) {
  replyTo = { id: m.id, name: m.name, text: m.type === "file" ? "📎 " + m.file.name : m.text.slice(0, 80) };
  $("reply-name").textContent = m.uid === me?.uid ? "나" : m.name;
  $("reply-text").textContent = replyTo.text;
  $("reply-bar").hidden = false;
  openActionsId = pickerId = null;
  renderMessages();
  $("message-input").focus();
}
function clearReply() { replyTo = null; $("reply-bar").hidden = true; }
$("reply-cancel").onclick = clearReply;

// ---------- 메시지 보내기 ----------
const input = $("message-input");
function autoGrow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
input.addEventListener("input", autoGrow);
input.addEventListener("keydown", (e) => {
  // PC에서는 Enter = 전송, Shift+Enter = 줄바꿈 (한글 입력 중에는 무시)
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(pointer: coarse)").matches) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
  if (e.key === "Escape") clearReply();
});

$("composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !currentRoom) return;
  const reply = replyTo;
  input.value = ""; autoGrow(); clearReply();
  try {
    await backend.sendText(currentRoom.id, text, reply);
  } catch (err) {
    input.value = text; autoGrow();
    toast("보내지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
};

// ---------- 파일 공유 ----------
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

async function openFile(file, download) {
  try {
    const a = document.createElement("a");
    a.href = await fileUrl(file);
    if (download) a.download = file.name; else { a.target = "_blank"; a.rel = "noopener"; }
    document.body.append(a);
    a.click();
    a.remove();
  } catch (err) {
    toast("파일을 받지 못했어요: " + err.message);
  }
}

function fileEl(file, asCard = false) {
  if (!asCard && file.contentType?.startsWith("image/")) {
    const img = el("img", "img-preview");
    img.alt = file.name;
    img.title = "크게 보기";
    fileUrl(file).then((url) => (img.src = url)).catch(() => (img.alt = "이미지를 불러오지 못했어요"));
    img.onclick = () => openFile(file, false);
    return img;
  }
  const a = el("a", "file-card");
  a.href = "#";
  a.title = "내려받기";
  a.onclick = (e) => { e.preventDefault(); openFile(file, true); };
  a.append(el("span", "ico", fileIcon(file.contentType)));
  const info = el("div");
  info.append(el("div", "name", file.name), el("div", "size", formatSize(file.size)));
  a.append(info);
  return a;
}

$("file-input").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !currentRoom) return;
  if (file.size > MAX_FILE_MB * 1024 * 1024) return toast(`파일은 ${MAX_FILE_MB}MB 이하만 올릴 수 있어요.`);

  const bar = $("upload-progress");
  const reply = replyTo;
  clearReply();
  bar.hidden = false;
  try {
    await backend.sendFile(currentRoom.id, file, (p) => (bar.firstElementChild.style.width = p * 100 + "%"), reply);
  } catch (err) {
    toast("업로드 실패: " + err.message);
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
$("files-btn").onclick = () => {
  $("files-panel").hidden = !$("files-panel").hidden;
  $("files-btn").classList.toggle("active", !$("files-panel").hidden);
};
$("files-close").onclick = () => { $("files-panel").hidden = true; $("files-btn").classList.remove("active"); };

// ---------- 모바일 메뉴 ----------
function closeSidebar() { $("sidebar").classList.remove("open"); $("backdrop").hidden = true; }
$("menu-btn").onclick = () => { $("sidebar").classList.add("open"); $("backdrop").hidden = false; };
$("backdrop").onclick = closeSidebar;

// ---------- 다크 모드 ----------
function effectiveTheme() {
  return document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function updateThemeButton() {
  const dark = effectiveTheme() === "dark";
  $("theme-btn").textContent = dark ? "☀️" : "🌙";
  $("theme-btn").title = dark ? "밝은 화면으로" : "어두운 화면으로";
  document.querySelector('meta[name="theme-color"]').content = dark ? "#1a1e27" : "#ffffff";
}
$("theme-btn").onclick = () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  safeSet("theme", next);
  updateThemeButton();
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateThemeButton);
updateThemeButton();

// ---------- 새 메시지 알림 ----------
// 사이트가 열려 있을 때(다른 탭을 보고 있어도) 알림을 띄워요. 사이트를 닫으면 오지 않아요.
const canNotify = "Notification" in window;
const notifyOn = () => canNotify && Notification.permission === "granted" && safeGet("notify") === "on";
function updateNotifyButton() {
  $("notify-btn").hidden = !canNotify;
  $("notify-btn").textContent = notifyOn() ? "🔔" : "🔕";
  $("notify-btn").title = notifyOn() ? "새 메시지 알림 끄기" : "새 메시지 알림 켜기";
}
$("notify-btn").onclick = async () => {
  if (notifyOn()) { safeSet("notify", "off"); toast("알림을 껐어요"); }
  else {
    const perm = await Notification.requestPermission();
    if (perm === "granted") { safeSet("notify", "on"); toast("알림을 켰어요. 이 사이트가 열려 있으면 새 메시지를 알려드려요."); }
    else toast("브라우저에서 알림이 차단돼 있어요. 주소창 왼쪽 자물쇠 아이콘에서 알림을 허용해 주세요.");
  }
  updateNotifyButton();
};
updateNotifyButton();

let swReg = null;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then((r) => (swReg = r)).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    const room = rooms.find((r) => r.id === e.data?.roomId);
    if (room) openRoom(room);
  });
}

function notifyNewMessages(list) {
  const first = prevLastAt === null;
  const prev = prevLastAt || new Map();
  prevLastAt = new Map(list.map((r) => [r.id, r.lastMessageAt?.getTime() ?? 0]));
  if (first) return;
  for (const room of list) {
    const at = room.lastMessageAt?.getTime() ?? 0;
    const lm = room.lastMessage;
    if (!lm || lm.uid === me?.uid || at <= (prev.get(room.id) ?? 0)) continue;
    const viewing = room.id === currentRoom?.id && !document.hidden;
    if (viewing) continue;
    if (!document.hidden) toast(`💬 ${room.name} · ${lm.name}: ${lm.text}`, () => openRoom(room));
    else if (notifyOn()) showNotification(room, `${lm.name}: ${lm.text}`);
  }
}

function showNotification(room, body) {
  const options = { body, tag: room.id, renotify: true, data: { roomId: room.id } };
  try {
    if (swReg) return swReg.showNotification(room.name, options);
    const n = new Notification(room.name, options);
    n.onclick = () => { window.focus(); openRoom(room); n.close(); };
  } catch {}
}

// ---------- 유틸 ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text; // textContent 사용 → XSS 방지
  return e;
}
function linkify(node, text) {
  const re = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    node.append(text.slice(last, match.index));
    const a = el("a", null, match[0]);
    a.href = match[0]; a.target = "_blank"; a.rel = "noopener noreferrer";
    node.append(a);
    last = match.index + match[0].length;
  }
  node.append(text.slice(last));
}
function isEmojiOnly(text) {
  const t = text.trim();
  return Array.from(t).length <= 6 && /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s)+$/u.test(t);
}
let toastTimer;
function toast(msg, onClick) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  t.style.cursor = onClick ? "pointer" : "default";
  t.onclick = () => { t.hidden = true; onClick?.(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function setComposerEnabled(on) { $("composer").classList.toggle("disabled", !on); }
function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
function formatDay(d) {
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (sameDay(d, today)) return "오늘";
  if (sameDay(d, yesterday)) return "어제";
  return d.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
}
function formatTime(d) { return d ? new Date(d).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" }) : ""; }
function formatSize(b) { return b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB"; }
function fileIcon(type = "") {
  if (type.includes("pdf")) return "📕";
  if (type.startsWith("image/")) return "🖼️";
  if (type.startsWith("video/")) return "🎬";
  if (type.startsWith("audio/")) return "🎵";
  if (type.includes("sheet") || type.includes("excel")) return "📊";
  if (type.includes("presentation") || type.includes("powerpoint")) return "📽️";
  if (type.includes("word") || type.includes("hwp") || type.includes("document")) return "📝";
  if (type.includes("zip")) return "🗜️";
  return "📄";
}
function avatarFallback(name = "?") {
  const ch = Array.from(name || "?")[0].replace(/[<>&"']/g, "?");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c9d4f5"/><text x="50%" y="54%" font-size="28" text-anchor="middle" dominant-baseline="middle" fill="#3b4a78" font-family="sans-serif">${ch}</text></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}
