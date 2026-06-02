/**
 * English message catalog — the SOURCE OF TRUTH for the message shape.
 *
 * `satisfies Messages` is intentionally NOT applied here: this object DEFINES
 * the `Messages` type (see ../types.ts), so every other locale is checked
 * against the exact key set and value types declared here. Add a key here and
 * TypeScript immediately flags every locale that lacks it.
 *
 * Backend functional pages only (login, settings, uploads, audit, add-account).
 * Marketing-site copy lives in `web/messages` — a separate domain, not mixed in.
 */
export const en = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "Language",
    loading: "Loading…",
    retry: "Refresh to retry.",
    qrLoading: "Loading QR code…",
    connectionLost: "Connection lost. Refresh to retry.",
    redirecting: "Redirecting…",
  },
  login: {
    title: "Connect your Telegram account",
    usernameLabel: "Your username",
    usernamePlaceholder: "your_username",
    startButton: "Start QR Login",
    step1: "Enter your username",
    step2: "Scan the QR code with Telegram",
    step3: "Open Telegram › Settings › Devices › Link Desktop Device",
    connecting: "Connecting…",
    connected: "Connected!",
    sessionSaved: "Session saved. You can close this page.",
    connectionLost: "Connection lost. Refresh to retry.",
  },
  settings: {
    title: "Settings",
    subtitle: "Manage your connection",
    accountSection: "Account",
    save: "Save",
    saved: "Saved",
    disconnect: "Disconnect",
    disconnectConfirm: "This logs you out of Telegram on this server. Continue?",
  },
  uploads: {
    title: "Uploads",
    subtitle: "Files staged for sending via AI",
    dropzone: "Drop a file here or click to choose",
    uploading: "Uploading…",
    uploaded: "Uploaded.",
    uploadFailed: "Upload failed",
    networkError: "Network error",
    delete: "Delete",
    empty: "No pending uploads. Drop a file above to begin.",
    quota: "Quota",
    quotaPending: "pending",
    expires: "Expires",
    uploadId: "Upload ID",
    file: "File",
    size: "Size",
    mime: "MIME",
    copy: "copy",
    copied: "copied",
  },
  audit: {
    title: "Activity",
    subtitle: "Recent tool calls on your account",
    empty: "No activity yet.",
    tool: "Tool",
    client: "Client",
    when: "When",
  },
  addAccount: {
    title: "Add Telegram account",
    subtitle: "Attach a second Telegram identity to your AI assistant.",
    scanPrompt: "Scan the QR code with the Telegram account you want to add.",
    step1: "Open Telegram with the account you want to add (any device)",
    step2: "Settings › Devices › Link Desktop Device",
    step3: "Click below and scan the QR",
    startScan: "Start QR scan",
    added: "Account added",
    accountActive: "It is now the active account in your AI client. You can close this tab.",
    errorRetry: "Return to your AI client and run telegram-accounts-add again to get a fresh link.",
  },
} as const;
