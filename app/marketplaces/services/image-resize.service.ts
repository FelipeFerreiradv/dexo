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

const ML_MIN_IMAGE_PX = 800;

const UPLOAD_MIN_SHORT_EDGE_PX = 1000;
const UPLOAD_MAX_LONG_EDGE_PX = 1600;
const UPLOAD_WEBP_QUALITY = 88;
const UPLOAD_PNG_COMPRESSION = 9;

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

export interface ProcessUploadedImageOptions {
  removeBackground: boolean;
  /** Override para testes — injeta um fetcher do sidecar. */
  rembgFetcher?: (buf: Buffer) => Promise<Buffer>;
}

export interface ProcessUploadedImageResult {
  processed: Buffer;
  format: ProcessedImageFormat;
  removedBackground: boolean;
  warning?: string;
  width?: number;
  height?: number;
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

  // 1) Auto-orient via EXIF e descarta metadata. sharp.rotate() sem args
  // lê o EXIF Orientation e gira a imagem; o encode final descarta
  // qualquer metadata por default.
  let pipeline = sharp(buf, { failOnError: false }).rotate();

  const meta = await sharp(buf, { failOnError: false }).metadata();
  const inputWidth = meta.width || 0;
  const inputHeight = meta.height || 0;

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

  // 3) Caminho com remoção de fundo: tenta o sidecar; em falha, degrada.
  if (opts.removeBackground) {
    if (isRembgEnabled() || opts.rembgFetcher) {
      try {
        const fetcher = opts.rembgFetcher ?? defaultRembgFetcher;
        const cutout = await fetcher(normalized);

        // Re-encode em PNG otimizado (preserva transparência).
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
          width: outMeta.width,
          height: outMeta.height,
        };
      } catch (err) {
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
      }
    }

    // Killswitch ou falha do sidecar → fallback graceful.
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

async function defaultRembgFetcher(buf: Buffer): Promise<Buffer> {
  const url = process.env.REMBG_SIDECAR_URL;
  if (!url) throw new Error("REMBG_SIDECAR_URL não configurado");
  const timeoutMs = Number(process.env.REMBG_TIMEOUT_MS ?? "15000");

  // O sidecar valida que content_type comece com "image/" — manter
  // consistente com o filename `input.png` e evitar 400 do FastAPI.
  const form = new FormData();
  form.append("file", buf, {
    filename: "input.png",
    contentType: "image/png",
  });

  const endpoint = url.replace(/\/+$/, "") + "/remove-bg";
  const response = await axios.post(endpoint, form, {
    headers: form.getHeaders(),
    responseType: "arraybuffer",
    timeout: timeoutMs,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
  });

  return Buffer.from(response.data);
}
