import type { Messages } from "../types.js";

/** Spanish — machine-assisted, reviewed. */
export const es: Messages = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "Idioma",
    loading: "Cargando…",
    retry: "Actualiza para reintentar.",
  },
  login: {
    title: "Conecta tu cuenta de Telegram",
    usernameLabel: "Tu nombre de usuario",
    usernamePlaceholder: "your_username",
    startButton: "Iniciar sesión con QR",
    step1: "Introduce tu nombre de usuario",
    step2: "Escanea el código QR con Telegram",
    step3: "Abre Telegram › Ajustes › Dispositivos › Vincular dispositivo de escritorio",
    connecting: "Conectando…",
    connected: "¡Conectado!",
    sessionSaved: "Sesión guardada. Puedes cerrar esta página.",
    connectionLost: "Conexión perdida. Actualiza para reintentar.",
  },
  settings: {
    title: "Ajustes",
    subtitle: "Gestiona tu conexión",
    accountSection: "Cuenta",
    save: "Guardar",
    saved: "Guardado",
    disconnect: "Desconectar",
    disconnectConfirm: "Esto cierra tu sesión de Telegram en este servidor. ¿Continuar?",
  },
  uploads: {
    title: "Archivos",
    subtitle: "Archivos preparados para enviar mediante IA",
    dropzone: "Suelta un archivo aquí o haz clic para elegir",
    uploading: "Subiendo…",
    delete: "Eliminar",
    empty: "Aún no hay archivos.",
    quota: "Cuota",
    expires: "Caduca",
  },
  audit: {
    title: "Actividad",
    subtitle: "Llamadas recientes de herramientas en tu cuenta",
    empty: "Aún no hay actividad.",
    tool: "Herramienta",
    client: "Cliente",
    when: "Cuándo",
  },
  addAccount: {
    title: "Añadir otra cuenta",
    subtitle: "Vincula una segunda cuenta de Telegram",
    scanPrompt: "Escanea el código QR con la cuenta de Telegram que quieres añadir.",
  },
};
