import type { Messages } from "../types.js";

/** Arabic — machine-assisted, reviewed. RTL. */
export const ar: Messages = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "اللغة",
    loading: "جارٍ التحميل…",
    retry: "حدّث الصفحة للمحاولة مرة أخرى.",
  },
  login: {
    title: "اربط حساب Telegram الخاص بك",
    usernameLabel: "اسم المستخدم الخاص بك",
    usernamePlaceholder: "your_username",
    startButton: "تسجيل الدخول عبر رمز QR",
    step1: "أدخل اسم المستخدم الخاص بك",
    step2: "امسح رمز QR باستخدام Telegram",
    step3: "افتح Telegram ‹ الإعدادات ‹ الأجهزة ‹ ربط جهاز سطح المكتب",
    connecting: "جارٍ الاتصال…",
    connected: "تم الاتصال!",
    sessionSaved: "تم حفظ الجلسة. يمكنك إغلاق هذه الصفحة.",
    connectionLost: "انقطع الاتصال. حدّث الصفحة للمحاولة مرة أخرى.",
  },
  settings: {
    title: "الإعدادات",
    subtitle: "إدارة اتصالك",
    accountSection: "الحساب",
    save: "حفظ",
    saved: "تم الحفظ",
    disconnect: "قطع الاتصال",
    disconnectConfirm: "سيؤدي هذا إلى تسجيل خروجك من Telegram على هذا الخادم. هل تريد المتابعة؟",
  },
  uploads: {
    title: "الملفات المرفوعة",
    subtitle: "ملفات جاهزة للإرسال عبر الذكاء الاصطناعي",
    dropzone: "أفلِت ملفًا هنا أو انقر للاختيار",
    uploading: "جارٍ الرفع…",
    delete: "حذف",
    empty: "لا توجد ملفات مرفوعة بعد.",
    quota: "الحصة",
    expires: "ينتهي",
  },
  audit: {
    title: "النشاط",
    subtitle: "آخر استدعاءات الأدوات على حسابك",
    empty: "لا يوجد نشاط بعد.",
    tool: "الأداة",
    client: "العميل",
    when: "متى",
  },
  addAccount: {
    title: "إضافة حساب آخر",
    subtitle: "اربط حساب Telegram ثانيًا",
    scanPrompt: "امسح رمز QR باستخدام حساب Telegram الذي تريد إضافته.",
  },
};
