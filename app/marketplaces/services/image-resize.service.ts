/**
 * Serviço de processamento de imagens.
 *
 * Responsabilidades:
 *  - `ensureMLMinImageSize`: legado — garante mínimo 800px lado curto pro
 *    ML, achatando alpha sobre branco. Continua sendo usado pelo pipeline
 *    de publicação no marketplace.
 *  - `processUploadedImage`: pipeline novo, chamado no upload do usuário.
 *    Sempre normaliza (strip EXIF, autoOrient, resize 1000–1600px) e,
 *    opcionalmente, remove o fundo via sidecar rembg. Em qualquer falha
 *    do sidecar, faz fallback graceful para a imagem otimizada sem
 *    remoção (com aviso) — nunca trava o upload.
 *
 * O import do sharp é cacheado em variável de módulo para evitar overhead
 * de dynamic import a cada chamada.
 */

import FormData from "form-data";
import axios from "axios";
import {
  SIDECAR_MIN_USEFUL_MS,
  computeSidecarTimeoutMs,
  isWorthCallingSidecar,
  readRembgTimeoutMs,
} from "./rembg-budget";
import { acquireRembgSlot, type RembgLane } from "./rembg-gate";

const ML_MIN_IMAGE_PX = 800;

const UPLOAD_MIN_SHORT_EDGE_PX = 1000;
const UPLOAD_MAX_LONG_EDGE_PX = 1600;
const UPLOAD_WEBP_QUALITY = 88;
const UPLOAD_PNG_COMPRESSION = 9;

// Profiling opt-in (Fase 0): REMBG_PROFILE=true loga o tempo de cada estágio do
// pipeline Node (metadata, resize→normalized, round-trip do sidecar, re-encode)
// e o header X-Rembg-Timing do sidecar. Default OFF => zero trabalho extra e
// nenhuma mudança de comportamento/resposta. Lido via process.env (consistente
// com REMBG_SIDECAR_URL/REMBG_TIMEOUT_MS, que também não passam pelo env.ts aqui).
const REMBG_PROFILE = (process.env.REMBG_PROFILE ?? "false").toLowerCase() === "true";
const profNow = (): number => (REMBG_PROFILE ? performance.now() : 0);

// Cache do módulo sharp — resolvido uma única vez
let _sharp: any = null;

async function getSharp() {
  if (_sharp) return _sharp;
  const mod = await import("sharp");
  _sharp = (mod as any).default || mod;
  return _sharp;
}

/**
 * Garante que a imagem tenha pelo menos ML_MIN_IMAGE_PX pixels no lado mais
 * curto. PNGs com alpha são achatados sobre fundo branco antes do encode JPEG
 * para evitar fundo preto (default do sharp ao converter alpha→opaque).
 *
 * Mantida para preservar o contrato existente do pipeline de publicação ML.
 */
export async function ensureMLMinImageSize(buf: Buffer): Promise<Buffer> {
  try {
    const sharp = await getSharp();
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    const hasAlpha = Boolean(meta.hasAlpha);

    if (w === 0 || h === 0) return buf;

    const meetsMin = w >= ML_MIN_IMAGE_PX && h >= ML_MIN_IMAGE_PX;
    if (meetsMin && !hasAlpha) return buf;

    let pipeline = sharp(buf);
    if (!meetsMin) {
      const resizeOpts =
        w <= h
          ? { width: ML_MIN_IMAGE_PX as number }
          : { height: ML_MIN_IMAGE_PX as number };
      pipeline = pipeline.resize(resizeOpts);
    }
    if (hasAlpha) {
      pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
    }
    const out = await pipeline.jpeg({ quality: 85 }).toBuffer();

    console.log(
      `[ImageResize] ${w}x${h} alpha=${hasAlpha} → out=${out.length} bytes (resize=${!meetsMin}, flatten=${hasAlpha})`,
    );
    return out;
  } catch (err) {
    console.warn(
      "[ImageResize] Falha ao processar, usando original:",
      err instanceof Error ? err.message : String(err),
    );
    return buf;
  }
}

export type ProcessedImageFormat = "webp" | "png" | "jpeg";

/**
 * POR QUE a degradação virou o warning que veio parar no usuário. As três
 * causas produzem a MESMA mensagem mas exigem correções diferentes (fila ≠
 * sidecar morto ≠ killswitch); sem este campo só dava para separá-las
 * garimpando o pm2 log. Aditivo: ausente = não degradou.
 */
export type RembgDegradeReason =
  | "killswitch" // REMBG_ENABLED=false ou REMBG_SIDECAR_URL ausente
  | "budget_gate" // orçamento/fila esgotados ANTES de chamar o sidecar
  | "budget_after_wait" // slot saiu, mas a sobra não pagava uma inferência
  | "timeout" // axios ECONNABORTED — inferência não coube no orçamento
  | "conn_error" // ECONNREFUSED/ECONNRESET/EPIPE — container morto/reiniciando
  | "http_error" // sidecar respondeu 4xx/5xx
  | "processing_error"; // resposta ilegível/erro inesperado pós-fetch

export interface ProcessUploadedImageOptions {
  removeBackground: boolean;
  /** Sombra de contato. Exige recorte — ignorada se removeBackground=false. */
  addShadow?: boolean;
  /**
   * Instante (epoch ms) em que o handler precisa ter respondido — tipicamente
   * `t0 + UPLOAD_HANDLER_BUDGET_MS`, carimbado pela rota. Aditivo e OPCIONAL:
   * sem ele, o orçamento é o `REMBG_TIMEOUT_MS` de sempre e o comportamento é
   * idêntico ao anterior. Com ele, o serviço garante que a degradação graceful
   * roda ANTES de o nginx cortar a conexão (504 sem CORS). Ver `rembg-budget`.
   */
  deadlineAt?: number;
  /**
   * Faixa de prioridade no gate do sidecar. `"internal"` (default) é o modal de
   * produto; `"public"` é o endpoint aberto a terceiros, que fica com cota
   * reservada menor para nunca starvar o tráfego interno. Ver `rembg-gate`.
   */
  lane?: RembgLane;
  /** Override para testes — injeta um fetcher do sidecar. */
  rembgFetcher?: (
    buf: Buffer,
    opts?: {
      addShadow?: boolean;
      timeoutMs?: number;
      /** Metadados do round-trip (ex.: X-Rembg-Timing). Best-effort — só o
       *  fetcher default preenche; overrides de teste podem ignorar. */
      onMeta?: (meta: { timing?: string }) => void;
    },
  ) => Promise<Buffer>;
}

export interface ProcessUploadedImageResult {
  processed: Buffer;
  format: ProcessedImageFormat;
  removedBackground: boolean;
  shadowApplied?: boolean;
  warning?: string;
  width?: number;
  height?: number;
  /** Por que degradou (ausente quando o recorte saiu ou não foi pedido). */
  degradeReason?: RembgDegradeReason;
  /** Valor cru do header X-Rembg-Timing (só quando o sidecar respondeu com
   *  REMBG_PROFILE ligado). Persistível pela telemetria. */
  sidecarTiming?: string;
  /** Round-trip Node→sidecar em ms (só quando o fetcher foi chamado). */
  sidecarMs?: number;
}

/**
 * Aplica o pipeline padrão de pós-upload:
 *   1. autoOrient + strip de EXIF (privacidade + tamanho).
 *   2. Resize: garante mínimo 1000px no lado curto e máximo 1600px no
 *      lado longo. Web/ML/Shopee aceitam folgadamente.
 *   3. Se `removeBackground === true` e o sidecar rembg estiver
 *      disponível, envia a imagem para `${REMBG_SIDECAR_URL}/remove-bg`
 *      e devolve PNG transparente otimizado.
 *      Caso o sidecar esteja indisponível (offline, timeout, 5xx) ou o
 *      killswitch `REMBG_ENABLED=false`, cai em fallback: imagem
 *      otimizada SEM remoção, com `warning` no resultado.
 *   4. Se `removeBackground === false`, encoda WebP qualidade 88
 *      (≈40-50% menor que JPEG de qualidade equivalente).
 *
 * Nunca lança em erro do sidecar — degrada graceful. Lança apenas em
 * falhas de leitura/encode da imagem (input corrompido).
 */
export async function processUploadedImage(
  buf: Buffer,
  opts: ProcessUploadedImageOptions,
): Promise<ProcessUploadedImageResult> {
  const sharp = await getSharp();

  const tStart = profNow();

  // 1) Auto-orient via EXIF e descarta metadata. sharp.rotate() sem args
  // lê o EXIF Orientation e gira a imagem; o encode final descarta
  // qualquer metadata por default.
  let pipeline = sharp(buf, { failOnError: false }).rotate();

  const meta = await sharp(buf, { failOnError: false }).metadata();
  const inputWidth = meta.width || 0;
  const inputHeight = meta.height || 0;
  const tMeta = profNow();

  // 2) Resize para a janela [1000, 1600].
  if (inputWidth > 0 && inputHeight > 0) {
    const longEdge = Math.max(inputWidth, inputHeight);
    const shortEdge = Math.min(inputWidth, inputHeight);

    if (longEdge > UPLOAD_MAX_LONG_EDGE_PX) {
      pipeline = pipeline.resize({
        width: UPLOAD_MAX_LONG_EDGE_PX,
        height: UPLOAD_MAX_LONG_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      });
    } else if (shortEdge < UPLOAD_MIN_SHORT_EDGE_PX) {
      pipeline =
        inputWidth <= inputHeight
          ? pipeline.resize({ width: UPLOAD_MIN_SHORT_EDGE_PX })
          : pipeline.resize({ height: UPLOAD_MIN_SHORT_EDGE_PX });
    }
  }

  const normalized = await pipeline.toBuffer();
  const tNorm = profNow();

  // 3) Caminho com remoção de fundo: tenta o sidecar; em falha, degrada.
  if (opts.removeBackground) {
    // Telemetria aditiva (PR de observabilidade): por que degradou + timing do
    // sidecar. Não muda nenhuma decisão do pipeline — só enriquece o retorno.
    let degradeReason: RembgDegradeReason | undefined;
    let sidecarTiming: string | undefined;
    let sidecarMs: number | undefined;
    let fetchStartedAt: number | undefined;

    // Orçamento e gate ficam AQUI, no ramo do sidecar — nunca no topo da função.
    // O caminho `removeBackground=false` (sharp puro, ~1s) não pode ser
    // estrangulado por fila de recorte: é o fluxo mais rápido do produto.
    const budgetMs = computeSidecarTimeoutMs({ deadlineAt: opts.deadlineAt });
    const lane: RembgLane = opts.lane ?? "internal";

    // `slot === null` = não deu para entrar na fila dentro do orçamento. Nesse
    // caso NÃO chamamos o sidecar: uma inferência de ~9s que ninguém vai
    // esperar só rouba o worker de quem ainda pode ganhar.
    const sidecarAvailable = isRembgEnabled() || Boolean(opts.rembgFetcher);
    const slot =
      sidecarAvailable && isWorthCallingSidecar(budgetMs)
        ? await acquireRembgSlot(lane, budgetMs - SIDECAR_MIN_USEFUL_MS)
        : null;

    if (!sidecarAvailable) {
      // Antes este caminho degradava em silêncio absoluto — impossível separar
      // "killswitch ligado" de "nunca configurado" no diagnóstico de prod.
      degradeReason = "killswitch";
      console.warn(
        "[processUploadedImage] sidecar desabilitado (REMBG_ENABLED=false ou REMBG_SIDECAR_URL ausente); degradando para imagem otimizada sem remoção",
      );
    } else if (slot === null) {
      degradeReason = "budget_gate";
      console.warn(
        "[processUploadedImage] orçamento/fila do sidecar esgotados; degradando para imagem otimizada sem remoção:",
        { lane, budgetMs },
      );
    }

    if (slot !== null) {
      try {
        const fetcher = opts.rembgFetcher ?? defaultRembgFetcher;
        const addShadow = opts.addShadow === true;
        // Recalculado APÓS a espera no gate: o que sobrou do orçamento é o que
        // o round-trip ainda pode consumir. Sem `deadlineAt` devolve o
        // REMBG_TIMEOUT_MS de sempre (caminho feliz inalterado).
        const timeoutMs = computeSidecarTimeoutMs({
          deadlineAt: opts.deadlineAt,
        });
        // A espera no gate é limitada, mas jitter pode comer a sobra: se o que
        // restou não dá nem para uma inferência, desiste sem abrir a conexão.
        if (!isWorthCallingSidecar(timeoutMs)) {
          throw new BudgetAfterWaitError(
            `orçamento esgotado após espera na fila (restavam ${timeoutMs}ms)`,
          );
        }
        const onMeta = (meta: { timing?: string }) => {
          if (meta.timing) sidecarTiming = meta.timing;
        };
        let cutout: Buffer;
        fetchStartedAt = Date.now();
        try {
          cutout = await fetcher(normalized, { addShadow, timeoutMs, onMeta });
        } catch (err) {
          // Retry ÚNICO, apenas para erro de CONEXÃO (sidecar morto/reiniciando
          // pós OOM-kill): a conexão recusada falha em milissegundos, então uma
          // segunda tentativa após backoff curto recupera o recorte assim que o
          // container volta. NUNCA em timeout (a inferência pode ainda estar
          // rodando no worker único — repetir dobraria a carga) nem em resposta
          // HTTP 4xx/5xx (o sidecar respondeu; repetir não muda o resultado).
          // O slot do gate é MANTIDO durante o backoff: com o sidecar fora do
          // ar ninguém está inferindo, e re-adquirir jogaria esta requisição
          // para o fim da fila, estourando o orçamento.
          if (isRembgRetryDisabled() || !isRetryableConnectionError(err)) {
            throw err;
          }
          const afterBackoffMs =
            computeSidecarTimeoutMs({ deadlineAt: opts.deadlineAt }) -
            REMBG_RETRY_BACKOFF_MS;
          if (!isWorthCallingSidecar(afterBackoffMs)) {
            throw err;
          }
          console.warn(
            "[processUploadedImage] erro de conexão do sidecar; retry único após backoff:",
            err instanceof Error ? err.message : String(err),
          );
          await new Promise((resolve) =>
            setTimeout(resolve, REMBG_RETRY_BACKOFF_MS),
          );
          // Piso re-checado APÓS o backoff: se jitter comeu a sobra, degrada
          // em vez de despachar — e nunca entrega ≤0 ao fetcher (que trataria
          // como "sem deadline" e voltaria ao teto de 60s do env).
          const retryTimeoutMs = computeSidecarTimeoutMs({
            deadlineAt: opts.deadlineAt,
          });
          if (!isWorthCallingSidecar(retryTimeoutMs)) {
            throw err;
          }
          cutout = await fetcher(normalized, {
            addShadow,
            timeoutMs: retryTimeoutMs,
            onMeta,
          });
        }
        sidecarMs = Date.now() - fetchStartedAt;
        const tFetch = profNow();

        // A2: passthrough. O sidecar já devolve PNG RGBA pronto; re-encodar no
        // sharp (compressionLevel 9 + adaptiveFiltering) custava ~290ms num RGBA
        // ~1600px SEM mudar o pixel (PNG é lossless — medido: lvl9 só reduz ~9%
        // o arquivo). Passamos o buffer adiante e só LEMOS o header pra
        // width/height (decode de header, ~0.3ms). Guard: se não for um PNG com
        // dimensões válidas, caímos no re-encode defensivo; se o buffer for
        // ilegível, o sharp lança e o catch abaixo faz o fallback graceful.
        const cutMeta = await sharp(cutout).metadata();
        if (cutMeta.format === "png" && cutMeta.width && cutMeta.height) {
          if (REMBG_PROFILE) {
            console.log(
              `[node-profile] meta=${(tMeta - tStart).toFixed(1)} ` +
                `resize=${(tNorm - tMeta).toFixed(1)} ` +
                `roundtrip=${(tFetch - tNorm).toFixed(1)} ` +
                `passthrough=${(profNow() - tFetch).toFixed(1)} ` +
                `total=${(profNow() - tStart).toFixed(1)}ms ` +
                `shadow=${addShadow} in_bytes=${normalized.length} ` +
                `out_bytes=${cutout.length}`,
            );
          }
          return {
            processed: cutout,
            format: "png",
            removedBackground: true,
            shadowApplied: addShadow,
            width: cutMeta.width,
            height: cutMeta.height,
            ...(sidecarTiming ? { sidecarTiming } : {}),
            ...(sidecarMs !== undefined ? { sidecarMs } : {}),
          };
        }

        // Defensivo: sidecar devolveu algo que não é PNG c/ dimensões — re-encoda
        // como antes pra garantir o contrato (format:"png", transparência).
        const encoded = await sharp(cutout)
          .png({
            compressionLevel: UPLOAD_PNG_COMPRESSION,
            adaptiveFiltering: true,
          })
          .toBuffer();
        const outMeta = await sharp(encoded).metadata();
        return {
          processed: encoded,
          format: "png",
          removedBackground: true,
          shadowApplied: addShadow,
          width: outMeta.width,
          height: outMeta.height,
          ...(sidecarTiming ? { sidecarTiming } : {}),
          ...(sidecarMs !== undefined ? { sidecarMs } : {}),
        };
      } catch (err) {
        degradeReason = classifyDegradeReason(err);
        if (fetchStartedAt !== undefined) {
          sidecarMs = Date.now() - fetchStartedAt;
        }
        // Log diagnóstico expandido: inclui status HTTP + corpo da resposta
        // do sidecar quando disponível, para acelerar troubleshooting em prod.
        const extra: Record<string, unknown> = {};
        if (axios.isAxiosError(err)) {
          extra.status = err.response?.status;
          const data = err.response?.data;
          if (data instanceof Buffer) {
            extra.body = data.toString("utf8").slice(0, 500);
          } else if (typeof data === "string") {
            extra.body = data.slice(0, 500);
          } else if (data && typeof data === "object") {
            try {
              extra.body = JSON.stringify(data).slice(0, 500);
            } catch {
              /* ignore */
            }
          }
        }
        console.warn(
          "[processUploadedImage] sidecar rembg falhou; degradando para imagem otimizada sem remoção:",
          err instanceof Error ? err.message : String(err),
          extra,
        );
        // cai para o fallback abaixo
      } finally {
        // Sempre devolve o slot — inclusive nos `return` do caminho feliz acima.
        slot.release();
      }
    }

    // Killswitch, orçamento esgotado ou falha do sidecar → fallback graceful.
    const webp = await sharp(normalized)
      .webp({ quality: UPLOAD_WEBP_QUALITY, effort: 4 })
      .toBuffer();
    const outMeta = await sharp(webp).metadata();
    return {
      processed: webp,
      format: "webp",
      removedBackground: false,
      warning:
        "Remoção de fundo indisponível; usamos a imagem otimizada original.",
      width: outMeta.width,
      height: outMeta.height,
      ...(degradeReason ? { degradeReason } : {}),
      ...(sidecarTiming ? { sidecarTiming } : {}),
      ...(sidecarMs !== undefined ? { sidecarMs } : {}),
    };
  }

  // 4) Sem remoção: WebP otimizado.
  const webp = await sharp(normalized)
    .webp({ quality: UPLOAD_WEBP_QUALITY, effort: 4 })
    .toBuffer();
  const outMeta = await sharp(webp).metadata();
  return {
    processed: webp,
    format: "webp",
    removedBackground: false,
    width: outMeta.width,
    height: outMeta.height,
  };
}

function isRembgEnabled(): boolean {
  const url = process.env.REMBG_SIDECAR_URL;
  const enabled = (process.env.REMBG_ENABLED ?? "true").toLowerCase();
  return Boolean(url) && enabled !== "false";
}

/** Backoff antes do retry de conexão: cobre o gap accept→listen do sidecar
 *  voltando de um restart, sem segurar o slot do gate por tempo relevante. */
const REMBG_RETRY_BACKOFF_MS = 500;

/** Sentinela para "slot saiu do gate mas a sobra do orçamento não paga uma
 *  inferência". Só existe para a telemetria classificar sem casar mensagem. */
class BudgetAfterWaitError extends Error {}

/** Mapeia o erro do caminho de recorte para a causa da degradação. Não muda
 *  NENHUMA decisão do pipeline — é rótulo de telemetria puro. */
function classifyDegradeReason(err: unknown): RembgDegradeReason {
  if (err instanceof BudgetAfterWaitError) return "budget_after_wait";
  if (axios.isAxiosError(err)) {
    if (err.response) return "http_error";
    if (err.code === "ECONNABORTED") return "timeout";
    if (isRetryableConnectionError(err)) return "conn_error";
  }
  return "processing_error";
}

/** Kill-switch do retry (mesma convenção do REMBG_GATE_DISABLED). Lido por
 *  chamada para funcionar com edição de .env + restart, sem rebuild. */
function isRembgRetryDisabled(): boolean {
  const raw = (process.env.REMBG_RETRY_DISABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Só erros de CONEXÃO são retryáveis: o request nem chegou a ser processado,
 * então repetir não duplica trabalho no worker único do sidecar.
 * - `err.response` presente ⇒ houve resposta HTTP (4xx/5xx) ⇒ nunca retry.
 * - Timeout do axios ⇒ code `ECONNABORTED` ⇒ excluído por construção (a
 *   inferência pode ainda estar rodando; repetir dobraria a carga).
 * - `socket hang up` sem code ⇒ conexão morta no meio (kill do container).
 */
function isRetryableConnectionError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.response) return false;
  const code = err.code ?? "";
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code)) return true;
  return /socket hang up/i.test(err.message ?? "");
}

async function defaultRembgFetcher(
  buf: Buffer,
  opts?: {
    addShadow?: boolean;
    timeoutMs?: number;
    onMeta?: (meta: { timing?: string }) => void;
  },
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
  if (timing && typeof timing === "string") {
    try {
      opts?.onMeta?.({ timing });
    } catch {
      // metadados são best-effort — nunca derrubam o caminho do recorte.
    }
  }

  return Buffer.from(response.data);
}
