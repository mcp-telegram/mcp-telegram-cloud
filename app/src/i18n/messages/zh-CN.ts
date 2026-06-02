import type { Messages } from "../types.js";

/** Simplified Chinese — machine-assisted, reviewed. */
export const zhCN: Messages = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "语言",
    loading: "加载中…",
    retry: "刷新以重试。",
  },
  login: {
    title: "连接你的 Telegram 账号",
    usernameLabel: "你的用户名",
    usernamePlaceholder: "your_username",
    startButton: "开始二维码登录",
    step1: "输入你的用户名",
    step2: "用 Telegram 扫描二维码",
    step3: "打开 Telegram › 设置 › 设备 › 关联桌面设备",
    connecting: "连接中…",
    connected: "已连接！",
    sessionSaved: "会话已保存。你可以关闭此页面。",
    connectionLost: "连接已断开。刷新以重试。",
  },
  settings: {
    title: "设置",
    subtitle: "管理你的连接",
    accountSection: "账号",
    save: "保存",
    saved: "已保存",
    disconnect: "断开连接",
    disconnectConfirm: "这将使你在此服务器上退出 Telegram。是否继续？",
  },
  uploads: {
    title: "上传",
    subtitle: "已准备好通过 AI 发送的文件",
    dropzone: "将文件拖放到此处，或点击选择",
    uploading: "上传中…",
    delete: "删除",
    empty: "暂无上传。",
    quota: "配额",
    expires: "到期",
  },
  audit: {
    title: "活动",
    subtitle: "你账号上最近的工具调用",
    empty: "暂无活动。",
    tool: "工具",
    client: "客户端",
    when: "时间",
  },
  addAccount: {
    title: "添加另一个账号",
    subtitle: "关联第二个 Telegram 账号",
    scanPrompt: "用你想添加的 Telegram 账号扫描二维码。",
  },
};
