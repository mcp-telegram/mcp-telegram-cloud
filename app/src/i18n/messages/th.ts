import type { Messages } from "../types.js";

/** Thai — machine-assisted, reviewed. */
export const th: Messages = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "ภาษา",
    loading: "กำลังโหลด…",
    retry: "รีเฟรชเพื่อลองอีกครั้ง",
  },
  login: {
    title: "เชื่อมต่อบัญชี Telegram ของคุณ",
    usernameLabel: "ชื่อผู้ใช้ของคุณ",
    usernamePlaceholder: "your_username",
    startButton: "เริ่มเข้าสู่ระบบด้วย QR",
    step1: "กรอกชื่อผู้ใช้ของคุณ",
    step2: "สแกนรหัส QR ด้วย Telegram",
    step3: "เปิด Telegram › การตั้งค่า › อุปกรณ์ › เชื่อมโยงอุปกรณ์เดสก์ท็อป",
    connecting: "กำลังเชื่อมต่อ…",
    connected: "เชื่อมต่อแล้ว!",
    sessionSaved: "บันทึกเซสชันแล้ว คุณสามารถปิดหน้านี้ได้",
    connectionLost: "การเชื่อมต่อขาดหาย รีเฟรชเพื่อลองอีกครั้ง",
  },
  settings: {
    title: "การตั้งค่า",
    subtitle: "จัดการการเชื่อมต่อของคุณ",
    accountSection: "บัญชี",
    save: "บันทึก",
    saved: "บันทึกแล้ว",
    disconnect: "ตัดการเชื่อมต่อ",
    disconnectConfirm: "การดำเนินการนี้จะออกจากระบบ Telegram บนเซิร์ฟเวอร์นี้ ดำเนินการต่อหรือไม่?",
  },
  uploads: {
    title: "ไฟล์ที่อัปโหลด",
    subtitle: "ไฟล์ที่เตรียมไว้สำหรับส่งผ่าน AI",
    dropzone: "วางไฟล์ที่นี่หรือคลิกเพื่อเลือก",
    uploading: "กำลังอัปโหลด…",
    delete: "ลบ",
    empty: "ยังไม่มีไฟล์อัปโหลด",
    quota: "โควต้า",
    expires: "หมดอายุ",
  },
  audit: {
    title: "กิจกรรม",
    subtitle: "การเรียกใช้เครื่องมือล่าสุดในบัญชีของคุณ",
    empty: "ยังไม่มีกิจกรรม",
    tool: "เครื่องมือ",
    client: "ไคลเอ็นต์",
    when: "เมื่อใด",
  },
  addAccount: {
    title: "เพิ่มบัญชีอื่น",
    subtitle: "เชื่อมโยงบัญชี Telegram ที่สอง",
    scanPrompt: "สแกนรหัส QR ด้วยบัญชี Telegram ที่คุณต้องการเพิ่ม",
  },
};
