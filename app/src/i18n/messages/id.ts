import type { Messages } from "../types.js";

/** Indonesian — machine-assisted, reviewed. */
export const id: Messages = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "Bahasa",
    loading: "Memuat…",
    retry: "Segarkan untuk mencoba lagi.",
  },
  login: {
    title: "Hubungkan akun Telegram Anda",
    usernameLabel: "Nama pengguna Anda",
    usernamePlaceholder: "your_username",
    startButton: "Mulai Masuk dengan QR",
    step1: "Masukkan nama pengguna Anda",
    step2: "Pindai kode QR dengan Telegram",
    step3: "Buka Telegram › Pengaturan › Perangkat › Tautkan Perangkat Desktop",
    connecting: "Menghubungkan…",
    connected: "Terhubung!",
    sessionSaved: "Sesi disimpan. Anda dapat menutup halaman ini.",
    connectionLost: "Koneksi terputus. Segarkan untuk mencoba lagi.",
  },
  settings: {
    title: "Pengaturan",
    subtitle: "Kelola koneksi Anda",
    accountSection: "Akun",
    save: "Simpan",
    saved: "Tersimpan",
    disconnect: "Putuskan",
    disconnectConfirm: "Ini akan mengeluarkan Anda dari Telegram di server ini. Lanjutkan?",
  },
  uploads: {
    title: "Unggahan",
    subtitle: "File yang disiapkan untuk dikirim melalui AI",
    dropzone: "Jatuhkan file di sini atau klik untuk memilih",
    uploading: "Mengunggah…",
    delete: "Hapus",
    empty: "Belum ada unggahan.",
    quota: "Kuota",
    expires: "Kedaluwarsa",
  },
  audit: {
    title: "Aktivitas",
    subtitle: "Panggilan alat terbaru pada akun Anda",
    empty: "Belum ada aktivitas.",
    tool: "Alat",
    client: "Klien",
    when: "Kapan",
  },
  addAccount: {
    title: "Tambahkan akun lain",
    subtitle: "Tautkan akun Telegram kedua",
    scanPrompt: "Pindai kode QR dengan akun Telegram yang ingin Anda tambahkan.",
  },
};
