import type { Messages } from "../types.js";

/** Portuguese (Brazil) — machine-assisted, reviewed. */
export const ptBR: Messages = {
  common: {
    brandName: "MCP Telegram",
    languageLabel: "Idioma",
    loading: "Carregando…",
    retry: "Atualize para tentar novamente.",
  },
  login: {
    title: "Conecte sua conta do Telegram",
    usernameLabel: "Seu nome de usuário",
    usernamePlaceholder: "your_username",
    startButton: "Entrar com QR Code",
    step1: "Digite seu nome de usuário",
    step2: "Escaneie o QR code com o Telegram",
    step3: "Abra o Telegram › Configurações › Dispositivos › Vincular dispositivo desktop",
    connecting: "Conectando…",
    connected: "Conectado!",
    sessionSaved: "Sessão salva. Você pode fechar esta página.",
    connectionLost: "Conexão perdida. Atualize para tentar novamente.",
  },
  settings: {
    title: "Configurações",
    subtitle: "Gerencie sua conexão",
    accountSection: "Conta",
    save: "Salvar",
    saved: "Salvo",
    disconnect: "Desconectar",
    disconnectConfirm: "Isso desconecta você do Telegram neste servidor. Continuar?",
  },
  uploads: {
    title: "Arquivos",
    subtitle: "Arquivos preparados para envio via IA",
    dropzone: "Solte um arquivo aqui ou clique para escolher",
    uploading: "Enviando…",
    delete: "Excluir",
    empty: "Nenhum arquivo ainda.",
    quota: "Cota",
    expires: "Expira",
  },
  audit: {
    title: "Atividade",
    subtitle: "Chamadas de ferramentas recentes na sua conta",
    empty: "Nenhuma atividade ainda.",
    tool: "Ferramenta",
    client: "Cliente",
    when: "Quando",
  },
  addAccount: {
    title: "Adicionar outra conta",
    subtitle: "Vincular uma segunda conta do Telegram",
    scanPrompt: "Escaneie o QR code com a conta do Telegram que você deseja adicionar.",
  },
};
