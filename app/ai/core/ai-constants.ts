// Constantes e leitura de ambiente do módulo Bitz (agente de IA).
//
// Espelha o padrão de whatsapp-constants.ts. O módulo inteiro fica atrás de
// DOIS gates: a flag global NEXT_PUBLIC_AI_MODULE_ENABLED (kill-switch de
// deploy) + o gate por tenant (User.aiEnabledAt — plano pago superior).
//
// REGRA 1 do plano: o boot da API NÃO pode passar a depender de IA. Nenhuma
// variável daqui é obrigatória em app/lib/env.ts; a ausência de AI_API_KEY
// deixa apenas o Bitz indisponível, e todo o resto do sistema funciona igual.

/** Provedores suportados. `mock` é offline/determinístico (suíte de testes). */
export type AiProviderName = "gemini" | "mock";

export const AI_CONSTANTS = {
  /** Endpoint REST do Gemini. Sem SDK — a casa fala REST com todo provedor. */
  GEMINI_BASE_URL:
    process.env.AI_GEMINI_BASE_URL ||
    "https://generativelanguage.googleapis.com",

  /** Timeout por request ao provedor. Curto de propósito: o chat degrada. */
  DEFAULT_TIMEOUT_MS: 30_000,

  /** Teto de saída por resposta. */
  DEFAULT_MAX_TOKENS: 2048,

  /** Temperatura padrão. Baixa: o Bitz é operacional, não criativo. */
  DEFAULT_TEMPERATURE: 0.3,

  /**
   * Teto diário de mensagens por tenant (ProviderDailyUsage).
   *
   * ⭐ 5/dia É O TETO DA PRÉVIA GRATUITA, e é de propósito que ele seja baixo:
   * o Bitz nasce liberado para TODO MUNDO nesta fase, e este número é o que
   * transforma "liberado para todos" num gasto previsível. Quem assinar o plano
   * maior recebe um teto próprio em `User.aiDailyLimit`, configurado pelo
   * Superadmin — sem tocar em env de servidor.
   *
   * Medido em 07/08/2026: ~R$ 0,0093 por mensagem. 5/dia = R$ 0,05 por dia por
   * cliente que esgotar a cota.
   */
  DEFAULT_MAX_DAILY_PER_TENANT: 5,

  /** Teto diário global (proteção de custo da plataforma inteira). */
  DEFAULT_MAX_DAILY_GLOBAL: 5000,

  /** Prefixo das linhas de quota em ProviderDailyUsage. */
  USAGE_PROVIDER_GLOBAL: "ai:global",
  USAGE_PROVIDER_TENANT_PREFIX: "ai:tenant:",
} as const;

/**
 * Kill-switch global do módulo. Lido por FUNÇÃO (e não const module-level)
 * para os testes conseguirem stubar process.env sem vi.resetModules — mesma
 * decisão de isWhatsappModuleEnabled(). No frontend a leitura é a const
 * build-time padrão do projeto (NEXT_PUBLIC_* é inlinado no build).
 */
export function isAiModuleEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AI_MODULE_ENABLED === "true";
}

/**
 * PRÉVIA GRATUITA: o Bitz vale para TODO MUNDO, sem depender de
 * `User.aiEnabledAt`.
 *
 * ⭐ Por que uma flag e não um `UPDATE "User" SET "aiEnabledAt" = NOW()` em
 * todos: liberar em massa é fácil, DESLIGAR depois não. Um update global
 * apagaria a distinção entre "recebeu na prévia" e "assinou o plano" — e no dia
 * de fechar seria preciso adivinhar quem era quem. Com a flag, a concessão
 * individual permanece intocada: acabou a prévia, desliga a env e só quem tem
 * `aiEnabledAt` continua, cada um com o teto que o Superadmin deu.
 *
 * ⚠️ NÃO é kill-switch. Com `NEXT_PUBLIC_AI_MODULE_ENABLED=false` nada disto
 * roda — a checagem de módulo vem antes, sempre.
 *
 * Nasce DESLIGADA: sem ninguém setar, o comportamento é exatamente o de antes.
 */
export function isAiFreePreviewEnabled(): boolean {
  return process.env.AI_FREE_PREVIEW === "true";
}

/** Provedor configurado. Default `mock` — sem config, nada chama rede. */
export function getAiProviderName(): AiProviderName {
  const raw = (process.env.AI_PROVIDER || "").trim().toLowerCase();
  return raw === "gemini" ? "gemini" : "mock";
}

/** Nome do modelo. NUNCA hardcoded no código de chamada — sempre daqui. */
export function getAiModel(): string | undefined {
  return process.env.AI_MODEL?.trim() || undefined;
}

/** Chave da API. Só no servidor, nunca em NEXT_PUBLIC_*. */
export function getAiApiKey(): string | undefined {
  return process.env.AI_API_KEY?.trim() || undefined;
}

/** Lê um inteiro positivo do ambiente, com fallback. Inválido ⇒ fallback. */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getAiTimeoutMs(): number {
  return readPositiveInt(
    process.env.AI_TIMEOUT_MS,
    AI_CONSTANTS.DEFAULT_TIMEOUT_MS,
  );
}

export function getAiMaxTokens(): number {
  return readPositiveInt(
    process.env.AI_MAX_TOKENS,
    AI_CONSTANTS.DEFAULT_MAX_TOKENS,
  );
}

export function getAiTemperature(): number {
  const n = Number(process.env.AI_TEMPERATURE);
  return Number.isFinite(n) && n >= 0 && n <= 2
    ? n
    : AI_CONSTANTS.DEFAULT_TEMPERATURE;
}

export function getAiMaxDailyPerTenant(): number {
  return readPositiveInt(
    process.env.AI_MAX_DAILY_PER_TENANT,
    AI_CONSTANTS.DEFAULT_MAX_DAILY_PER_TENANT,
  );
}

export function getAiMaxDailyGlobal(): number {
  return readPositiveInt(
    process.env.AI_MAX_DAILY_GLOBAL,
    AI_CONSTANTS.DEFAULT_MAX_DAILY_GLOBAL,
  );
}

/**
 * Pesquisa externa (catálogo público do ML) nas tools consultivas.
 * Nasce DESLIGADA — só é consultada quando as fontes internas vierem vazias.
 */
export function isAiExternalLookupEnabled(): boolean {
  return process.env.AI_EXTERNAL_LOOKUP_ENABLED === "true";
}

/**
 * Valida a config do provedor em RUNTIME (nunca no boot) — mesmo contrato de
 * validateWhatsAppConfig/validateMagaluConfig. Devolve o motivo em vez de
 * lançar: quem chama precisa DEGRADAR, não quebrar.
 */
export function describeAiConfigProblem(): string | null {
  if (!isAiModuleEnabled()) return "modulo_desligado";
  const provider = getAiProviderName();
  if (provider === "mock") return null;
  if (!getAiApiKey()) return "sem_api_key";
  if (!getAiModel()) return "sem_modelo";
  return null;
}
