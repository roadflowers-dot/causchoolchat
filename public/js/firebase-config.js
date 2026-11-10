// Firebase 콘솔 → 프로젝트 설정 → 내 앱(웹)에서 복사한 값을 붙여넣으세요.
// 값이 "YOUR_..." 그대로면 데모 모드(브라우저 안에서만 동작)로 실행됩니다.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// 학교 도메인 계정만 허용하려면 입력하세요. 예: "school.hs.kr"
// 빈 문자열이면 모든 구글 계정 허용.
// (보안 규칙 firestore.rules에도 같은 도메인을 넣어야 실제로 막힙니다.)
export const ALLOWED_EMAIL_DOMAIN = "";

// 파일 업로드 최대 크기 (MB)
// 무료 요금제의 Firestore 저장 용량은 총 1GiB라서 작게 유지하세요. (firestore.rules의 청크 개수 제한과 맞춰야 함)
export const MAX_FILE_MB = 5;
