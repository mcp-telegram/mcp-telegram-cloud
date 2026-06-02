import type { Messages } from "../types.js";

/** Traditional Chinese — machine-assisted, reviewed. */
export const zhTW: Messages = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "語言",
    loading: "載入中…",
    retry: "重新整理以重試。",
  },
  login: {
    title: "連接你的 Telegram 帳號",
    usernameLabel: "你的使用者名稱",
    usernamePlaceholder: "your_username",
    startButton: "開始 QR 碼登入",
    step1: "輸入你的使用者名稱",
    step2: "用 Telegram 掃描 QR 碼",
    step3: "開啟 Telegram › 設定 › 裝置 › 連結桌面裝置",
    connecting: "連接中…",
    connected: "已連接！",
    sessionSaved: "工作階段已儲存。你可以關閉此頁面。",
    connectionLost: "連線已中斷。重新整理以重試。",
  },
  settings: {
    title: "設定",
    subtitle: "管理你的連線",
    accountSection: "帳號",
    save: "儲存",
    saved: "已儲存",
    disconnect: "中斷連線",
    disconnectConfirm: "這將使你在此伺服器上登出 Telegram。是否繼續？",
  },
  uploads: {
    title: "上傳",
    subtitle: "已準備好透過 AI 傳送的檔案",
    dropzone: "將檔案拖放到此處，或點按以選擇",
    uploading: "上傳中…",
    delete: "刪除",
    empty: "尚無上傳。",
    quota: "配額",
    expires: "到期",
  },
  audit: {
    title: "活動",
    subtitle: "你帳號上最近的工具呼叫",
    empty: "尚無活動。",
    tool: "工具",
    client: "用戶端",
    when: "時間",
  },
  addAccount: {
    title: "新增另一個帳號",
    subtitle: "連結第二個 Telegram 帳號",
    scanPrompt: "用你想新增的 Telegram 帳號掃描 QR 碼。",
  },
};
