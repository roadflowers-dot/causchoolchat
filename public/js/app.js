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
let prevLastAt = {};    // 종류(group/dm)별 → 방별 마지막 메시지 시간 (새 메시지 알림 판단용)
let groupRooms = [], dmRooms = [];  // 단체방 / 1:1 채팅방
let invitesMap = new Map();          // (관리자) 초대된 이메일 목록
let offDms = null, offMyInvite = null, offInvites = null;
let access = { invited: null, banned: null };
let firstRenderOfRoom = false;
let users = {};         // uid -> { nickname, avatar, photo, name, email, admin }
let bannedSet = new Set();
let offUsers = null, offMyBan = null, offBanned = null;
const isAdmin = () => !!me?.isAdmin;

// ---------- 로그인 / 로그아웃 ----------
backend.onAuth((user, error) => {
  me = user;
  $("login-view").hidden = !!user;
  $("chat-view").hidden = !user;
  $("login-error").hidden = !error;
  if (error) $("login-error").textContent = error;

  $("banned-view").hidden = true;
  $("uninvited-view").hidden = true;
  if (user) {
    renderMe();
    prevLastAt = {};
    $("admin-btn").hidden = !isAdmin();
    $("chat-view").hidden = true; // 초대·차단 여부를 확인한 뒤에 보여줌
    // 초대받았는지 + 차단됐는지 확인한 뒤 채팅 데이터를 불러옴 (관리자가 바꾸면 바로 화면이 바뀜)
    access = { invited: isAdmin() ? true : null, banned: isAdmin() ? false : null };
    if (isAdmin()) applyAccess();
    else {
      offMyInvite = backend.listenMyInvite((invited) => { access.invited = invited; applyAccess(); });
      offMyBan = backend.listenMyBan((isBanned) => { access.banned = isBanned; applyAccess(); });
    }
  } else {
    stopListening(); offMyBan?.(); offMyInvite?.(); offMyBan = offMyInvite = null;
    currentRoom = null;
    users = {};
    document.title = SITE_TITLE;
  }
});

function applyAccess() {
  if (access.invited === null || access.banned === null) return; // 아직 확인 중
  const uninvited = !access.invited;
  const banned = access.invited && access.banned;
  $("uninvited-view").hidden = !uninvited;
  $("banned-view").hidden = !banned;
  $("chat-view").hidden = uninvited || banned;
  if (uninvited) $("uninvited-email").textContent = me.email;
  if (uninvited || banned) stopListening();
  else if (!offRooms) startListening();
}

function startListening() {
  offUsers = backend.listenUsers((u) => {
    users = u;
    backend.setMyName(users[me.uid]?.nickname);
    renderMe();
    renderRooms();
    if (currentRoom) { renderRoomHeader(); renderMessages(); }
    if ($("admin-dialog").open) { renderUserList(); renderInviteList(); }
  });
  offRooms = backend.listenRooms((list) => onRooms("group", list));
  offDms = backend.listenDms((list) => onRooms("dm", list));
  if (isAdmin()) offInvites = backend.listenInvites((map) => { invitesMap = map; if ($("admin-dialog").open) { renderInviteList(); renderUserList(); } });
  if (isAdmin()) offBanned = backend.listenBanned((set) => { bannedSet = set; if ($("admin-dialog").open) renderUserList(); });
}
function stopListening() {
  for (const off of [offRooms, offDms, offMessages, offFiles, offUsers, offBanned, offInvites]) off?.();
  offRooms = offDms = offMessages = offFiles = offUsers = offBanned = offInvites = null;
  groupRooms = []; dmRooms = []; rooms = [];
  currentRoom = null;
}
$("banned-logout").onclick = () => backend.signOut();
$("uninvited-logout").onclick = () => backend.signOut();

$("login-btn").onclick = () => backend.signIn().catch((e) => {
  if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
  $("login-error").hidden = false;
  $("login-error").textContent = e.code === "auth/popup-blocked"
    ? "팝업이 차단됐어요. 주소창 옆에서 팝업을 허용한 뒤 다시 눌러 주세요."
    : "로그인 실패: " + e.message;
});
$("logout-btn").onclick = () => confirm("로그아웃할까요?") && backend.signOut();

// ---------- 채팅방 목록 ----------
function onRooms(kind, list) {
  if (kind === "dm") dmRooms = list.sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0));
  else groupRooms = list;
  rooms = [...groupRooms, ...dmRooms];
  notifyNewMessages(kind, list);
  if (!currentRoom && rooms.length) {
    const saved = safeGet("lastRoom");
    openRoom(rooms.find((r) => r.id === saved) || rooms[0]);
  } else {
    if (currentRoom) {
      const updated = rooms.find((r) => r.id === currentRoom.id);
      if (!updated && currentRoom.kind === "dm") {
        // 방금 만든 1:1 채팅이 아직 목록에 안 들어온 경우 → 그대로 둠
      } else if (!updated) { // 관리자가 방을 삭제함
        currentRoom = null;
        offMessages?.(); offFiles?.();
        if (rooms.length) return openRoom(rooms[0]);
        $("room-title").textContent = "채팅방을 선택하세요";
        $("messages").innerHTML = "";
        $("notice").hidden = true;
      } else {
        currentRoom = updated;
        renderRoomHeader();
      }
    }
    renderRooms();
  }
  setComposerEnabled(!!currentRoom);
}

function renderRooms() {
  const list = $("room-list");
  list.innerHTML = "";
  const section = (title, btnText, btnTitle, onBtn) => {
    const li = el("li", "section-title");
    li.append(el("span", null, title));
    if (btnText) { const b = el("button", "section-btn", btnText); b.title = btnTitle; b.onclick = onBtn; li.append(b); }
    list.append(li);
  };
  const roomItem = (room) => {
    const unread = isUnread(room);
    const li = el("li", "room-item " + (room.id === currentRoom?.id ? "active " : "") + (unread ? "unread" : ""));
    li.append(roomIcon(room));
    const text = el("div", "room-text");
    text.append(el("div", "room-name", roomName(room)));
    const lm = room.lastMessage;
    text.append(el("div", "room-preview", lm ? `${lm.uid === me?.uid ? "나" : displayName(lm.uid, lm.name)}: ${lm.text}` : room.kind === "dm" ? "1:1 채팅" : "새 채팅방"));
    li.append(text);
    if (unread) li.append(el("span", "unread-dot"));
    li.onclick = () => openRoom(room);
    list.append(li);
  };
  section("채팅방");
  if (!groupRooms.length) list.append(Object.assign(el("li", "empty"), { innerHTML: "아직 채팅방이 없어요.<br>＋ 버튼으로 만들어 보세요!" }));
  groupRooms.forEach(roomItem);
  section("1:1 채팅", "＋", "새 1:1 채팅", openDmPicker);
  if (!dmRooms.length) list.append(Object.assign(el("li", "empty small"), { innerHTML: "친구 프로필 사진을 누르거나<br>＋ 버튼으로 1:1 채팅을 시작해요" }));
  dmRooms.forEach(roomItem);
  const unreadCount = rooms.filter(isUnread).length;
  document.title = unreadCount ? `(${unreadCount}) ${SITE_TITLE}` : SITE_TITLE;
  $("menu-dot").hidden = !rooms.some((r) => r.id !== currentRoom?.id && isUnread(r));
}

// 1:1 채팅의 상대방 / 방 이름
function dmOther(room) { return room.members?.find((u) => u !== me?.uid) ?? me?.uid; }
function roomName(room) { return room.kind === "dm" ? displayName(dmOther(room)) : room.name; }

function roomIcon(room) {
  if (room.kind === "dm") {
    const a = avatarEl(dmOther(room));
    a.classList.add("room-icon", "dm-icon");
    return a;
  }
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
  renderRoomHeader();
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

function renderRoomHeader() {
  const room = currentRoom;
  if (!room) return;
  $("room-title").textContent = roomName(room);
  $("room-icon").replaceWith(Object.assign(roomIcon(room), { id: "room-icon" }));
  $("room-menu-btn").hidden = !isAdmin() || room.kind === "dm";
  renderNotice();
}

// ---------- 1:1 채팅 시작 ----------
async function startDm(uid) {
  if (!uid || uid === me?.uid) return;
  try {
    const dm = await backend.openDm(uid);
    $("dm-dialog").close();
    openRoom(rooms.find((r) => r.id === dm.id) || dm);
  } catch (e) {
    toast("1:1 채팅을 열지 못했어요: " + e.message);
  }
}
function openDmPicker() {
  $("dm-search").value = "";
  renderDmPicker();
  $("dm-dialog").showModal();
}
function renderDmPicker() {
  const q = $("dm-search").value.trim().toLowerCase();
  const ul = $("dm-user-list");
  ul.replaceChildren();
  const list = Object.entries(users)
    .filter(([uid]) => uid !== me.uid)
    .map(([uid, u]) => ({ uid, ...u, display: displayName(uid, u.name) }))
    .filter((u) => !q || u.display.toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q))
    .sort((a, b) => a.display.localeCompare(b.display, "ko"));
  if (!list.length) ul.append(el("li", "empty", q ? "찾는 친구가 없어요" : "아직 다른 친구가 없어요"));
  for (const u of list) {
    const li = el("li", "pick");
    li.append(avatarEl(u.uid, u.name, u.photo));
    const info = el("div", "user-info");
    const nameLine = el("div", "user-name", u.display);
    if (u.admin) nameLine.append(el("span", "admin-badge", "관리자"));
    info.append(nameLine);
    li.append(info, el("span", "pick-go", "💬"));
    li.onclick = () => startDm(u.uid);
    ul.append(li);
  }
}
$("dm-search").oninput = renderDmPicker;

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
    const av = avatarEl(m.uid, m.name, m.photo);
    if (currentRoom?.kind !== "dm") { // 단체방에서 친구 사진을 누르면 1:1 채팅
      av.classList.add("clickable");
      av.title = `${displayName(m.uid, m.name)}님과 1:1 채팅`;
      av.onclick = () => startDm(m.uid);
    }
    wrap.append(av);
  }

  const body = el("div", "body");
  if (!grouped) {
    const meta = el("div", "meta");
    if (!mine) {
      meta.append(el("b", null, displayName(m.uid, m.name)));
      if (users[m.uid]?.admin) meta.append(el("span", "admin-badge", "관리자"));
    }
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
  if (mine || isAdmin()) add("🗑", mine ? "삭제" : "삭제 (관리자)", () => removeMessage(m), "del");
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
  if (!confirm((m.uid !== me?.uid ? "[관리자] " : "") + (m.type === "file" ? `'${m.file.name}' 파일을 삭제할까요?\n다른 사람도 더 이상 받을 수 없어요.` : "이 메시지를 삭제할까요?"))) return;
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
  replyTo = { id: m.id, name: displayName(m.uid, m.name), text: m.type === "file" ? "📎 " + m.file.name : m.text.slice(0, 80) };
  $("reply-name").textContent = m.uid === me?.uid ? "나" : displayName(m.uid, m.name);
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
    card.querySelector(".size").textContent += ` · ${displayName(f.uid, f.uploaderName)}`;
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

function notifyNewMessages(kind, list) {
  const first = !prevLastAt[kind];
  const prev = prevLastAt[kind] || new Map();
  prevLastAt[kind] = new Map(list.map((r) => [r.id, r.lastMessageAt?.getTime() ?? 0]));
  if (first) return;
  for (const room of list) {
    const at = room.lastMessageAt?.getTime() ?? 0;
    const lm = room.lastMessage;
    if (!lm || lm.uid === me?.uid || at <= (prev.get(room.id) ?? 0)) continue;
    const viewing = room.id === currentRoom?.id && !document.hidden;
    if (viewing) continue;
    const who = displayName(lm.uid, lm.name);
    if (!document.hidden) toast(room.kind === "dm" ? `💌 ${who}: ${lm.text}` : `💬 ${room.name} · ${who}: ${lm.text}`, () => openRoom(room));
    else if (notifyOn()) showNotification(room, `${who}: ${lm.text}`);
  }
}

function showNotification(room, body) {
  const options = { body, tag: room.id, renotify: true, data: { roomId: room.id } };
  try {
    const title = room.kind === "dm" ? `💌 ${roomName(room)}` : room.name;
    if (swReg) return swReg.showNotification(title, options);
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); openRoom(room); n.close(); };
  } catch {}
}

// ---------- 이름·프로필 사진 ----------
function displayName(uid, fallback) { return users[uid]?.nickname || users[uid]?.name || fallback || "이름 없음"; }

const EMOJI_BG = ["#ffe3e3", "#fff0d6", "#fff9db", "#e6fcf5", "#e7f5ff", "#f3f0ff", "#ffe8f5", "#ebfbee"];
function avatarEl(uid, fallbackName, fallbackPhoto, avatarOverride) {
  const u = users[uid] || {};
  const avatar = avatarOverride ?? u.avatar ?? "";
  if (avatar.startsWith("emoji:")) {
    const span = el("span", "avatar emoji-avatar", avatar.slice(6));
    let h = 0; for (const ch of uid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    span.style.background = EMOJI_BG[h % EMOJI_BG.length];
    return span;
  }
  const img = el("img", "avatar");
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  const name = displayName(uid, fallbackName);
  img.src = avatar.startsWith("data:image/") ? avatar : (u.photo || fallbackPhoto || avatarFallback(name));
  img.onerror = () => { img.onerror = null; img.src = avatarFallback(name); };
  return img;
}

function renderMe() {
  if (!me) return;
  $("me-avatar").replaceChildren(avatarEl(me.uid, me.name, me.photo));
  $("me-name").replaceChildren(displayName(me.uid, me.name));
  if (isAdmin()) $("me-name").append(el("span", "admin-badge", "관리자"));
}

// ---------- 프로필 수정 ----------
const AVATAR_EMOJIS = ["🐶", "🐱", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐧", "🐥", "🦄", "🐙", "🐳", "🦖", "🐝", "🌻", "⭐", "⚽", "🎨", "🎵", "🚀"];
let draftAvatar = "";

function openProfile() {
  const u = users[me.uid] || {};
  draftAvatar = u.avatar || "";
  $("nickname-input").value = u.nickname || me.name || "";
  $("profile-email").textContent = `로그인 계정: ${me.email}`;
  const grid = $("emoji-grid");
  grid.replaceChildren(...AVATAR_EMOJIS.map((e) => {
    const b = el("button", "emoji-choice", e);
    b.type = "button";
    b.onclick = () => { draftAvatar = "emoji:" + e; updateAvatarPreview(); };
    return b;
  }));
  updateAvatarPreview();
  $("profile-dialog").showModal();
}
function updateAvatarPreview() {
  $("profile-avatar-preview").replaceChildren(avatarEl(me.uid, me.name, me.photo, draftAvatar));
  for (const b of $("emoji-grid").children) b.classList.toggle("selected", draftAvatar === "emoji:" + b.textContent);
}
$("profile-btn").onclick = openProfile;
$("avatar-google").onclick = () => { draftAvatar = ""; updateAvatarPreview(); };
$("avatar-file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try { draftAvatar = await resizeImage(file, 160); updateAvatarPreview(); }
  catch { toast("이 사진은 사용할 수 없어요. 다른 사진을 골라 주세요."); }
};
$("profile-form").onsubmit = async (e) => {
  e.preventDefault();
  const nickname = $("nickname-input").value.trim().slice(0, 20);
  if (!nickname) return toast("닉네임을 입력해 주세요");
  $("profile-save").disabled = true;
  try {
    await backend.updateProfile({ nickname, avatar: draftAvatar });
    backend.setMyName(nickname);
    $("profile-dialog").close();
    toast("프로필을 저장했어요");
  } catch (err) {
    toast("저장하지 못했어요: " + err.message);
  } finally {
    $("profile-save").disabled = false;
  }
};

// 프로필 사진을 작은 정사각형 JPEG로 줄여서 저장 (보통 10KB 안팎)
function resizeImage(file, size) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
      canvas.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.src = url;
  });
}

// ---------- 관리자 ----------
$("admin-btn").onclick = () => {
  $("user-search").value = "";
  showAdminTab("invite");
  renderInviteList(); renderUserList();
  $("admin-dialog").showModal();
};
function showAdminTab(tab) {
  for (const b of document.querySelectorAll(".tab-btn")) b.classList.toggle("active", b.dataset.tab === tab);
  $("tab-invite").hidden = tab !== "invite";
  $("tab-users").hidden = tab !== "users";
}
for (const b of document.querySelectorAll(".tab-btn")) b.onclick = () => showAdminTab(b.dataset.tab);

// ----- Gmail 초대 -----
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const siteUrl = () => location.origin + "/";
function inviteText(email) {
  return `안녕하세요! '${SITE_TITLE}'에 초대합니다 💬\n\n`
    + `1) 아래 주소로 들어가세요\n${siteUrl()}\n\n`
    + `2) 'Google 계정으로 로그인'을 누르고, 꼭 이 계정으로 로그인하세요: ${email}\n\n`
    + `3) '📲 앱으로 설치하기'를 누르면 휴대폰·컴퓨터에 앱처럼 설치할 수 있어요.`;
}
const inviteSubject = () => `[${SITE_TITLE}] 초대장이 도착했어요 💌`;
const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function inviteHtml(email) {
  const url = siteUrl();
  const from = escHtml(displayName(me.uid, me.name));
  return `<div style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1c2333">
  <div style="font-size:44px;text-align:center">💬</div>
  <h2 style="text-align:center;margin:8px 0 4px">${escHtml(SITE_TITLE)}에 초대합니다!</h2>
  <p style="text-align:center;color:#6b7489;margin:0 0 24px">${from} 님이 초대했어요</p>
  <p style="text-align:center;margin:0 0 24px">
    <a href="${url}" style="display:inline-block;background:#3b6cf6;color:#fff;text-decoration:none;font-weight:bold;padding:14px 28px;border-radius:12px">채팅방 들어가기</a>
  </p>
  <ol style="line-height:1.8;padding-left:20px">
    <li>위 버튼을 누르거나 <a href="${url}">${url}</a> 로 들어가요.</li>
    <li><b>'Google 계정으로 로그인'</b>을 누르고, 꼭 이 계정으로 로그인해요:<br><b>${escHtml(email)}</b></li>
    <li><b>'📲 앱으로 설치하기'</b>를 누르면 휴대폰·컴퓨터에 앱처럼 설치할 수 있어요.</li>
  </ol>
  <p style="color:#949cb0;font-size:12px;margin-top:24px">초대받은 Gmail 계정으로만 들어올 수 있어요. 잘못 받은 메일이면 무시해 주세요.</p>
</div>`;
}
// Gmail 작성창 열기 (발송 설정이 아직 안 됐을 때 대신 쓰는 방법)
function openGmailCompose(email) {
  const url = "https://mail.google.com/mail/?view=cm&fs=1"
    + `&to=${encodeURIComponent(email)}&su=${encodeURIComponent(inviteSubject())}&body=${encodeURIComponent(inviteText(email))}`;
  window.open(url, "_blank", "noopener");
}

// Gmail로 초대 메일 보내기. 처음 한 번은 구글 창에서 '메일 보내기' 권한을 허용해야 함
async function sendInviteMails(emails) {
  try {
    await backend.getGmailToken(); // 클릭 직후에 권한 창을 띄워야 팝업이 막히지 않음
  } catch (err) {
    return handleGmailError(err, emails);
  }
  let ok = 0;
  const failed = [];
  for (const [i, email] of emails.entries()) {
    toast(`📧 초대 메일 보내는 중… (${i + 1}/${emails.length})`);
    try {
      await backend.sendGmail({ to: email, subject: inviteSubject(), text: inviteText(email), html: inviteHtml(email) });
      await backend.markMailed(email).catch(() => {});
      ok++;
    } catch (err) {
      if (err.code === "gmail/api-disabled" || err.code === "gmail/no-permission") return handleGmailError(err, emails.slice(i));
      failed.push(email);
    }
  }
  toast(failed.length ? `${ok}명에게 보냈고, ${failed.length}명은 실패했어요: ${failed.join(", ")}` : `📨 ${ok}명에게 초대 메일을 보냈어요!`);
}

function handleGmailError(err, emails) {
  const code = err.code || "";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return toast("메일 보내기를 취소했어요 (초대는 저장됐어요)");
  if (code === "auth/popup-blocked") return toast("팝업이 차단됐어요. 주소창 옆에서 팝업을 허용한 뒤 📧 버튼을 다시 눌러 주세요.");
  if (code === "auth/user-mismatch") return toast(`관리자 계정(${me.email})을 선택해야 해요. 📧 버튼을 다시 눌러 주세요.`);
  const reasons = {
    "gmail/api-disabled": "Google Cloud에서 <b>Gmail API</b>가 아직 꺼져 있어요. 아래 ①을 해 주세요.",
    "gmail/no-permission": "구글 창에서 <b>'이메일 보내기' 체크박스</b>를 체크하지 않았어요. 아래 ③을 확인해 주세요.",
    "auth/admin-restricted-operation": "구글 권한 설정이 필요해요. 아래 ②를 확인해 주세요.",
  };
  $("gmail-reason").innerHTML = reasons[code] || `메일을 보내지 못했어요: ${escHtml(err.message)}<br>아래 설정을 확인해 주세요.`;
  $("gmail-fallback").onclick = () => { for (const e of emails.slice(0, 5)) openGmailCompose(e); $("gmail-dialog").close(); };
  $("gmail-dialog").showModal();
}
$("gmail-help").onclick = () => { $("gmail-reason").textContent = "처음 한 번만 하면 되는 설정이에요."; $("gmail-fallback").onclick = () => $("gmail-dialog").close(); $("gmail-dialog").showModal(); };
for (const a of document.querySelectorAll("#gmail-dialog a[data-gcp]")) {
  a.href = a.dataset.gcp.replace("PROJECT", firebaseConfig.projectId);
}
$("invite-send").checked = safeGet("inviteSendMail") !== "off";
$("invite-send").onchange = () => safeSet("inviteSendMail", $("invite-send").checked ? "on" : "off");

$("invite-form").onsubmit = async (e) => {
  e.preventDefault();
  const raw = $("invite-input").value;
  const emails = [...new Set(raw.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const bad = emails.filter((x) => !EMAIL_RE.test(x));
  if (!emails.length) return toast("초대할 Gmail 주소를 입력해 주세요");
  if (bad.length) return toast("이메일 형식이 아니에요: " + bad.join(", "));
  const sendMail = $("invite-send").checked;
  // 메일도 보낼 거면, 버튼을 누른 바로 그 순간에 Gmail 권한 창부터 띄움 (늦게 띄우면 브라우저가 팝업을 막음)
  const tokenReady = sendMail && !backend.hasGmailToken() ? backend.getGmailToken().then(() => null, (err) => err) : Promise.resolve(null);
  try {
    await backend.invite(emails);
    $("invite-input").value = "";
    toast(`${emails.length}명을 초대했어요. 이제 그 계정으로 로그인할 수 있어요.`);
  } catch (err) {
    return toast("초대하지 못했어요: " + err.message);
  }
  if (!sendMail) return;
  const tokenErr = await tokenReady;
  if (tokenErr) return handleGmailError(tokenErr, emails);
  await sendInviteMails(emails);
};
$("invite-copy").onclick = async () => {
  const text = inviteText("(초대받은 Gmail 주소)");
  try { await navigator.clipboard.writeText(text); toast("초대 문구를 복사했어요. 카톡·문자에 붙여넣으세요."); }
  catch { prompt("아래 문구를 복사하세요", text); }
};
$("invite-all").onclick = async () => {
  const missing = uninvitedUsers();
  if (!missing.length) return;
  if (!confirm(`지금까지 이 사이트를 쓴 ${missing.length}명을 초대 목록에 추가할까요?`)) return;
  try { await backend.invite(missing.map((u) => u.email)); toast(`${missing.length}명을 초대 목록에 추가했어요`); }
  catch (err) { toast("실패했어요: " + err.message); }
};

// 이미 사이트를 쓰고 있지만 초대 목록에 없는 사람 (초대 기능을 켜기 전에 가입한 사람)
function uninvitedUsers() {
  return Object.entries(users)
    .filter(([uid, u]) => !u.admin && u.email && !invitesMap.has(u.email.toLowerCase()))
    .map(([uid, u]) => ({ uid, ...u }));
}
function userByEmail(email) {
  return Object.entries(users).find(([, u]) => (u.email || "").toLowerCase() === email);
}

function renderInviteList() {
  const missing = uninvitedUsers();
  $("invite-migrate").hidden = !missing.length;
  $("invite-migrate-count").textContent = missing.length;
  const ul = $("invite-list");
  ul.replaceChildren();
  const emails = [...invitesMap.keys()].sort();
  $("invite-count").textContent = emails.length;
  if (!emails.length) ul.append(el("li", "empty", "아직 초대한 사람이 없어요"));
  for (const email of emails) {
    const li = el("li");
    const found = userByEmail(email);
    if (found) li.append(avatarEl(found[0], found[1].name, found[1].photo));
    else li.append(el("span", "avatar emoji-avatar invite-avatar", "✉️"));
    const info = el("div", "user-info");
    info.append(el("div", "user-name", found ? displayName(found[0], found[1].name) : email));
    const mailedAt = invitesMap.get(email)?.mailedAt;
    const mailed = mailedAt ? ` · 📨 메일 보냄 ${mailedAt.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })}` : "";
    info.append(el("div", "user-email", (found ? `${email} · ✅ 가입함` : "⏳ 아직 로그인 안 함") + mailed));
    li.append(info);
    const mail = el("button", "pill-btn", "📧");
    mail.title = "Gmail로 초대 메일 보내기";
    mail.onclick = () => sendInviteMails([email]);
    const del = el("button", "pill-btn danger", "초대 취소");
    del.onclick = async () => {
      if (!confirm(`${email}의 초대를 취소할까요?\n이 계정은 더 이상 채팅방에 들어올 수 없어요.`)) return;
      try { await backend.uninvite(email); toast("초대를 취소했어요"); } catch (err) { toast("실패했어요: " + err.message); }
    };
    li.append(mail, del);
    ul.append(li);
  }
}

$("user-search").oninput = renderUserList;

function renderUserList() {
  const q = $("user-search").value.trim().toLowerCase();
  const list = Object.entries(users)
    .map(([uid, u]) => ({ uid, ...u, display: displayName(uid, u.name) }))
    .filter((u) => !q || u.display.toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q))
    .sort((a, b) => (bannedSet.has(b.uid) - bannedSet.has(a.uid)) || a.display.localeCompare(b.display, "ko"));
  const ul = $("user-list");
  ul.replaceChildren();
  if (!list.length) ul.append(el("li", "empty", "사용자가 없어요"));
  for (const u of list) {
    const banned = bannedSet.has(u.uid);
    const li = el("li", banned ? "banned" : "");
    li.append(avatarEl(u.uid, u.name, u.photo));
    const info = el("div", "user-info");
    const nameLine = el("div", "user-name", u.display);
    if (u.nickname && u.name && u.nickname !== u.name) nameLine.append(el("span", "user-real", ` (${u.name})`));
    if (u.admin) nameLine.append(el("span", "admin-badge", "관리자"));
    if (banned) nameLine.append(el("span", "banned-badge", "차단됨"));
    const notInvited = !u.admin && u.email && !invitesMap.has(u.email.toLowerCase());
    if (notInvited) nameLine.append(el("span", "banned-badge", "초대 안 됨"));
    info.append(nameLine, el("div", "user-email", u.email || ""));
    li.append(info);
    if (notInvited) {
      const inv = el("button", "pill-btn", "초대");
      inv.onclick = async () => { try { await backend.invite([u.email]); toast("초대했어요"); } catch (e) { toast("실패했어요: " + e.message); } };
      li.append(inv);
    }
    if (u.uid !== me.uid && !u.admin) {
      const b = el("button", banned ? "pill-btn" : "pill-btn danger", banned ? "차단 해제" : "차단");
      b.onclick = async () => {
        if (!banned && !confirm(`${u.display}(${u.email}) 님을 차단할까요?\n차단하면 채팅방을 보거나 메시지를 보낼 수 없어요.`)) return;
        try { banned ? await backend.unban(u.uid) : await backend.ban(u.uid); toast(banned ? "차단을 풀었어요" : "차단했어요"); }
        catch (e) { toast("실패했어요: " + e.message); }
      };
      li.append(b);
    }
    ul.append(li);
  }
}

function renderNotice() {
  const text = currentRoom?.kind === "dm" ? "" : currentRoom?.notice?.text;
  $("notice").hidden = !text;
  $("notice-text").textContent = text || "";
}

$("room-menu-btn").onclick = (e) => { e.stopPropagation(); $("room-menu").hidden = !$("room-menu").hidden; };
document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) $("room-menu").hidden = true; });
$("room-menu").onclick = async (e) => {
  const act = e.target.closest("button")?.dataset.act;
  if (!act || !currentRoom) return;
  $("room-menu").hidden = true;
  const room = currentRoom;
  try {
    if (act === "notice") {
      const text = prompt("공지 내용을 입력하세요 (비우면 공지를 내려요)", room.notice?.text || "");
      if (text === null) return;
      await backend.setNotice(room.id, text.trim().slice(0, 200));
      toast(text.trim() ? "공지를 올렸어요" : "공지를 내렸어요");
    } else if (act === "rename") {
      const name = prompt("새 방 이름 (40자까지)", room.name)?.trim();
      if (!name || name === room.name) return;
      await backend.renameRoom(room.id, name.slice(0, 40));
      toast("방 이름을 바꿨어요");
    } else if (act === "delete") {
      if (!confirm(`'${room.name}' 방을 삭제할까요?\n방의 모든 메시지와 파일이 영구히 지워져요.`)) return;
      if (prompt(`정말 삭제하려면 방 이름을 그대로 입력하세요:\n${room.name}`) !== room.name) return toast("방 이름이 달라서 취소했어요");
      toast("삭제하는 중…");
      await backend.deleteRoom(room.id);
      toast("방을 삭제했어요");
    }
  } catch (err) {
    toast("실패했어요: " + err.message);
  }
};

// ---------- 앱 설치 (PWA) ----------
let installPrompt = null;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function updateInstallButtons() {
  for (const b of document.querySelectorAll(".install-btn")) b.hidden = isStandalone();
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; updateInstallButtons(); });
window.addEventListener("appinstalled", () => { installPrompt = null; updateInstallButtons(); toast("앱을 설치했어요! 홈 화면에서 열 수 있어요 🎉"); });
for (const b of document.querySelectorAll(".install-btn")) b.onclick = installApp;
updateInstallButtons();

async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === "accepted") updateInstallButtons();
    return;
  }
  // 바로 설치 창을 띄울 수 없는 브라우저 → 방법 안내
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const samsung = /SamsungBrowser/.test(ua);
  const kakao = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\//i.test(ua);
  let steps;
  if (kakao) steps = ["지금은 카카오톡 같은 앱 안의 브라우저라서 설치할 수 없어요.", "오른쪽 아래(또는 위) <b>⋮ 메뉴 → '다른 브라우저로 열기'</b>를 누른 뒤, 크롬이나 사파리에서 다시 설치해 주세요."];
  else if (iOS) steps = ["<b>Safari</b>로 이 사이트를 열어 주세요. (다른 브라우저에서는 메뉴에 '홈 화면에 추가'가 있으면 그걸 눌러도 돼요)", "아래쪽(아이패드는 위쪽)의 <b>공유 버튼</b> <span class='kbd'>⬆</span> 을 눌러요.", "<b>'홈 화면에 추가'</b>를 누르고, 오른쪽 위 <b>'추가'</b>를 눌러요."];
  else if (samsung) steps = ["아래쪽 <b>≡ 메뉴</b>를 눌러요.", "<b>'현재 페이지 추가' → '홈 화면'</b> (또는 '앱 설치')을 눌러요."];
  else steps = ["주소창 오른쪽의 <b>설치 아이콘</b> <span class='kbd'>⊕</span> 또는 <span class='kbd'>📲</span> 을 눌러요.", "아이콘이 없으면 오른쪽 위 <b>⋮ 메뉴 → '앱 설치'</b> 또는 <b>'홈 화면에 추가'</b>를 눌러요.", "설치 창에서 <b>'설치'</b>를 눌러요."];
  $("install-steps").innerHTML = "<ol>" + steps.map((t) => `<li>${t}</li>`).join("") + "</ol>"
    + "<p class='hint'>설치하면 홈 화면(바탕화면)에 💬 아이콘이 생기고, 일반 앱처럼 전체 화면으로 열려요.</p>";
  $("install-dialog").showModal();
}

// ---------- 대화상자 공통 ----------
for (const d of document.querySelectorAll("dialog")) {
  d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
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
