import type { Messages } from "../types.js";

/** Vietnamese — machine-assisted, reviewed. */
export const vi: Messages = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "Ngôn ngữ",
    loading: "Đang tải…",
    retry: "Làm mới để thử lại.",
  },
  login: {
    title: "Kết nối tài khoản Telegram của bạn",
    usernameLabel: "Tên người dùng của bạn",
    usernamePlaceholder: "your_username",
    startButton: "Bắt đầu đăng nhập bằng QR",
    step1: "Nhập tên người dùng của bạn",
    step2: "Quét mã QR bằng Telegram",
    step3: "Mở Telegram › Cài đặt › Thiết bị › Liên kết thiết bị máy tính",
    connecting: "Đang kết nối…",
    connected: "Đã kết nối!",
    sessionSaved: "Đã lưu phiên. Bạn có thể đóng trang này.",
    connectionLost: "Mất kết nối. Làm mới để thử lại.",
  },
  settings: {
    title: "Cài đặt",
    subtitle: "Quản lý kết nối của bạn",
    accountSection: "Tài khoản",
    save: "Lưu",
    saved: "Đã lưu",
    disconnect: "Ngắt kết nối",
    disconnectConfirm: "Thao tác này sẽ đăng xuất bạn khỏi Telegram trên máy chủ này. Tiếp tục?",
  },
  uploads: {
    title: "Tệp tải lên",
    subtitle: "Tệp đã sẵn sàng để gửi qua AI",
    dropzone: "Thả tệp vào đây hoặc nhấp để chọn",
    uploading: "Đang tải lên…",
    delete: "Xóa",
    empty: "Chưa có tệp tải lên.",
    quota: "Hạn mức",
    expires: "Hết hạn",
  },
  audit: {
    title: "Hoạt động",
    subtitle: "Các lệnh gọi công cụ gần đây trên tài khoản của bạn",
    empty: "Chưa có hoạt động.",
    tool: "Công cụ",
    client: "Ứng dụng khách",
    when: "Khi nào",
  },
  addAccount: {
    title: "Thêm tài khoản khác",
    subtitle: "Liên kết tài khoản Telegram thứ hai",
    scanPrompt: "Quét mã QR bằng tài khoản Telegram mà bạn muốn thêm.",
  },
};
