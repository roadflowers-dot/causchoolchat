# 중대부초 실시간 채팅방 (causchoolchat)

학생용 실시간 채팅 웹사이트입니다. 사이트 주소: https://causchoolchat.web.app

## 기능
- 구글 계정 로그인
- 채팅방 만들기 (누구나), 방마다 색깔 아이콘·마지막 메시지 미리보기
- 실시간 메시지, 날짜 구분선, 링크 자동 연결, 이모지만 보내면 크게 표시
- **이전 메시지 더 보기** (한 번에 50개씩)
- **답장 / 이모지 반응(👍❤️😂😮😢🎉, 한 사람당 하나) / 내 메시지 삭제**
  - PC: 메시지에 마우스를 올리면 버튼 표시 · 모바일: 메시지를 누르거나 길게 누르기
- **새 메시지 알림**: 안 읽은 방에 빨간 점, 탭 제목에 `(숫자)`, 🔔 버튼으로 브라우저 알림 켜기
  (사이트가 열려 있을 때만 알림이 와요. 무료 요금제에서는 앱을 닫은 상태의 푸시 알림은 불가)
- 파일 공유 (5MB까지), 이미지 미리보기, 📎 파일함
- **다크 모드** (기기 설정 자동 적용 + 🌙/☀️ 버튼으로 전환)
- **프로필 수정**: 왼쪽 아래 내 이름 → 닉네임, 프로필 사진(구글 사진 / 이모지 / 사진 올리기)
- **앱 설치 (PWA)**: 📲 앱으로 설치하기 버튼 → 홈 화면·바탕화면에 아이콘, 전체 화면으로 실행
- **관리자 모드** (관리자 이메일로 로그인하면 자동): 👑 사용자 차단/해제, 모든 메시지 삭제,
  ⋯ 메뉴로 공지 고정·방 이름 변경·방 삭제. 관리자 이메일은 `firestore.rules`의 `isAdmin()`에서 바꿔요.
- **초대 전용**: 관리자가 👑 → ✉️ 초대 관리에서 초대한 Gmail 계정만 들어올 수 있어요.
  등록 안 된 계정은 사이트에는 들어오지만 채팅방·친구 목록이 보이지 않고 "입장 대기 중" 화면이 나와요
  (보안 규칙에서도 모든 채팅 데이터 읽기/쓰기가 막힘). 이때 관리자에게 **🚪 외부 사람 입장 알림**이 오고
  (👑에 빨간 숫자 + 알림), 관리자가 **초대** 또는 **차단**을 누를 수 있어요. 초대하면 그 사람 화면에 바로 채팅방이 열려요.
  📧 버튼으로 초대 메일 보내기, 📋 초대 문구 복사 가능.
- **1:1 채팅**: 방 목록의 "1:1 채팅 ＋" 또는 단체방에서 친구 프로필 사진을 누르면 시작.
  두 사람만 볼 수 있어요 (관리자도 볼 수 없음). `dms/dm_{uid1}_{uid2}`에 저장.
- **나쁜 말 필터**: 금지어는 보낼 때 `**`로 가려짐 (띄어쓰기·기호 섞어도 찾아냄). 관리자 메뉴 🚫 금지어에서 추가/삭제.
- **채팅방은 관리자만 생성**. 🌐 공개 방 / 🔒 멤버만 보이는 비공개 방. 채팅방 ⋯ → ⚙️ 방 설정에서 멤버 변경.
- **부관리자**: 최고 관리자가 관리자 메뉴 👑 부관리자 탭에서 이메일로 추가/해제 (최고 관리자 이메일은 `firestore.rules`의 `isOwner()`).
- **메시지 수정** (내 글, "(수정됨)" 표시), **"OO님이 입력 중…"** 표시, **📊 투표** (2~6개 선택지, 마감 가능).
- **저장 공간 관리**: 관리자 메뉴 💾 저장 공간 → 사용량 확인, N일 지난 파일 지우기.
- 데모 모드(`?demo`)는 개발용 컴퓨터(localhost)에서만 켜지고, 실제 사이트에는 올라가지 않아요.

## 구성

**Firebase 무료(Spark) 요금제 안에서만 동작**하도록 만들었습니다. 결제 수단 등록이 필요 없습니다.

| 기능 | 사용 기술 |
| --- | --- |
| 구글 로그인 | Firebase Authentication |
| 실시간 채팅 | Cloud Firestore (`onSnapshot`) |
| 파일 공유 | Cloud Firestore에 900KB 조각으로 나눠 저장 (파일당 5MB 제한) |
| 호스팅 | Firebase Hosting |

> Cloud Storage for Firebase는 이제 유료(Blaze) 요금제에서만 쓸 수 있어서 사용하지 않습니다.

### 무료 한도 (Spark 요금제, 하루 기준)

| 항목 | 한도 | 이 앱에서 쓰는 곳 |
| --- | --- | --- |
| Firestore 저장 용량 | 총 1 GiB | 메시지 + **공유 파일** (5MB 파일 약 200개 분량) |
| Firestore 읽기 | 5만 회/일 | 방 입장 시 최근 메시지 50개, 새 메시지 1개마다 (그 방을 보는 사람 수 + 접속자 수)회, 파일 받기 시 조각 수만큼 |
| Firestore 쓰기 | 2만 회/일 | 메시지 2회(메시지 + 방 미리보기), 반응 1회, 파일은 조각 수 + 3회 |
| Hosting 전송량 | 360 MB/일 | 웹페이지 파일 (매우 작음) |

한도를 넘으면 요금이 나가는 게 아니라 **그날은 해당 기능이 멈추고** 다음 날 초기화됩니다.
Firebase 콘솔 → 사용량 및 결제에서 사용량을 확인할 수 있습니다.

빌드 도구 없이 HTML/CSS/JS만으로 되어 있습니다.

```
public/
  index.html               로그인 화면 + 채팅 화면 (방 목록 / 메시지 / 파일함)
  sw.js                    알림을 눌렀을 때 채팅 화면으로 이동 (서비스 워커)
  css/style.css            스타일 (모바일 대응)
  js/app.js                화면 로직
  js/firebase-config.js    Firebase 설정값, 허용 도메인, 파일 크기 제한
  js/backend-firebase.js   실제 서비스용 (Auth + Firestore)
  js/backend-demo.js       설정 전 화면 확인용 가짜 데이터
firestore.rules            DB 보안 규칙
```

## 데이터 구조

```
users/{uid}                          name, email, photo, lastSeen
users/{uid}                          name, email, photo, nickname, avatar("emoji:🐶" | data:image/jpeg...), admin
banned/{uid}                         by, at   (관리자만 추가/삭제)
invites/{소문자 이메일}               by, at   (관리자만 추가/삭제)
pending/{uid}                        email, name, photo, at   (등록 안 된 사람의 입장 요청. 본인만 작성, 관리자만 목록/삭제)
dms/dm_{작은uid}_{큰uid}              members[2], createdAt, lastMessageAt, lastMessage  (+ messages, files 하위 구조는 rooms와 같음)
rooms/{roomId}                       name, createdBy, createdAt, visibility("public"|"private"), members[],
                                     lastMessageAt, lastMessage{uid,name,text}, notice{text}
rooms|dms/{id}/typing/{uid}          at   ("입력 중" 표시)
admins/{소문자 이메일}                by, at   (부관리자, 최고 관리자만 추가/삭제)
config/filter                        words[]   (금지어, 관리자만 수정)
fileIndex/{fileId}                   kind, roomId, size, chunkCount, uid, at   (저장 공간 관리용, 관리자만 열람)
rooms/{roomId}/messages/{msgId}      type("text"|"file"), text, file{id,name,size,contentType},
                                     replyTo{id,name,text}, reactions{uid: 이모지}, editedAt,
                                     poll{question,options[]}, votes{uid: 번호}, closed,
                                     uid, name, photo, createdAt
rooms/{roomId}/files/{fileId}        name, size, contentType, chunkCount, uid, uploaderName, createdAt
rooms/{roomId}/files/{fileId}/chunks/{0,1,..}   i, uid, data(bytes, 최대 900KB)
```

## 실행

### 1. 화면만 확인 (데모 모드)
```bash
cd public && python3 -m http.server 8000
# http://localhost:8000
```

### 2. 실제 서비스 연결
1. [Firebase 콘솔](https://console.firebase.google.com)에서 프로젝트 생성
2. Authentication → 로그인 방법 → **Google** 사용 설정
3. Firestore Database 생성 (Storage는 만들지 않아도 됩니다. 요금제는 **Spark 그대로** 두세요)
4. 프로젝트 설정 → 웹 앱 추가 → 설정값을 `public/js/firebase-config.js`에 붙여넣기
5. (선택) 학교 계정만 허용: `ALLOWED_EMAIL_DOMAIN`과 `firestore.rules`의 주석 부분에 도메인 입력
6. 배포
   ```bash
   npm i -g firebase-tools
   firebase login
   firebase use --add
   firebase deploy
   ```

## 보안
- **데이터베이스**: 모든 데이터는 보안 규칙(`firestore.rules`)으로 서버에서 막혀 있어요.
  로그인 안 한 사람·이메일 인증 안 된 계정·등록(초대) 안 된 사람·차단된 사람은 채팅 데이터를 읽거나 쓸 수 없어요.
- **이메일 비공개**: 학생 이메일은 프로필(`users`)에 넣지 않고 `emails`에 따로 보관 → 본인과 관리자만 볼 수 있어요.
- **관리자 이메일**은 보안 규칙에만 있고 웹사이트 코드에는 없어요.
- **보안 헤더**: 다른 사이트가 우리 사이트를 몰래 화면에 넣는 것(클릭재킹) 차단 등 (`firebase.json`).
- 웹사이트 코드(HTML/CSS/JS)는 웹의 특성상 누구나 볼 수 있지만, 코드만으로는 데이터에 접근할 수 없어요.
  Firebase 설정값(apiKey)도 공개용 값이에요.
