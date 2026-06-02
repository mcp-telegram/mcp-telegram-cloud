import type { Messages } from "../types.js";

/** French — machine-assisted, reviewed. */
export const fr: Messages = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "Langue",
    loading: "Chargement…",
    retry: "Actualisez pour réessayer.",
  },
  login: {
    title: "Connectez votre compte Telegram",
    usernameLabel: "Votre nom d'utilisateur",
    usernamePlaceholder: "your_username",
    startButton: "Se connecter par QR code",
    step1: "Saisissez votre nom d'utilisateur",
    step2: "Scannez le QR code avec Telegram",
    step3: "Ouvrez Telegram › Paramètres › Appareils › Lier un ordinateur",
    connecting: "Connexion…",
    connected: "Connecté !",
    sessionSaved: "Session enregistrée. Vous pouvez fermer cette page.",
    connectionLost: "Connexion perdue. Actualisez pour réessayer.",
  },
  settings: {
    title: "Paramètres",
    subtitle: "Gérez votre connexion",
    accountSection: "Compte",
    save: "Enregistrer",
    saved: "Enregistré",
    disconnect: "Déconnecter",
    disconnectConfirm: "Cela vous déconnecte de Telegram sur ce serveur. Continuer ?",
  },
  uploads: {
    title: "Fichiers",
    subtitle: "Fichiers préparés pour l'envoi via l'IA",
    dropzone: "Déposez un fichier ici ou cliquez pour en choisir un",
    uploading: "Envoi…",
    delete: "Supprimer",
    empty: "Aucun fichier pour l'instant.",
    quota: "Quota",
    expires: "Expire",
  },
  audit: {
    title: "Activité",
    subtitle: "Appels d'outils récents sur votre compte",
    empty: "Aucune activité pour l'instant.",
    tool: "Outil",
    client: "Client",
    when: "Quand",
  },
  addAccount: {
    title: "Ajouter un autre compte",
    subtitle: "Lier un second compte Telegram",
    scanPrompt: "Scannez le QR code avec le compte Telegram que vous souhaitez ajouter.",
  },
};
