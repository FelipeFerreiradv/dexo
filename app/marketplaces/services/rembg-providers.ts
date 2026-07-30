/**
 * Provedores de recorte (PR 5) — cadeia local → externo.
 *
 * O QUE MORA AQUI
 * ---------------
 * 1. `localSidecarFetch`: o corpo do antigo `defaultRembgFetcher` do
 *    image-resize.service, MOVIDO sem mudança de comportamento (mesmos envs,
 *    mesmo shape de opts/onMeta). O serviço de imagem importa daqui.
 * 2. `ExternalApiProvider` GENÉRICO: cliente HTTP para qualquer fornecedor
 *    no formato "POST multipart com a imagem + header de API key → PNG com
 *    alpha no corpo da resposta" (remove.bg, Photoroom, PixelCut…). O
 *    fornecedor é escolhido por ENV, não por código — trocar de provedor é
 *    editar .env, sem deploy.
 * 3. `tryExternalProviderCutout`: o elo externo da cadeia — só dispara com
 *    env configurada + teto diário disponível + orçamento ≥4s + breaker
 *    fechado, e SEMPRE deixa rastro LGPD (SystemLog IMAGE_SENT_EXTERNAL).
 *
 * DEFAULT = TUDO DESLIGADO: sem REMBG_FALLBACK_API_URL + REMBG_FALLBACK_MAX_PER_DAY
 * o elo externo nem existe e o pipeline se comporta byte a byte como antes.
 */

import FormData from "form-data";
import axios from "axios";
import { computeSidecarTimeoutMs, readRembgTimeoutMs } from "./rembg-budget";
import { externalRembgBreaker } from "./rembg-breaker";
import { refundDailySlot, tryReserveDailySlot } from "./rembg-provider-usage";
import { recordImageSentExternal } from "./rembg-telemetry";

const REMBG_PROFILE =
  (process.env.REMBG_PROFILE ?? "false").toLowerCase() === "true";

/** O sidecar LOCAL está configurado e sem killswitch? (Mesma regra que sempre
 *  viveu no image-resize.service; exportada para o guard do worker.) */
export function isLocalSidecarConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const url = env.REMBG_SIDECAR_URL;
  const enabled = (env.REMBG_ENABLED ?? "true").toLowerCase();
  return Boolean(url) && enabled !== "false";
}

export interface RembgFetchMeta {
  timing?: string;
  confidence?: number;
  signals?: string;
}

export interface RembgFetchOpts {
  addShadow?: boolean;
  timeoutMs?: number;
  /** Metadados do round-trip (X-Rembg-Timing/-Confidence/-Signals). */
  onMeta?: (meta: RembgFetchMeta) => void;
}

/**
 * Fetcher do sidecar LOCAL (BiRefNet na VPS). Corpo idêntico ao antigo
 * `defaultRembgFetcher` — ver histórico do image-resize.service.ts.
 */
export async function localSidecarFetch(
  buf: Buffer,
  opts?: RembgFetchOpts,
): Promise<Buffer> {
  const url = process.env.REMBG_SIDECAR_URL;
  if (!url) throw new Error("REMBG_SIDECAR_URL não configurado");
  // `timeoutMs` já vem clampado pelo orçamento da requisição (ver rembg-budget).
  // O fallback para o env preserva o comportamento de quem chama o fetcher
  // direto, sem deadline.
  const timeoutMs =
    typeof opts?.timeoutMs === "number" && opts.timeoutMs > 0
      ? opts.timeoutMs
      : readRembgTimeoutMs();

  // O sidecar valida que content_type comece com "image/" — manter
  // consistente com o filename `input.png` e evitar 400 do FastAPI.
  const form = new FormData();
  form.append("file", buf, {
    filename: "input.png",
    contentType: "image/png",
  });
  // Campo retrocompatível: só enviamos add_shadow quando solicitado, pra
  // manter requests sem sombra idênticos ao comportamento de hoje.
  if (opts?.addShadow) {
    form.append("add_shadow", "true");
  }

  const endpoint = url.replace(/\/+$/, "") + "/remove-bg";
  const response = await axios.post(endpoint, form, {
    headers: form.getHeaders(),
    responseType: "arraybuffer",
    timeout: timeoutMs,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
  });

  const timing = response.headers?.["x-rembg-timing"];
  if (REMBG_PROFILE && timing) {
    console.log(`[sidecar-profile] ${timing}`);
  }
  const meta: RembgFetchMeta = {};
  if (timing && typeof timing === "string") {
    meta.timing = timing;
  }
  const confRaw = response.headers?.["x-rembg-confidence"];
  const confidence =
    typeof confRaw === "string" ? Number.parseFloat(confRaw) : NaN;
  if (Number.isFinite(confidence)) {
    meta.confidence = confidence;
    const signals = response.headers?.["x-rembg-signals"];
    if (typeof signals === "string") meta.signals = signals;
  }
  if (Object.keys(meta).length > 0) {
    try {
      opts?.onMeta?.(meta);
    } catch {
      // metadados são best-effort — nunca derrubam o caminho do recorte.
    }
  }

  return Buffer.from(response.data);
}

// ---------------------------------------------------------------------------
// Provedor externo genérico
// ---------------------------------------------------------------------------

/** Abaixo disso nem abre conexão com o externo (§PR 5 do plano): diferente do
 *  sidecar local (inferência ~9s não-cancelável), um provedor gerenciado
 *  responde em poucos segundos — 4s de sobra já pagam uma chamada útil. */
export const EXTERNAL_MIN_USEFUL_MS = 4_000;

const EXTERNAL_DEFAULT_TIMEOUT_MS = 20_000;

export interface ExternalProviderConfig {
  /** Rótulo para teto/telemetria (REMBG_FALLBACK_PROVIDER ou o hostname). */
  name: string;
  url: string;
  apiKey: string;
  keyHeader: string;
  fileField: string;
  extraFields: Array<[string, string]>;
  timeoutMs: number;
  maxPerDay: number;
}

/**
 * null = elo externo desligado (default). Exige URL **e** teto > 0 — teto
 * ausente/0 mantém o provedor inerte mesmo com URL e chave no .env (o gasto
 * é opt-in explícito).
 */
export function readExternalProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExternalProviderConfig | null {
  const url = (env.REMBG_FALLBACK_API_URL ?? "").trim();
  const maxPerDay = Number(env.REMBG_FALLBACK_MAX_PER_DAY);
  if (!url || !Number.isFinite(maxPerDay) || maxPerDay <= 0) return null;

  let name = (env.REMBG_FALLBACK_PROVIDER ?? "").trim();
  if (!name) {
    try {
      name = new URL(url).hostname;
    } catch {
      return null; // URL ilegível = configuração inválida = elo desligado
    }
  }

  const timeoutRaw = Number(env.REMBG_FALLBACK_TIMEOUT_MS);
  const extraRaw = (env.REMBG_FALLBACK_EXTRA_FIELDS ?? "").trim();
  const extraFields: Array<[string, string]> = [];
  if (extraRaw) {
    // Formato querystring ("size=auto&format=png") — cobre os campos fixos
    // que cada fornecedor exige junto do arquivo.
    for (const [k, v] of new URLSearchParams(extraRaw).entries()) {
      extraFields.push([k, v]);
    }
  }

  return {
    name,
    url,
    apiKey: (env.REMBG_FALLBACK_API_KEY ?? "").trim(),
    keyHeader: (env.REMBG_FALLBACK_API_KEY_HEADER ?? "").trim() || "X-Api-Key",
    fileField: (env.REMBG_FALLBACK_FILE_FIELD ?? "").trim() || "image_file",
    extraFields,
    timeoutMs:
      Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? Math.floor(timeoutRaw)
        : EXTERNAL_DEFAULT_TIMEOUT_MS,
    maxPerDay: Math.floor(maxPerDay),
  };
}

/** POST multipart genérico → espera bytes de imagem no corpo da resposta. */
export async function externalProviderFetch(
  cfg: ExternalProviderConfig,
  buf: Buffer,
  timeoutMs: number,
): Promise<Buffer> {
  const form = new FormData();
  form.append(cfg.fileField, buf, {
    filename: "input.png",
    contentType: "image/png",
  });
  for (const [k, v] of cfg.extraFields) form.append(k, v);

  const response = await axios.post(cfg.url, form, {
    headers: {
      ...form.getHeaders(),
      ...(cfg.apiKey ? { [cfg.keyHeader]: cfg.apiKey } : {}),
    },
    responseType: "arraybuffer",
    timeout: timeoutMs,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
  });

  const contentType = String(response.headers?.["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("image/")) {
    // Provedor que responde JSON-com-URL não é suportado pelo cliente
    // genérico — melhor falhar claro do que gravar JSON como "PNG".
    throw new Error(
      `provedor externo respondeu content-type inesperado: ${contentType || "(vazio)"}`,
    );
  }
  return Buffer.from(response.data);
}

export interface TryExternalCutoutInput {
  buf: Buffer;
  deadlineAt?: number;
  /** Dono do dado (rastro LGPD) — vai em details, nunca em coluna. */
  tenantUserId?: string;
}

export interface TryExternalCutoutResult {
  cutout: Buffer;
  provider: string;
}

/** Falha de infra abre o breaker; 4xx não (ver rembg-breaker). */
function isInfraFailure(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.response) return err.response.status >= 500;
  return true; // timeout/ECONNREFUSED/reset/DNS — sem resposta
}

/**
 * Elo EXTERNO da cadeia de recorte. Devolve null em qualquer condição que
 * impeça a chamada (desligado, teto batido, orçamento curto, breaker aberto)
 * ou em falha do provedor — o chamador segue para a degradação graceful.
 * Nunca lança.
 */
export async function tryExternalProviderCutout(
  input: TryExternalCutoutInput,
): Promise<TryExternalCutoutResult | null> {
  const cfg = readExternalProviderConfig();
  if (!cfg) return null;

  // Orçamento: reusa a mesma aritmética de deadline do sidecar (min(teto do
  // provedor, sobra da requisição - reserva)). Sem deadline → teto cheio.
  const timeoutMs = computeSidecarTimeoutMs({
    deadlineAt: input.deadlineAt,
    rembgTimeoutMs: cfg.timeoutMs,
  });
  if (timeoutMs < EXTERNAL_MIN_USEFUL_MS) return null;

  // Peek puro antes de gastar teto — breaker aberto é o caso comum durante
  // uma indisponibilidade paga (ex.: 402 sem créditos vira 4xx e NÃO abre;
  // já timeout em série abre e poupa o teto).
  if (!externalRembgBreaker.peekAllowed()) return null;

  // Teto ANTES da sonda do breaker: a reserva é a operação cara (banco) e o
  // refund cobre o único caso em que ela não vira chamada.
  const reserved = await tryReserveDailySlot({
    provider: cfg.name,
    maxPerDay: cfg.maxPerDay,
  }).catch((err) => {
    // Banco indisponível para o CONTADOR = não gasta (fail-closed no gasto).
    console.warn(
      "[rembg-external] reserva do teto diário falhou; pulando provedor externo:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  });
  if (!reserved) return null;

  if (!externalRembgBreaker.beginAttempt()) {
    // Sonda HALF_OPEN tomada por outra requisição no intervalo — devolve o
    // slot do teto e degrada.
    await refundDailySlot({ provider: cfg.name });
    return null;
  }

  const startedAt = Date.now();
  try {
    const cutout = await externalProviderFetch(cfg, input.buf, timeoutMs);
    externalRembgBreaker.recordSuccess();
    recordImageSentExternal({
      provider: cfg.name,
      ok: true,
      ms: Date.now() - startedAt,
      requestBytes: input.buf.length,
      responseBytes: cutout.length,
      tenantUserId: input.tenantUserId,
    });
    console.log(
      `[rembg-external] recorte via ${cfg.name} em ${Date.now() - startedAt}ms`,
    );
    return { cutout, provider: cfg.name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isInfraFailure(err)) {
      externalRembgBreaker.recordFailure(message);
    } else {
      externalRembgBreaker.abortAttempt();
    }
    // O envio ACONTECEU (a imagem saiu para o terceiro) — o rastro LGPD é
    // registrado mesmo em falha.
    recordImageSentExternal({
      provider: cfg.name,
      ok: false,
      ms: Date.now() - startedAt,
      requestBytes: input.buf.length,
      tenantUserId: input.tenantUserId,
      error: message,
    });
    console.warn(
      `[rembg-external] provedor ${cfg.name} falhou; seguindo para degradação:`,
      message,
    );
    return null;
  }
}
