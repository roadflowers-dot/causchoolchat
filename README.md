# 학교 채팅 (causchoolchat)

학생용 실시간 채팅 웹사이트입니다. 구글 계정 로그인, 채팅방, 파일 공유를 지원합니다.

## 구성

| 기능 | 사용 기술 |
| --- | --- |
| 구글 로그인 | Firebase Authentication |
| 실시간 채팅 | Cloud Firestore (`onSnapshot`) |
| 파일 공유 | Firebase Storage (기본 10MB 제한) |
| 호스팅 | Firebase Hosting |

빌드 도구 없이 HTML/CSS/JS만으로 되어 있습니다.

```
public/
  index.html               로그인 화면 + 채팅 화면 (방 목록 / 메시지 / 파일함)
  css/style.css            스타일 (모바일 대응)
  js/app.js                화면 로직
  js/firebase-config.js    Firebase 설정값, 허용 도메인, 파일 크기 제한
  js/backend-firebase.js   실제 서비스용 (Auth + Firestore + Storage)
  js/backend-demo.js       설정 전 화면 확인용 가짜 데이터
firestore.rules            DB 보안 규칙
storage.rules              파일 보안 규칙
```

## 데이터 구조

```
users/{uid}                          name, email, photo, lastSeen
rooms/{roomId}                       name, createdBy, createdAt
rooms/{roomId}/messages/{msgId}      type("text"|"file"), text, file{name,size,contentType,url,path},
                                     uid, name, photo, createdAt
Storage: rooms/{roomId}/{uid}/{시간}_{파일명}
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
3. Firestore Database, Storage 생성
4. 프로젝트 설정 → 웹 앱 추가 → 설정값을 `public/js/firebase-config.js`에 붙여넣기
5. (선택) 학교 계정만 허용: `ALLOWED_EMAIL_DOMAIN`과 `firestore.rules`, `storage.rules`의 주석 부분에 도메인 입력
6. 배포
   ```bash
   npm i -g firebase-tools
   firebase login
   firebase use --add
   firebase deploy
   ```
