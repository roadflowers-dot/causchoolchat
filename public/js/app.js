import { firebaseConfig, ALLOWED_EMAIL_DOMAIN, MAX_FILE_MB } from "./firebase-config.js";

const SITE_TITLE = "중대부초 실시간 채팅방";
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];
const ROOM_COLORS = ["#3b6cf6", "#f2994a", "#27ae60", "#eb5757", "#9b51e0", "#2d9cdb", "#e2b93b", "#f06292"];

// ---------- 백엔드 선택 ----------
// 데모 모드는 개발용 컴퓨터(localhost)에서만 켤 수 있음. 실제 사이트에서는 항상 Firebase 사용
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
const isDemo = isLocal && (firebaseConfig.apiKey.startsWith("YOUR_") || new URLSearchParams(location.search).has("demo"));
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
let pendingList = [], offPending = null, seenPending = null; // (관리자) 외부 사람 입장 요청
let entryRequested = false;
let emailsMap = {}, offEmails = null, emailCleanupDone = false; // (관리자) uid -> 이메일
const emailOf = (uid) => emailsMap[uid] || users[uid]?.email || "";
let firstRenderOfRoom = false;
let users = {};         // uid -> { nickname, avatar, photo, name, email, admin }
let bannedSet = new Set();
let offUsers = null, offMyBan = null, offBanned = null;
const isAdmin = () => !!me?.isAdmin;
const isOwner = () => !!me?.isOwner;
let offFilter = null, offAdmins = null, offTyping = null, roomsMigrated = false;
let editingMsg = null;        // 수정 중인 내 메시지
let typingList = [];          // 지금 방에서 입력 중인 사람
let typingOn = false, typingSentAt = 0, typingIdle = null;
let adminEmails = [];         // (최고 관리자) 부관리자 이메일 목록

// ---------- 나쁜 말 필터 ----------
// 관리자가 바꾸기 전까지 쓰는 기본 금지어. 띄어쓰기·기호를 섞어 써도 찾아냄 (예: "시 발", "시.발")
const DEFAULT_BAD_WORDS = [
  "시발", "씨발", "씨바", "시바", "씨팔", "시팔", "ㅅㅂ", "ㅆㅂ", "ㅆㅃ", "병신", "븅신", "ㅂㅅ", "개새끼", "개새", "개색기", "개세끼",
  "존나", "졸라", "존내", "ㅈㄴ", "지랄", "ㅈㄹ", "미친놈", "미친년", "닥쳐", "좆", "ㅈ같", "니애미", "느금마", "엠창", "애미",
  "등신", "또라이", "썅", "fuck", "shit", "bitch",
];
// 금지어가 들어 있지만 괜찮은 낱말 (가리지 않음)
const ALLOWED_WORDS = ["시발점", "시발역", "시발택시", "등신대", "병신년", "병신춘문예", "개새기다"];
let badWords = DEFAULT_BAD_WORDS;
let badRe = buildBadRe(badWords);
function buildBadRe(words) {
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = [...new Set(words.map((w) => w.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((w) => Array.from(w).map(esc).join("[\\s.,·_~!*\\-]*"));
  return parts.length ? new RegExp(parts.join("|"), "gi") : null;
}
// 금지어를 **로 가림
function maskBad(text) {
  if (!badRe || !text) return text;
  const safe = []; // 괜찮은 낱말이 있는 위치
  for (const w of ALLOWED_WORDS) {
    for (let i = text.indexOf(w); i !== -1; i = text.indexOf(w, i + 1)) safe.push([i, i + w.length]);
  }
  return text.replace(badRe, (m, at) => {
    if (safe.some(([a, b]) => a <= at && at + m.length <= b)) return m;
    return "*".repeat(Math.max(2, Math.min(6, Array.from(m.replace(/[\s.,·_~!*\-]/g, "")).length)));
  });
}

// ---------- 로그인 / 로그아웃 ----------
backend.onAuth((user, error) => {
  me = user;
  $("login-view").hidden = !!user;
  $("chat-view").hidden = !user;
  $("login-error").hidden = !error;
  if (error) $("login-error").textContent = error;

  $("banned-view").hidden = true;
  document.body.classList.remove("guest");
  entryRequested = false;
  if (user) {
    renderMe();
    prevLastAt = {};
    $("admin-btn").hidden = !isAdmin();
    $("new-room-btn").hidden = !isAdmin(); // 채팅방은 관리자만 만들 수 있음
    $("admin-tab-owner").hidden = !isOwner();
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
  const banned = access.banned;
  const guest = !banned && !access.invited; // 등록 안 된 외부 사람: 사이트엔 들어오지만 채팅방은 못 봄
  $("banned-view").hidden = !banned;
  $("chat-view").hidden = banned;
  if (banned) { stopListening(); document.body.classList.remove("guest"); return; }
  if (guest) return enterGuestMode();
  if (document.body.classList.contains("guest")) { // 관리자가 초대함 → 바로 채팅방 열림
    document.body.classList.remove("guest");
    $("messages").replaceChildren();
    toast("🎉 관리자가 초대했어요! 이제 채팅방에 들어갈 수 있어요.");
  }
  if (!offRooms) startListening();
}

// 등록 안 된 외부 사람 화면: 사이트 화면은 보이지만 채팅방·친구 목록은 비어 있고, 관리자에게 입장 알림을 보냄
function enterGuestMode() {
  stopListening();
  document.body.classList.add("guest");
  const waitLi = el("li", "empty");
  waitLi.innerHTML = "🔒 아직 등록되지 않아서<br>채팅방이 보이지 않아요";
  $("room-list").replaceChildren(waitLi);
  $("room-title").textContent = "입장 대기 중";
  $("room-icon").replaceWith(Object.assign(el("span", "room-icon"), { id: "room-icon" }));
  $("notice").hidden = true;
  $("files-panel").hidden = true;
  setComposerEnabled(false);
  const card = el("div", "guest-card");
  card.innerHTML = `<div class="logo">🚪</div>
    <h3>관리자의 확인을 기다리고 있어요</h3>
    <p>지금 로그인한 계정 <b></b> 은(는) 아직 등록되지 않았어요.
    관리자에게 <b>입장 알림</b>을 보냈어요. 관리자가 초대하면 새로고침하지 않아도 <b>자동으로 채팅방이 열려요.</b></p>
    <p class="hint">다른 계정으로 들어가려면 '로그아웃'을 눌러 주세요. (휴대폰은 왼쪽 위 ☰ 메뉴 안에 있어요)</p>`;
  card.querySelector("p b").textContent = me.email;
  $("messages").replaceChildren(card);
  if (!entryRequested) { entryRequested = true; backend.requestEntry().catch(console.warn); }
}

function startListening() {
  offUsers = backend.listenUsers((u) => {
    users = u;
    backend.setMyName(users[me.uid]?.nickname);
    if (isAdmin() && !emailCleanupDone) {
      // 예전 버전 데이터: 프로필에 남아 있는 이메일을 이메일 전용 보관함으로 옮긴 뒤 지움 (학생들에게 안 보이게)
      const legacy = Object.entries(u).filter(([, x]) => x.email).map(([uid, x]) => [uid, emailsMap[uid] || x.email]);
      if (legacy.length) {
        emailCleanupDone = true;
        for (const [uid, x] of Object.entries(u)) if (x.email && !emailsMap[uid]) emailsMap[uid] = x.email;
        backend.cleanupProfileEmails(legacy).catch((e) => { emailCleanupDone = false; console.warn(e); });
      }
    }
    renderMe();
    renderRooms();
    if (currentRoom) { renderRoomHeader(); renderMessages(); }
    if ($("admin-dialog").open) { renderUserList(); renderInviteList(); }
  });
  offRooms = backend.listenRooms((list) => {
    if (isAdmin() && !roomsMigrated && list.some((r) => !r.visibility)) {
      roomsMigrated = true; // 예전 방에 '공개' 표시 채우기 (안 하면 학생 목록에 안 보임)
      backend.migrateRooms(list).catch((e) => { roomsMigrated = false; console.warn(e); });
    }
    onRooms("group", list);
  }, { admin: isAdmin() });
  offFilter = backend.listenFilter((words) => {
    badWords = words ?? DEFAULT_BAD_WORDS;
    badRe = buildBadRe(badWords);
    renderRooms();
    if (currentRoom) renderMessages();
    if ($("admin-dialog").open) renderFilterList();
  });
  if (isOwner()) offAdmins = backend.listenAdmins((list) => { adminEmails = list; if ($("admin-dialog").open) renderAdminList(); });
  offDms = backend.listenDms((list) => onRooms("dm", list));
  if (isAdmin()) offInvites = backend.listenInvites((map) => { invitesMap = map; updatePendingUI(); if ($("admin-dialog").open) { renderInviteList(); renderUserList(); } });
  if (isAdmin()) offBanned = backend.listenBanned((set) => { bannedSet = set; updatePendingUI(); if ($("admin-dialog").open) renderUserList(); });
  if (isAdmin()) offPending = backend.listenPending(onPending);
  if (isAdmin()) offEmails = backend.listenEmails((m) => {
    emailsMap = m;
    if ($("admin-dialog").open) { renderInviteList(); renderUserList(); }
  });
}
function stopListening() {
  stopTyping();
  for (const off of [offRooms, offDms, offMessages, offFiles, offUsers, offBanned, offInvites, offPending, offEmails, offFilter, offAdmins, offTyping]) off?.();
  offRooms = offDms = offMessages = offFiles = offUsers = offBanned = offInvites = offPending = offEmails = offFilter = offAdmins = offTyping = null;
  pendingList = []; seenPending = null;
  groupRooms = []; dmRooms = []; rooms = [];
  currentRoom = null;
}
$("banned-logout").onclick = () => backend.signOut();

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
    text.append(el("div", "room-name", (room.visibility === "private" ? "🔒 " : "") + roomName(room)));
    const lm = room.lastMessage;
    text.append(el("div", "room-preview", lm ? `${lm.uid === me?.uid ? "나" : displayName(lm.uid, lm.name)}: ${maskBad(lm.text ?? "")}` : room.kind === "dm" ? "1:1 채팅" : "새 채팅방"));
    li.append(text);
    if (unread) li.append(el("span", "unread-dot"));
    li.onclick = () => openRoom(room);
    list.append(li);
  };
  section("채팅방");
  if (!groupRooms.length) list.append(Object.assign(el("li", "empty"), { innerHTML: isAdmin() ? "아직 채팅방이 없어요.<br>위쪽 ＋ 버튼으로 만들어 보세요!" : "아직 들어갈 수 있는 채팅방이 없어요.<br>관리자가 방을 만들면 여기에 보여요." }));
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

$("new-room-btn").onclick = () => openRoomDialog(null);

// ----- 방 만들기 / 방 설정 (관리자): 이름 + 공개 범위 + 멤버 -----
let roomDialogTarget = null, roomDialogMembers = new Set();
function openRoomDialog(room) {
  roomDialogTarget = room;
  $("room-dialog-title").textContent = room ? "⚙️ 방 설정" : "＋ 새 채팅방 만들기";
  $("room-name-input").value = room?.name || "";
  const priv = room?.visibility === "private";
  $("room-vis-public").checked = !priv;
  $("room-vis-private").checked = priv;
  roomDialogMembers = new Set(room?.members || [me.uid]);
  $("room-member-search").value = "";
  renderRoomMembers();
  $("room-save").textContent = room ? "저장" : "만들기";
  $("room-dialog").showModal();
}
function renderRoomMembers() {
  const priv = $("room-vis-private").checked;
  $("room-members-box").hidden = !priv;
  if (!priv) return;
  const q = $("room-member-search").value.trim().toLowerCase();
  const ul = $("room-member-list");
  ul.replaceChildren();
  const list = Object.entries(users)
    .map(([uid, u]) => ({ uid, ...u, display: displayName(uid, u.name) }))
    .filter((u) => !q || u.display.toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q))
    .sort((a, b) => (roomDialogMembers.has(b.uid) - roomDialogMembers.has(a.uid)) || a.display.localeCompare(b.display, "ko"));
  for (const u of list) {
    const li = el("li", "pick member-pick");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = roomDialogMembers.has(u.uid);
    cb.onchange = () => { cb.checked ? roomDialogMembers.add(u.uid) : roomDialogMembers.delete(u.uid); $("room-member-count").textContent = roomDialogMembers.size; };
    li.append(cb, avatarEl(u.uid, u.name, u.photo));
    const info = el("div", "user-info");
    info.append(el("div", "user-name", u.display + (u.uid === me.uid ? " (나)" : "")));
    li.append(info);
    li.onclick = (e) => { if (e.target !== cb) { cb.checked = !cb.checked; cb.onchange(); } };
    ul.append(li);
  }
  $("room-member-count").textContent = roomDialogMembers.size;
}
$("room-vis-public").onchange = $("room-vis-private").onchange = renderRoomMembers;
$("room-member-search").oninput = renderRoomMembers;
$("room-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("room-name-input").value.trim().slice(0, 40);
  if (!name) return toast("방 이름을 입력해 주세요");
  const visibility = $("room-vis-private").checked ? "private" : "public";
  const members = [...roomDialogMembers];
  if (visibility === "private" && members.length < 1) return toast("멤버를 한 명 이상 골라 주세요");
  $("room-save").disabled = true;
  try {
    if (roomDialogTarget) {
      if (name !== roomDialogTarget.name) await backend.renameRoom(roomDialogTarget.id, name);
      await backend.setRoomAccess(roomDialogTarget.id, { visibility, members });
      toast("방 설정을 저장했어요");
    } else {
      await backend.createRoom(name, { visibility, members });
      toast(`'${name}' 방을 만들었어요`);
    }
    $("room-dialog").close();
  } catch (err) {
    toast("저장하지 못했어요: " + err.message);
  } finally {
    $("room-save").disabled = false;
  }
};

function openRoom(room) {
  if (currentRoom?.id !== room.id) { stopTyping(); clearReply(); }
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
  offTyping?.();
  typingList = []; renderTyping();
  offTyping = backend.listenTyping(room.id, (list) => { typingList = list; renderTyping(); });
  if (!matchMedia("(pointer: coarse)").matches) $("message-input").focus();
}

function renderRoomHeader() {
  const room = currentRoom;
  if (!room) return;
  $("room-title").textContent = (room.visibility === "private" ? "🔒 " : "") + roomName(room);
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
    q.append(el("b", null, m.replyTo.name), " " + maskBad(m.replyTo.text));
    q.onclick = () => jumpTo(m.replyTo.id);
    body.append(q);
  }
  if (m.type === "file") body.append(fileEl(m.file));
  else if (m.type === "poll") body.append(pollEl(m));
  else {
    const text = maskBad(m.text);
    const bubble = el("div", "bubble" + (isEmojiOnly(text) && !m.editedAt ? " emoji-only" : ""));
    linkify(bubble, text);
    if (m.editedAt) bubble.append(el("span", "edited", " (수정됨)"));
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
  if (mine && m.type === "text") add("✏️", "수정", () => startEdit(m));
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
  editingMsg = null;
  const preview = m.type === "file" ? "📎 " + m.file.name : m.type === "poll" ? "📊 " + m.poll.question : m.text;
  replyTo = { id: m.id, name: displayName(m.uid, m.name), text: maskBad(preview).slice(0, 80) };
  $("reply-label").textContent = `↩ ${m.uid === me?.uid ? "나" : displayName(m.uid, m.name)}에게 답장`;
  $("reply-text").textContent = replyTo.text;
  $("reply-bar").hidden = false;
  openActionsId = pickerId = null;
  renderMessages();
  $("message-input").focus();
}
function clearReply() {
  if (editingMsg) { input.value = ""; autoGrow(); }
  replyTo = null; editingMsg = null; $("reply-bar").hidden = true;
}
// ----- 내 메시지 수정 -----
function startEdit(m) {
  replyTo = null;
  editingMsg = m;
  $("reply-label").textContent = "✏️ 메시지 수정 중 (Esc: 취소)";
  $("reply-text").textContent = m.text;
  $("reply-bar").hidden = false;
  openActionsId = pickerId = null;
  renderMessages();
  input.value = m.text; autoGrow();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
$("reply-cancel").onclick = clearReply;

// ---------- 메시지 보내기 ----------
const input = $("message-input");
function autoGrow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
input.addEventListener("input", () => { autoGrow(); onTypingInput(); });
input.addEventListener("blur", () => stopTyping());
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
  const raw = input.value.trim();
  if (!raw || !currentRoom) return;
  const text = maskBad(raw); // 나쁜 말은 ** 로 가려서 보냄
  stopTyping();
  if (editingMsg) { // 수정
    const m = editingMsg;
    input.value = ""; autoGrow(); replyTo = null; editingMsg = null; $("reply-bar").hidden = true;
    if (text === m.text) return;
    try {
      await backend.editMessage(currentRoom.id, m, text);
      const old = olderMsgs.find((x) => x.id === m.id);
      if (old) { old.text = text; old.editedAt = new Date(); renderMessages(); }
    } catch (err) {
      toast("수정하지 못했어요: " + err.message);
    }
    return;
  }
  const reply = replyTo;
  input.value = ""; autoGrow(); clearReply();
  try {
    await backend.sendText(currentRoom.id, text, reply);
  } catch (err) {
    input.value = raw; autoGrow();
    toast("보내지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
};

// ----- "OO님이 입력 중…" -----
function onTypingInput() {
  if (!currentRoom || editingMsg) return;
  if (!input.value.trim()) return stopTyping();
  const now = Date.now();
  if (!typingOn || now - typingSentAt > 8000) { // 8초마다 한 번만 알림 (무료 사용량 아끼기)
    typingOn = true; typingSentAt = now;
    backend.setTyping(currentRoom.id, true);
  }
  clearTimeout(typingIdle);
  typingIdle = setTimeout(stopTyping, 6000); // 6초 동안 안 치면 끝
}
function stopTyping(roomId = currentRoom?.id) {
  clearTimeout(typingIdle);
  if (typingOn && roomId) backend.setTyping(roomId, false);
  typingOn = false;
}
function renderTyping() {
  const names = typingList
    .filter((t) => t.uid !== me?.uid && Date.now() - t.at.getTime() < 15000)
    .map((t) => displayName(t.uid));
  $("typing").hidden = !names.length;
  $("typing-text").textContent = names.length > 3 ? "여러 명이 입력 중…" : `${names.join(", ")}님이 입력 중…`;
}
setInterval(() => { if (typingList.length) renderTyping(); }, 3000);

// ----- 투표 -----
function pollEl(m) {
  const votes = m.votes || {};
  const total = Object.keys(votes).length;
  const myVote = votes[me?.uid];
  const closed = !!m.closed;
  const card = el("div", "poll" + (closed ? " closed" : ""));
  card.append(el("div", "poll-q", "📊 " + maskBad(m.poll.question)));
  m.poll.options.forEach((opt, i) => {
    const count = Object.values(votes).filter((v) => v === i).length;
    const pct = total ? Math.round((count / total) * 100) : 0;
    const b = el("button", "poll-opt" + (myVote === i ? " mine" : ""));
    b.disabled = closed;
    const bar = el("span", "poll-bar"); bar.style.width = pct + "%";
    b.append(bar, el("span", "poll-label", (myVote === i ? "✓ " : "") + maskBad(opt)), el("span", "poll-count", `${count}명 · ${pct}%`));
    b.onclick = () => votePoll(m, myVote === i ? null : i);
    b.title = closed ? "마감된 투표예요" : myVote === i ? "누르면 내 표 취소" : "이걸로 투표";
    card.append(b);
  });
  const foot = el("div", "poll-foot", `${total}명 참여` + (closed ? " · 마감됨" : " · 다시 누르면 바꿀 수 있어요"));
  if (!closed && (m.uid === me?.uid || isAdmin())) {
    const end = el("button", "text-btn", "투표 마감");
    end.onclick = async () => {
      if (!confirm("투표를 마감할까요? 마감하면 더 이상 투표할 수 없어요.")) return;
      try { await backend.closePoll(currentRoom.id, m); const old = olderMsgs.find((x) => x.id === m.id); if (old) old.closed = true; renderMessages(); }
      catch (e) { toast("실패했어요: " + e.message); }
    };
    foot.append(end);
  }
  card.append(foot);
  return card;
}
async function votePoll(m, index) {
  try {
    await backend.vote(currentRoom.id, m, index);
    const old = olderMsgs.find((x) => x.id === m.id);
    if (old && !liveMsgs.some((x) => x.id === m.id)) {
      old.votes = { ...(old.votes || {}) };
      if (index === null) delete old.votes[me.uid]; else old.votes[me.uid] = index;
      renderMessages();
    }
  } catch (e) {
    toast("투표하지 못했어요: " + e.message);
  }
}
function openPollDialog() {
  $("poll-question").value = "";
  const box = $("poll-options");
  box.replaceChildren();
  addPollOption(); addPollOption();
  $("poll-dialog").showModal();
  $("poll-question").focus();
}
function addPollOption() {
  const box = $("poll-options");
  if (box.children.length >= 6) return toast("선택지는 6개까지 만들 수 있어요");
  const row = el("div", "poll-opt-row");
  const inp = el("input"); inp.maxLength = 50; inp.placeholder = `선택지 ${box.children.length + 1}`;
  const del = el("button", "icon-btn", "✕"); del.type = "button"; del.title = "선택지 지우기";
  del.onclick = () => { if (box.children.length > 2) row.remove(); else toast("선택지는 2개 이상이어야 해요"); };
  row.append(inp, del);
  box.append(row);
  $("poll-add").hidden = box.children.length >= 6;
}
$("poll-btn").onclick = () => { if (currentRoom) openPollDialog(); };
$("poll-add").onclick = addPollOption;
$("poll-form").onsubmit = async (e) => {
  e.preventDefault();
  const question = maskBad($("poll-question").value.trim()).slice(0, 200);
  const options = [...$("poll-options").querySelectorAll("input")].map((i) => maskBad(i.value.trim()).slice(0, 50)).filter(Boolean);
  if (!question) return toast("질문을 입력해 주세요");
  if (options.length < 2) return toast("선택지를 2개 이상 입력해 주세요");
  try {
    await backend.sendPoll(currentRoom.id, question, options);
    $("poll-dialog").close();
  } catch (err) {
    toast("투표를 만들지 못했어요: " + err.message);
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
    if (e.data?.admin && isAdmin()) return openPendingAdmin();
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
    const text = maskBad(lm.text);
    if (!document.hidden) toast(room.kind === "dm" ? `💌 ${who}: ${text}` : `💬 ${room.name} · ${who}: ${text}`, () => openRoom(room));
    else if (notifyOn()) showNotification(room, `${who}: ${text}`);
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
$("profile-btn").onclick = () => {
  if (document.body.classList.contains("guest")) return toast("관리자가 초대한 뒤에 프로필을 바꿀 수 있어요");
  openProfile();
};
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
  renderInviteList(); renderUserList(); renderPendingList();
  $("admin-dialog").showModal();
};
// ----- 외부 사람 입장 알림 (관리자) -----
// 아직 결정하지 않은 입장 요청 (이미 초대했거나 차단한 사람은 빼고)
function visiblePending() {
  return pendingList
    .filter((p) => !invitesMap.has((p.email || "").toLowerCase()) && !bannedSet.has(p.uid))
    .sort((a, b) => b.at - a.at);
}
function onPending(list) {
  pendingList = list;
  const vis = visiblePending();
  if (seenPending === null) { // 처음 불러왔을 때: 밀린 요청이 있으면 한 번 알려줌
    seenPending = new Set(list.map((p) => p.uid));
    if (vis.length) toast(`🚪 확인하지 않은 외부 사람 입장이 ${vis.length}건 있어요 (눌러서 확인)`, openPendingAdmin);
  } else {
    for (const p of vis) {
      if (seenPending.has(p.uid)) continue;
      const who = `${p.name || "이름 없음"} (${p.email})`;
      if (!document.hidden) toast(`🚪 외부 사람이 들어왔어요: ${who} — 눌러서 초대/차단`, openPendingAdmin);
      else if (notifyOn()) showEntryNotification(who);
    }
    seenPending = new Set(list.map((p) => p.uid));
  }
  updatePendingUI();
}
function showEntryNotification(who) {
  const options = { body: `${who}\n눌러서 초대하거나 차단하세요`, tag: "entry", renotify: true, data: { admin: true } };
  try {
    if (swReg) return swReg.showNotification("🚪 외부 사람 입장", options);
    const n = new Notification("🚪 외부 사람 입장", options);
    n.onclick = () => { window.focus(); openPendingAdmin(); n.close(); };
  } catch {}
}
function updatePendingUI() {
  if (!isAdmin()) return;
  const n = visiblePending().length;
  $("admin-badge-count").hidden = !n;
  $("admin-badge-count").textContent = n > 9 ? "9+" : n;
  if ($("admin-dialog").open) renderPendingList();
}
function openPendingAdmin() {
  $("user-search").value = "";
  showAdminTab("invite");
  renderInviteList(); renderUserList(); renderPendingList();
  if (!$("admin-dialog").open) $("admin-dialog").showModal();
  $("pending-box").scrollIntoView({ block: "nearest" });
}
function renderPendingList() {
  const vis = visiblePending();
  $("pending-box").hidden = !vis.length;
  $("pending-count").textContent = vis.length;
  const ul = $("pending-list");
  ul.replaceChildren();
  for (const p of vis) {
    const li = el("li");
    const img = el("img", "avatar");
    img.alt = ""; img.referrerPolicy = "no-referrer";
    img.src = p.photo || avatarFallback(p.name);
    img.onerror = () => { img.onerror = null; img.src = avatarFallback(p.name); };
    li.append(img);
    const info = el("div", "user-info");
    info.append(el("div", "user-name", p.name || "이름 없음"));
    info.append(el("div", "user-email", `${p.email} · ${timeAgo(p.at)}`));
    li.append(info);
    const ok = el("button", "pill-btn ok", "초대");
    ok.onclick = async () => {
      try { await backend.approvePending(p); toast(`${p.name || p.email} 님을 초대했어요. 바로 채팅방에 들어갈 수 있어요.`); }
      catch (e) { toast("실패했어요: " + e.message); }
    };
    const no = el("button", "pill-btn danger", "차단");
    no.onclick = async () => {
      if (!confirm(`${p.name || ""} (${p.email}) 님을 차단할까요?\n차단하면 이 사이트를 이용할 수 없어요.`)) return;
      try { await backend.rejectPending(p); toast("차단했어요"); } catch (e) { toast("실패했어요: " + e.message); }
    };
    li.append(ok, no);
    ul.append(li);
  }
}
function timeAgo(d) {
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 1440) return `${Math.round(m / 60)}시간 전`;
  return d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

function showAdminTab(tab) {
  for (const b of document.querySelectorAll(".tab-btn")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const t of ["invite", "users", "filter", "storage", "owner"]) $("tab-" + t).hidden = tab !== t;
  if (tab === "filter") renderFilterList();
  if (tab === "owner") renderAdminList();
}

// ----- 🚫 금지어 관리 -----
function renderFilterList() {
  const box = $("filter-list");
  box.replaceChildren();
  $("filter-count").textContent = badWords.length;
  for (const w of [...badWords].sort((a, b) => a.localeCompare(b, "ko"))) {
    const chip = el("span", "chip", w);
    const x = el("button", null, "✕"); x.title = "목록에서 빼기";
    x.onclick = () => saveBadWords(badWords.filter((v) => v !== w));
    chip.append(x);
    box.append(chip);
  }
}
async function saveBadWords(words) {
  try { await backend.saveFilter([...new Set(words)].slice(0, 500)); toast("금지어 목록을 저장했어요"); }
  catch (e) { toast("저장하지 못했어요: " + e.message); }
}
$("filter-form").onsubmit = (e) => {
  e.preventDefault();
  const add = $("filter-input").value.split(/[,\n]+/).map((x) => x.trim()).filter((x) => x && x.length <= 30);
  if (!add.length) return;
  $("filter-input").value = "";
  saveBadWords([...badWords, ...add]);
};
$("filter-reset").onclick = () => { if (confirm("금지어 목록을 처음 기본 목록으로 되돌릴까요?")) saveBadWords(DEFAULT_BAD_WORDS); };

// ----- 💾 저장 공간 -----
const FREE_LIMIT_MB = 1024;
let storageFiles = null;
const mb = (b) => (b / 1048576).toFixed(1);
$("storage-scan").onclick = async () => {
  $("storage-scan").disabled = true;
  $("storage-result").textContent = "확인하는 중…";
  try {
    storageFiles = await backend.scanStorage(groupRooms);
    renderStorage();
  } catch (e) {
    $("storage-result").textContent = "확인하지 못했어요: " + e.message;
  } finally {
    $("storage-scan").disabled = false;
  }
};
function oldFiles() {
  const days = Math.max(1, Number($("storage-days").value) || 30);
  const cut = Date.now() - days * 86400000;
  return (storageFiles || []).filter((f) => f.at.getTime() < cut);
}
function renderStorage() {
  if (!storageFiles) return;
  const total = storageFiles.reduce((a, f) => a + (f.size || 0), 0);
  const pct = Math.min(100, (total / 1048576 / FREE_LIMIT_MB) * 100);
  $("storage-bar").style.width = pct.toFixed(1) + "%";
  $("storage-bar").classList.toggle("warn", pct > 70);
  $("storage-result").textContent = `공유된 파일 ${storageFiles.length}개 · ${mb(total)}MB 사용 (무료 한도 ${FREE_LIMIT_MB}MB 중 약 ${pct.toFixed(1)}%)`;
  $("storage-clean").hidden = false;
  updateCleanButton();
}
function updateCleanButton() {
  const old = oldFiles();
  const size = old.reduce((a, f) => a + (f.size || 0), 0);
  $("storage-delete").disabled = !old.length;
  $("storage-delete").textContent = old.length ? `${old.length}개 (${mb(size)}MB) 지우기` : "지울 파일 없음";
}
$("storage-days").oninput = updateCleanButton;
$("storage-delete").onclick = async () => {
  const old = oldFiles();
  if (!old.length) return;
  const days = Math.max(1, Number($("storage-days").value) || 30);
  if (!confirm(`${days}일보다 오래된 파일 ${old.length}개를 지울까요?\n메시지는 남지만 파일은 더 이상 받을 수 없어요. (되돌릴 수 없어요)`)) return;
  $("storage-delete").disabled = true;
  try {
    await backend.deleteFiles(old, (n, all) => ($("storage-delete").textContent = `지우는 중… ${n}/${all}`));
    const ids = new Set(old.map((f) => f.id));
    storageFiles = storageFiles.filter((f) => !ids.has(f.id));
    for (const id of ids) blobUrlCache.delete(id);
    renderStorage();
    toast(`파일 ${old.length}개를 지웠어요`);
  } catch (e) {
    toast("지우지 못했어요: " + e.message);
    updateCleanButton();
  }
};

// ----- 👑 부관리자 (최고 관리자만) -----
function renderAdminList() {
  const ul = $("admin-list");
  ul.replaceChildren();
  if (!adminEmails.length) ul.append(el("li", "empty", "아직 부관리자가 없어요"));
  for (const email of [...adminEmails].sort()) {
    const li = el("li");
    li.append(el("span", "avatar emoji-avatar invite-avatar", "👑"));
    const info = el("div", "user-info");
    const found = userByEmail(email);
    info.append(el("div", "user-name", found ? displayName(found[0], found[1].name) : email), el("div", "user-email", found ? email : "아직 로그인 안 함"));
    li.append(info);
    const del = el("button", "pill-btn danger", "관리자 해제");
    del.onclick = async () => {
      if (!confirm(`${email}의 관리자 권한을 해제할까요?`)) return;
      try { await backend.removeAdmin(email); toast("관리자 권한을 해제했어요"); } catch (e) { toast("실패했어요: " + e.message); }
    };
    li.append(del);
    ul.append(li);
  }
}
$("admin-form").onsubmit = async (e) => {
  e.preventDefault();
  const email = $("admin-input").value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return toast("이메일 형식이 아니에요");
  if (email === me.email.toLowerCase()) return toast("본인은 이미 최고 관리자예요");
  if (!confirm(`${email}을(를) 부관리자로 추가할까요?\n부관리자는 초대·차단·방 관리·메시지 삭제를 할 수 있어요.`)) return;
  try {
    await backend.addAdmin(email);
    if (!invitesMap.has(email)) await backend.invite([email]); // 관리자는 당연히 들어올 수 있게
    $("admin-input").value = "";
    toast("부관리자로 추가했어요. 그 사람이 새로고침하면 👑가 보여요.");
  } catch (err) {
    toast("추가하지 못했어요: " + err.message);
  }
};
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
function mailInvite(email) {
  const url = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(`[${SITE_TITLE}] 초대장이 도착했어요`)}&body=${encodeURIComponent(inviteText(email))}`;
  location.href = url;
}

$("invite-form").onsubmit = async (e) => {
  e.preventDefault();
  const raw = $("invite-input").value;
  const emails = [...new Set(raw.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const bad = emails.filter((x) => !EMAIL_RE.test(x));
  if (!emails.length) return toast("초대할 Gmail 주소를 입력해 주세요");
  if (bad.length) return toast("이메일 형식이 아니에요: " + bad.join(", "));
  try {
    await backend.invite(emails);
    $("invite-input").value = "";
    toast(`${emails.length}명을 초대했어요. 이제 그 계정으로 로그인할 수 있어요.`);
    if (emails.length === 1 && confirm(`${emails[0]}에게 초대 메일도 보낼까요?\n(메일 앱/Gmail이 열려요)`)) mailInvite(emails[0]);
  } catch (err) {
    toast("초대하지 못했어요: " + err.message);
  }
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
  try { await backend.invite(missing.map((u) => emailOf(u.uid))); toast(`${missing.length}명을 초대 목록에 추가했어요`); }
  catch (err) { toast("실패했어요: " + err.message); }
};

// 이미 사이트를 쓰고 있지만 초대 목록에 없는 사람 (초대 기능을 켜기 전에 가입한 사람)
function uninvitedUsers() {
  return Object.entries(users)
    .filter(([uid, u]) => !u.admin && emailOf(uid) && !invitesMap.has(emailOf(uid).toLowerCase()))
    .map(([uid, u]) => ({ uid, ...u }));
}
function userByEmail(email) {
  return Object.entries(users).find(([uid]) => emailOf(uid).toLowerCase() === email);
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
    info.append(el("div", "user-email", found ? `${email} · ✅ 가입함` : "⏳ 아직 로그인 안 함"));
    li.append(info);
    const mail = el("button", "pill-btn", "📧");
    mail.title = "초대 메일 보내기";
    mail.onclick = () => mailInvite(email);
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
    .filter((u) => !q || u.display.toLowerCase().includes(q) || emailOf(u.uid).toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q))
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
    const email = emailOf(u.uid);
    const notInvited = !u.admin && email && !invitesMap.has(email.toLowerCase());
    if (notInvited) nameLine.append(el("span", "banned-badge", "초대 안 됨"));
    info.append(nameLine, el("div", "user-email", email));
    li.append(info);
    if (notInvited) {
      const inv = el("button", "pill-btn", "초대");
      inv.onclick = async () => { try { await backend.invite([email]); toast("초대했어요"); } catch (e) { toast("실패했어요: " + e.message); } };
      li.append(inv);
    }
    if (u.uid !== me.uid && !u.admin) {
      const b = el("button", banned ? "pill-btn" : "pill-btn danger", banned ? "차단 해제" : "차단");
      b.onclick = async () => {
        if (!banned && !confirm(`${u.display}(${email}) 님을 차단할까요?\n차단하면 채팅방을 보거나 메시지를 보낼 수 없어요.`)) return;
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
    } else if (act === "settings") {
      openRoomDialog(room);
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
