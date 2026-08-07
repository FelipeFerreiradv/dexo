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
export type AiProviderName = "gemini" | "deepseek" | "mock";

/**
 * As capacidades que o Bitz roteia para modelos DIFERENTES.
 *
 * ⭐ POR QUE ISTO EXISTE: dinheiro. Texto é ~95% do volume (dúvida, relatório,
 * consulta de peça) e o modelo barato dá conta. Imagem e áudio são raros e
 * exigem modelo que os entenda. Amarrar tudo a um provedor só significa pagar
 * preço de multimodal em toda pergunta de texto.
 *
 * ⚠️ NESTA RODADA SÓ `texto` É CONSUMIDO. `imagem` e `audio` resolvem, são
 * testados e estão documentados no `.env.example`, mas nada os chama ainda —
 * eles entram com as Fases 7 (áudio) e 8 (anexos). Estão aqui para que a
 * configuração do cliente não precise mudar quando aquelas fases chegarem.
 */
export type AiCapability = "texto" | "imagem" | "audio";

export const AI_CONSTANTS = {
  /** Endpoint REST do Gemini. Sem SDK — a casa fala REST com todo provedor. */
  GEMINI_BASE_URL:
    process.env.AI_GEMINI_BASE_URL ||
    "https://generativelanguage.googleapis.com",

  /**
   * Endpoint REST do DeepSeek. A API é compatível com o formato da OpenAI
   * (`/chat/completions`, `Authorization: Bearer`, `tools`/`tool_calls`).
   *
   * ⚠️ O DeepSeek é TEXTO PURO na API. Não tem visão (a leitura de imagem
   * existe só no chat.deepseek.com, não na API) e não tem áudio em forma
   * nenhuma. Rotear `imagem` ou `audio` para ele não falha na configuração —
   * falha na chamada, com `erro_provedor`. Por isso o `.env.example` diz, na
   * linha de cada rota, quais provedores servem para aquela capacidade.
   */
  DEEPSEEK_BASE_URL:
    process.env.AI_DEEPSEEK_BASE_URL || "https://api.deepseek.com",

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

/** Normaliza um nome de provedor. Desconhecido ⇒ `mock`. */
function paraProvedor(raw: string | undefined): AiProviderName {
  const v = (raw || "").trim().toLowerCase();
  if (v === "gemini") return "gemini";
  if (v === "deepseek") return "deepseek";
  // ⚠️ Desconhecido cai no MOCK, e isso é deliberado: o mock não toca rede.
  // Um typo em `AI_PROVIDER` deixa o Bitz sem graça, nunca chamando um
  // endpoint errado com a chave do cliente.
  return "mock";
}

/**
 * Provedor do `AI_PROVIDER` legado. Continua sendo o padrão de TODAS as
 * capacidades que não tiverem rota própria — é o que faz um `.env` de hoje se
 * comportar exatamente como hoje depois desta mudança.
 */
export function getAiProviderName(): AiProviderName {
  return paraProvedor(process.env.AI_PROVIDER);
}

/** Nome do modelo. NUNCA hardcoded no código de chamada — sempre daqui. */
export function getAiModel(): string | undefined {
  return process.env.AI_MODEL?.trim() || undefined;
}

/** Chave da API legada, do `AI_PROVIDER`. Só no servidor, nunca em NEXT_PUBLIC_*. */
export function getAiApiKey(): string | undefined {
  return process.env.AI_API_KEY?.trim() || undefined;
}

/** Nome da env de rota de uma capacidade: `texto` ⇒ `AI_ROUTE_TEXTO`. */
function envDaRota(capacidade: AiCapability): string {
  return `AI_ROUTE_${capacidade.toUpperCase()}`;
}

/**
 * ⭐ A ROTA DE UMA CAPACIDADE — o coração da troca dinâmica de modelo.
 *
 * Formato: `AI_ROUTE_TEXTO="deepseek:deepseek-v4"`, ou seja `provedor:modelo`.
 *
 * POR QUE UMA STRING SÓ, E NÃO DUAS VARIÁVEIS. Nome de modelo só significa
 * alguma coisa DENTRO de um provedor: `deepseek-v4` não existe no Gemini e
 * `gemini-2.5-flash` não existe no DeepSeek. Separar em `AI_TEXTO_PROVIDER` +
 * `AI_TEXTO_MODEL` convida a combinação impossível — trocar o provedor e
 * esquecer o modelo ao lado. Aqui os dois andam juntos ou não andam.
 *
 * ORDEM DE RESOLUÇÃO, e ela é a garantia de zero regressão:
 *   1. `AI_ROUTE_<CAPACIDADE>`, se estiver preenchida e for parseável;
 *   2. senão, o par legado `AI_PROVIDER` + `AI_MODEL` — o comportamento de hoje.
 *
 * Um `.env` que nunca ouviu falar de rota continua funcionando byte a byte
 * igual, para as três capacidades.
 *
 * ⚠️ MODELO VAZIO NÃO VIRA DEFAULT. `AI_ROUTE_TEXTO="deepseek"` (sem `:modelo`)
 * devolve modelo `undefined`, e quem chama degrada com `sem_modelo`. Inventar
 * um nome de modelo aqui é o começo de uma conta surpresa: nomes mudam (o
 * `deepseek-chat` foi descontinuado em 24/07/2026) e um default silencioso
 * chamaria um modelo que o cliente não escolheu, com o preço que vier.
 */
export function getAiRoute(capacidade: AiCapability): {
  provider: AiProviderName;
  model: string | undefined;
} {
  const bruto = process.env[envDaRota(capacidade)]?.trim();

  if (bruto) {
    const sep = bruto.indexOf(":");
    const nomeProvedor = sep >= 0 ? bruto.slice(0, sep) : bruto;
    const modelo = sep >= 0 ? bruto.slice(sep + 1).trim() : "";
    return { provider: paraProvedor(nomeProvedor), model: modelo || undefined };
  }

  return { provider: getAiProviderName(), model: getAiModel() };
}

/**
 * ⭐ A CHAVE DE UM PROVEDOR — e a regra de segurança que governa esta função.
 *
 * Ordem:
 *   1. `AI_GEMINI_API_KEY` / `AI_DEEPSEEK_API_KEY` — a chave daquele provedor;
 *   2. `AI_API_KEY`, **e somente se aquele provedor for o `AI_PROVIDER`**.
 *
 * ⚠️ O PASSO 2 É ESTREITO DE PROPÓSITO. Sem a condição, um `.env` com
 * `AI_PROVIDER=gemini` + `AI_ROUTE_TEXTO=deepseek:...` e sem
 * `AI_DEEPSEEK_API_KEY` mandaria a **chave do Google para o servidor do
 * DeepSeek** no primeiro `Authorization: Bearer`. Seria vazamento de
 * credencial para terceiro, causado por uma linha de configuração e sem
 * nenhum sinal de erro. Faltando a chave certa, o provedor simplesmente não
 * sobe e o Bitz degrada — que é a falha correta.
 */
export function getAiApiKeyFor(provider: AiProviderName): string | undefined {
  if (provider === "mock") return undefined;

  const propria = process.env[`AI_${provider.toUpperCase()}_API_KEY`]?.trim();
  if (propria) return propria;

  return provider === getAiProviderName() ? getAiApiKey() : undefined;
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
export function describeAiConfigProblem(
  capacidade: AiCapability = "texto",
): string | null {
  if (!isAiModuleEnabled()) return "modulo_desligado";
  // O parâmetro tem default: `describeAiConfigProblem()` continua sendo a
  // pergunta sobre o caminho de texto, que é o único consumido hoje.
  const { provider, model } = getAiRoute(capacidade);
  if (provider === "mock") return null;
  if (!getAiApiKeyFor(provider)) return "sem_api_key";
  if (!model) return "sem_modelo";
  return null;
}
