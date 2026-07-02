// Constantes da integração WhatsApp (Cloud API oficial da Meta / Graph API).
// Espelha o padrão de magalu-constants.ts. O módulo inteiro fica atrás da flag
// NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED (kill-switch global de deploy) + gate por
// usuário (User.whatsappEnabledAt — plano pago superior); estas constantes só
// são exercitadas quando os dois gates estão abertos.

export const WHATSAPP_CONSTANTS = {
  // Graph API. Versão fixada por constante (estável verificada em 2026-07:
  // v25.0, fev/2026). Override por env para bump sem redeploy de código.
  GRAPH_BASE_URL:
    process.env.WHATSAPP_GRAPH_BASE_URL || "https://graph.facebook.com",
  API_VERSION: process.env.WHATSAPP_API_VERSION || "v25.0",

  // App Meta GLOBAL do Dexo (caminho Embedded Signup / contas na WABA própria).
  // No onboarding MANUAL multi-cliente, o app é DO CLIENTE — appId/appSecret
  // ficam por conta em WhatsAppAccount e estes valores são só fallback.
  APP_ID: process.env.WHATSAPP_APP_ID,
  APP_SECRET: process.env.WHATSAPP_APP_SECRET,

  // Token de verificação do handshake GET do webhook (string que NÓS definimos
  // e colamos no painel do app Meta ao configurar o Callback URL).
  WEBHOOK_VERIFY_TOKEN: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,

  // Configuration ID do Embedded Signup (Facebook Login for Business). Só
  // usado na fase futura de onboarding via popup — opcional no MVP manual.
  EMBEDDED_SIGNUP_CONFIG_ID: process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID,

  // Janela de atendimento da Cloud API: 24h após a última mensagem INBOUND
  // (renova a cada mensagem do cliente). Fora dela, texto livre é rejeitado
  // com erro 131047 — só template pré-aprovado (fora do escopo do MVP).
  SERVICE_WINDOW_MS: 24 * 60 * 60 * 1000,

  // Limite de corpo de texto da Cloud API (type=text → text.body).
  TEXT_MAX_LENGTH: 4096,

  // Código de erro da Graph API quando a janela de 24h está fechada.
  ERROR_CODE_OUTSIDE_WINDOW: 131047,

  // Timeout por request (espelha REQUEST_TIMEOUT do Magalu).
  REQUEST_TIMEOUT: 30000,

  // Dedup de webhook no WebhookEventLog (@@unique([source, externalId])).
  WEBHOOK_LOG_SOURCE: "WHATSAPP",
} as const;

/**
 * Kill-switch global do módulo. Lido por função (e não const module-level)
 * para os testes conseguirem stubar process.env sem vi.resetModules. No
 * frontend a leitura é a const build-time padrão do projeto.
 */
export function isWhatsappModuleEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED === "true";
}

/** Verify token do handshake do webhook — leitura por request (testável). */
export function getWhatsappVerifyToken(): string | undefined {
  return process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || undefined;
}

/** App Secret GLOBAL (fallback do appSecret por conta) — leitura por request. */
export function getWhatsappAppSecret(): string | undefined {
  return process.env.WHATSAPP_APP_SECRET || undefined;
}

/**
 * Valida a config do WhatsApp em RUNTIME (não no boot) — mesmo contrato de
 * validateMagaluConfig. Chamar nos serviços whatsapp-* antes de operar.
 * Exige também MARKETPLACE_TOKEN_ENC_KEY: sem ela o SecretCipher vira no-op e
 * o token da conta seria gravado em texto plano — inaceitável para este módulo.
 */
export function validateWhatsAppConfig(): void {
  const required = ["WHATSAPP_WEBHOOK_VERIFY_TOKEN", "MARKETPLACE_TOKEN_ENC_KEY"];

  for (const envVar of required) {
    if (!process.env[envVar]) {
      throw new Error(
        `Variável de ambiente ${envVar} não configurada (módulo WhatsApp)`,
      );
    }
  }
}
