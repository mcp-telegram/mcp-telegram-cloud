import type { Messages } from "../types.js";

/** Polish — machine-assisted, reviewed. */
export const pl: Messages = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "Język",
    loading: "Ładowanie…",
    retry: "Odśwież, aby spróbować ponownie.",
  },
  login: {
    title: "Połącz swoje konto Telegram",
    usernameLabel: "Twoja nazwa użytkownika",
    usernamePlaceholder: "your_username",
    startButton: "Zaloguj się kodem QR",
    step1: "Wpisz swoją nazwę użytkownika",
    step2: "Zeskanuj kod QR w Telegramie",
    step3: "Otwórz Telegram › Ustawienia › Urządzenia › Połącz urządzenie stacjonarne",
    connecting: "Łączenie…",
    connected: "Połączono!",
    sessionSaved: "Sesja zapisana. Możesz zamknąć tę stronę.",
    connectionLost: "Utracono połączenie. Odśwież, aby spróbować ponownie.",
  },
  settings: {
    title: "Ustawienia",
    subtitle: "Zarządzaj połączeniem",
    accountSection: "Konto",
    save: "Zapisz",
    saved: "Zapisano",
    disconnect: "Rozłącz",
    disconnectConfirm: "Spowoduje to wylogowanie z Telegrama na tym serwerze. Kontynuować?",
  },
  uploads: {
    title: "Pliki",
    subtitle: "Pliki przygotowane do wysłania przez SI",
    dropzone: "Upuść plik tutaj lub kliknij, aby wybrać",
    uploading: "Przesyłanie…",
    delete: "Usuń",
    empty: "Brak plików.",
    quota: "Limit",
    expires: "Wygasa",
  },
  audit: {
    title: "Aktywność",
    subtitle: "Ostatnie wywołania narzędzi na Twoim koncie",
    empty: "Brak aktywności.",
    tool: "Narzędzie",
    client: "Klient",
    when: "Kiedy",
  },
  addAccount: {
    title: "Dodaj kolejne konto",
    subtitle: "Połącz drugie konto Telegram",
    scanPrompt: "Zeskanuj kod QR kontem Telegram, które chcesz dodać.",
  },
};
