/**
 * Flags e parâmetros do módulo fiscal novo (numeração V2, devolução, RT por empresa).
 *
 * Regras (plano aprovado §2.3):
 *  - Lidas em TEMPO DE CHAMADA (nunca no load do módulo): testes usam
 *    `vi.stubEnv` ou passam `env` injetado, e o runtime do Fastify vê o valor real.
 *  - Liga só com o texto exato `"true"` (gotcha do `.env`: `"1"` NÃO liga).
 *  - Allowlist por `companyFiscalConfigId`, FAIL-CLOSED: ausente ou vazia = nenhuma
 *    empresa; `"*"` (sozinho) = todas. Um id nulo/vazio nunca está na lista.
 *  - Sem `NEXT_PUBLIC_`: a allowlist nunca vai para o bundle do cliente.
 *
 * Módulo PURO (sem imports, sem efeito colateral). Não importa `node:*`.
 */

export type FiscalFeature =
  | "NUMERACAO_V2"
  | "NUMERACAO_V2_FOCUS"
  | "DEVOLUCAO"
  | "RESP_TEC_EMPRESA";

/** Subconjunto de `process.env` lido aqui (injetável em teste). */
export type FiscalEnv = Readonly<Record<string, string | undefined>>;

const ENV_ENABLED: Record<FiscalFeature, string> = {
  NUMERACAO_V2: "NFE_NUMERACAO_V2_ENABLED",
  NUMERACAO_V2_FOCUS: "NFE_NUMERACAO_V2_FOCUS_ENABLED",
  DEVOLUCAO: "NFE_DEVOLUCAO_ENABLED",
  RESP_TEC_EMPRESA: "NFE_RESP_TEC_EMPRESA_ENABLED",
};

/** A sub-flag da Focus usa a MESMA allowlist da numeração V2. */
const ENV_ALLOWLIST: Record<FiscalFeature, string> = {
  NUMERACAO_V2: "NFE_NUMERACAO_V2_CONFIG_IDS",
  NUMERACAO_V2_FOCUS: "NFE_NUMERACAO_V2_CONFIG_IDS",
  DEVOLUCAO: "NFE_DEVOLUCAO_CONFIG_IDS",
  RESP_TEC_EMPRESA: "NFE_RESP_TEC_EMPRESA_CONFIG_IDS",
};

function ligada(env: FiscalEnv, nome: string): boolean {
  return env[nome] === "true";
}

/**
 * `true` quando o configId está na allowlist. `"*"` só vale quando é o valor
 * inteiro (após trim): `"abc,*"` NÃO libera todas (ambíguo ⇒ fechado).
 */
function allowlistContem(
  raw: string | undefined,
  configId: string | null | undefined,
): boolean {
  if (typeof configId !== "string") return false;
  const id = configId.trim();
  if (!id) return false;
  const lista = (raw ?? "").trim();
  if (!lista) return false;
  if (lista === "*") return true;
  return lista
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "*")
    .includes(id);
}

export function isFiscalFeatureOn(
  feature: FiscalFeature,
  configId: string | null | undefined,
  env: FiscalEnv = process.env,
): boolean {
  if (feature === "NUMERACAO_V2_FOCUS") {
    // Sub-flag: sem a numeração V2 ligada para a config, a Focus nunca entra.
    return (
      ligada(env, ENV_ENABLED.NUMERACAO_V2_FOCUS) &&
      isFiscalFeatureOn("NUMERACAO_V2", configId, env)
    );
  }
  if (!ligada(env, ENV_ENABLED[feature])) return false;
  return allowlistContem(env[ENV_ALLOWLIST[feature]], configId);
}

/** Modelos cobertos pela V2 (`NFE_NUMERACAO_V2_MODELOS`, default `"55"`; vazio ⇒ default). */
export function modelosNumeracaoV2(env: FiscalEnv = process.env): Array<"55" | "65"> {
  const raw = (env.NFE_NUMERACAO_V2_MODELOS ?? "").trim() || "55";
  const modelos: Array<"55" | "65"> = [];
  for (const parte of raw.split(",")) {
    const m = parte.trim();
    if ((m === "55" || m === "65") && !modelos.includes(m)) modelos.push(m);
  }
  return modelos;
}

/**
 * A emissão desta nota passa pela numeração V2?
 *  - V2 ligada para a config; E
 *  - modelo na lista `NFE_NUMERACAO_V2_MODELOS`; E
 *  - SEFAZ direto, ou sub-flag da Focus ligada para a config (qualquer outro
 *    provedor — inclusive `null`, que o V1 trata como Focus — exige a sub-flag).
 */
export function isNumeracaoV2ParaEmissao(
  configId: string | null | undefined,
  modelo: "55" | "65",
  providerName: string | null,
  env: FiscalEnv = process.env,
): boolean {
  if (!isFiscalFeatureOn("NUMERACAO_V2", configId, env)) return false;
  if (!modelosNumeracaoV2(env).includes(modelo)) return false;
  if (providerName === "SEFAZ_DIRECT") return true;
  return isFiscalFeatureOn("NUMERACAO_V2_FOCUS", configId, env);
}

/**
 * Devolução só existe com a numeração V2 (plano §2.1: "Devolução só emite pelo V2").
 * Como a devolução é sempre modelo 55, exige também o 55 na lista da V2.
 * A checagem do provedor (sub-flag Focus) fica no guard da emissão, que conhece
 * o `providerName`: `isNumeracaoV2ParaEmissao(configId, "55", providerName)`.
 */
export function isDevolucaoAtiva(
  configId: string | null | undefined,
  env: FiscalEnv = process.env,
): boolean {
  return (
    isFiscalFeatureOn("DEVOLUCAO", configId, env) &&
    isFiscalFeatureOn("NUMERACAO_V2", configId, env) &&
    modelosNumeracaoV2(env).includes("55")
  );
}

// ───────────────────────────── Parâmetros (tunables) ─────────────────────────────

const INTEIRO_POSITIVO = /^\s*\d{1,15}\s*$/;

/** Inteiro positivo seguro vindo do env; qualquer outra coisa ⇒ default. */
function inteiroPositivo(env: FiscalEnv, nome: string, padrao: number): number {
  const raw = env[nome];
  if (typeof raw !== "string" || !INTEIRO_POSITIVO.test(raw)) return padrao;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : padrao;
}

/**
 * Leitura do transporte SOAP com a MESMA semântica de `soap-client.service.ts`
 * (`defaultTimeout`/`defaultRetry`), para o lease nunca subestimar o tempo real
 * em voo de um envio (revisão adversarial: "lease/maturity vs SEFAZ transport retries").
 */
function sefazTimeoutMs(env: FiscalEnv): number {
  const v = env.SEFAZ_TIMEOUT_MS;
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 60_000;
}

function sefazRetryMax(env: FiscalEnv): number {
  const v = env.SEFAZ_RETRY_MAX;
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : 3;
}

const BACKOFF_ORCAMENTO_MIN_MS = 15_000;
const POLLING_ORCAMENTO_MS = 30_000;

/** Σ do backoff do SoapClient (base 500 ms, ×2, teto 8 s), nunca abaixo de 15 s. */
function orcamentoBackoffMs(retryMax: number): number {
  let soma = 0;
  for (let i = 0; i < retryMax && soma < Number.MAX_SAFE_INTEGER; i++) {
    soma += Math.min(500 * Math.pow(2, i), 8_000);
  }
  return Math.max(BACKOFF_ORCAMENTO_MIN_MS, soma);
}

/**
 * Tempo mínimo desde a transmissão para um "não consta" (SEFAZ 217 / Focus 404)
 * valer como prova. Default derivado do pior caso de uma transmissão em voo:
 * `SEFAZ_TIMEOUT_MS × (SEFAZ_RETRY_MAX+1) + backoff + polling`
 * (60 000 × 4 + 15 000 + 30 000 = 285 000 ms com os valores de produção).
 * Override: `NFE_NUMERACAO_V2_NAO_CONSTA_MIN_MS`.
 */
export function naoConstaMinMs(env: FiscalEnv = process.env): number {
  const retry = sefazRetryMax(env);
  const derivado = Math.min(
    Number.MAX_SAFE_INTEGER,
    sefazTimeoutMs(env) * (retry + 1) + orcamentoBackoffMs(retry) + POLLING_ORCAMENTO_MS,
  );
  return inteiroPositivo(env, "NFE_NUMERACAO_V2_NAO_CONSTA_MIN_MS", derivado);
}

/** Lease da fase pré-envio (VALIDATING/SIGNING travada). `NFE_NUMERACAO_V2_LEASE_PRE_ENVIO_MS`. */
export function leasePreEnvioMs(env: FiscalEnv = process.env): number {
  return inteiroPositivo(env, "NFE_NUMERACAO_V2_LEASE_PRE_ENVIO_MS", 600_000);
}

const LEASE_SEFAZ_PISO_MS = 300_000;

/**
 * Lease de uma transmissão SEFAZ em voo. Default `2 × naoConstaMinMs`; piso de
 * 300 000 ms também para o override `NFE_NUMERACAO_V2_LEASE_SEFAZ_MS`.
 */
export function leaseEnvioSefazMs(env: FiscalEnv = process.env): number {
  const derivado = Math.min(Number.MAX_SAFE_INTEGER, 2 * naoConstaMinMs(env));
  const valor = inteiroPositivo(env, "NFE_NUMERACAO_V2_LEASE_SEFAZ_MS", derivado);
  return Math.max(LEASE_SEFAZ_PISO_MS, valor);
}

/** Lease de uma transmissão Focus em voo. `NFE_NUMERACAO_V2_LEASE_FOCUS_MS`. */
export function leaseEnvioFocusMs(env: FiscalEnv = process.env): number {
  return inteiroPositivo(env, "NFE_NUMERACAO_V2_LEASE_FOCUS_MS", 180_000);
}

/** Timeout do POST do cliente Focus V2. `FOCUS_V2_POST_TIMEOUT_MS`. */
export function focusPostTimeoutMs(env: FiscalEnv = process.env): number {
  return inteiroPositivo(env, "FOCUS_V2_POST_TIMEOUT_MS", 45_000);
}

/** Timeout do GET do cliente Focus V2. `FOCUS_V2_GET_TIMEOUT_MS`. */
export function focusGetTimeoutMs(env: FiscalEnv = process.env): number {
  return inteiroPositivo(env, "FOCUS_V2_GET_TIMEOUT_MS", 15_000);
}

/**
 * Pausas (ms) entre as consultas curtas que a V2 faz depois do 202 da Focus (NF-e 55
 * assíncrona), antes de responder "em andamento". `NFE_NUMERACAO_V2_FOCUS_PAUSAS_MS`
 * (lista separada por vírgula; "0" desliga ⇒ uma consulta imediata). Padrão 2s, 3s, 4s,
 * na ordem do polling do V1 (3 × 3s).
 */
export function focusPausasConsultaMs(env: FiscalEnv = process.env): number[] {
  const raw = (env.NFE_NUMERACAO_V2_FOCUS_PAUSAS_MS ?? "").trim();
  if (!raw) return [2_000, 3_000, 4_000];
  if (raw === "0") return [];
  const pausas = raw.split(",").map((p) => p.trim());
  if (!pausas.every((p) => INTEIRO_POSITIVO.test(p))) return [2_000, 3_000, 4_000];
  return pausas.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0 && n <= 30_000).slice(0, 5);
}

/** L1: janela em que o MESMO conteúdo rejeitado não é retransmitido. `NFE_NUMERACAO_V2_COOLDOWN_REPETICAO_MS`. */
export function cooldownRepeticaoMs(env: FiscalEnv = process.env): number {
  return inteiroPositivo(env, "NFE_NUMERACAO_V2_COOLDOWN_REPETICAO_MS", 60_000);
}

/** Espera após cStat 656 (consumo indevido). `NFE_NUMERACAO_V2_COOLDOWN_CONSUMO_INDEVIDO_MS`. */
export function consumoIndevidoCooldownMs(env: FiscalEnv = process.env): number {
  return inteiroPositivo(env, "NFE_NUMERACAO_V2_COOLDOWN_CONSUMO_INDEVIDO_MS", 3_600_000);
}

const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO = "2026-10-05";

/**
 * Data (YYYY-MM-DD, calendário real) a partir da qual a devolução em PRODUÇÃO
 * referencia por item (`DFeReferenciado`). `NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE`;
 * valor inválido ⇒ `2026-10-05`.
 */
export function devolucaoRefItemProdDesde(env: FiscalEnv = process.env): string {
  const raw = (env.NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE ?? "").trim();
  const m = DATA_ISO.exec(raw);
  if (!m) return DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  const valida =
    ano >= 2000 &&
    d.getUTCFullYear() === ano &&
    d.getUTCMonth() === mes - 1 &&
    d.getUTCDate() === dia;
  return valida ? raw : DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO;
}
