import type { Messages } from "../types.js";

/** Dutch — machine-assisted, reviewed. */
export const nl: Messages = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "Taal",
    loading: "Laden…",
    retry: "Vernieuw om opnieuw te proberen.",
  },
  login: {
    title: "Verbind je Telegram-account",
    usernameLabel: "Je gebruikersnaam",
    usernamePlaceholder: "your_username",
    startButton: "Inloggen met QR",
    step1: "Voer je gebruikersnaam in",
    step2: "Scan de QR-code met Telegram",
    step3: "Open Telegram › Instellingen › Apparaten › Desktopapparaat koppelen",
    connecting: "Verbinden…",
    connected: "Verbonden!",
    sessionSaved: "Sessie opgeslagen. Je kunt deze pagina sluiten.",
    connectionLost: "Verbinding verbroken. Vernieuw om opnieuw te proberen.",
  },
  settings: {
    title: "Instellingen",
    subtitle: "Beheer je verbinding",
    accountSection: "Account",
    save: "Opslaan",
    saved: "Opgeslagen",
    disconnect: "Verbinding verbreken",
    disconnectConfirm: "Hiermee word je op deze server uitgelogd bij Telegram. Doorgaan?",
  },
  uploads: {
    title: "Bestanden",
    subtitle: "Bestanden klaargezet om via AI te verzenden",
    dropzone: "Sleep een bestand hierheen of klik om te kiezen",
    uploading: "Uploaden…",
    delete: "Verwijderen",
    empty: "Nog geen bestanden.",
    quota: "Quota",
    expires: "Verloopt",
  },
  audit: {
    title: "Activiteit",
    subtitle: "Recente toolaanroepen op je account",
    empty: "Nog geen activiteit.",
    tool: "Tool",
    client: "Client",
    when: "Wanneer",
  },
  addAccount: {
    title: "Nog een account toevoegen",
    subtitle: "Koppel een tweede Telegram-account",
    scanPrompt: "Scan de QR-code met het Telegram-account dat je wilt toevoegen.",
  },
};
