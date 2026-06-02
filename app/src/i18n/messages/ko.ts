import type { Messages } from "../types.js";

/** Korean — machine-assisted, reviewed. */
export const ko: Messages = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "언어",
    loading: "불러오는 중…",
    retry: "다시 시도하려면 새로고침하세요.",
  },
  login: {
    title: "Telegram 계정 연결",
    usernameLabel: "사용자 이름",
    usernamePlaceholder: "your_username",
    startButton: "QR 로그인 시작",
    step1: "사용자 이름을 입력하세요",
    step2: "Telegram으로 QR 코드를 스캔하세요",
    step3: "Telegram › 설정 › 기기 › 데스크톱 기기 연결을 여세요",
    connecting: "연결 중…",
    connected: "연결됨!",
    sessionSaved: "세션이 저장되었습니다. 이 페이지를 닫아도 됩니다.",
    connectionLost: "연결이 끊겼습니다. 다시 시도하려면 새로고침하세요.",
  },
  settings: {
    title: "설정",
    subtitle: "연결 관리",
    accountSection: "계정",
    save: "저장",
    saved: "저장됨",
    disconnect: "연결 해제",
    disconnectConfirm: "이 서버에서 Telegram 로그아웃됩니다. 계속하시겠습니까?",
  },
  uploads: {
    title: "업로드",
    subtitle: "AI를 통해 전송하도록 준비된 파일",
    dropzone: "여기에 파일을 끌어다 놓거나 클릭하여 선택하세요",
    uploading: "업로드 중…",
    delete: "삭제",
    empty: "아직 업로드가 없습니다.",
    quota: "할당량",
    expires: "만료",
  },
  audit: {
    title: "활동",
    subtitle: "계정의 최근 도구 호출",
    empty: "아직 활동이 없습니다.",
    tool: "도구",
    client: "클라이언트",
    when: "시간",
  },
  addAccount: {
    title: "다른 계정 추가",
    subtitle: "두 번째 Telegram 계정 연결",
    scanPrompt: "추가하려는 Telegram 계정으로 QR 코드를 스캔하세요.",
  },
};
