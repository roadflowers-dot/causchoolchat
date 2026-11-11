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
- 주소 끝에 `?demo`를 붙이면 실제 데이터에 영향 없는 연습 화면

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
rooms/{roomId}                       name, createdBy, createdAt, lastMessageAt, lastMessage{uid,name,text}
rooms/{roomId}/messages/{msgId}      type("text"|"file"), text, file{id,name,size,contentType},
                                     replyTo{id,name,text}, reactions{uid: 이모지},
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
