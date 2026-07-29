/**
 * Telemetria do pipeline de remoção de fundo (rembg).
 *
 * POR QUE EXISTE
 * --------------
 * A métrica nº 1 do pipeline — a TAXA DE FALLBACK (uploads com remoção pedida
 * que voltaram sem recorte, com o warning "Remoção de fundo indisponível…") —
 * não era medida em lugar nenhum: só dava para estimá-la garimpando o pm2
 * error.log. Este módulo dá dois canais, ambos aditivos:
 *
 *  1. RING BUFFER in-process (últimos 50 eventos): diagnóstico "agora" via
 *     GET /internal/rembg/status, sem custo de banco, sempre ligado (é um
 *     push em array — nanossegundos).
 *  2. SystemLog persistido (actions IMAGE_BG_REMOVED / IMAGE_BG_FALLBACK),
 *     atrás de IMAGE_PIPELINE_METRICS: é o histórico consultável que produz a
 *     taxa por janela. Fire-and-forget — NUNCA no caminho da resposta.
 *
 * KILL-SWITCH: IMAGE_PIPELINE_METRICS vazio/ausente => nenhuma escrita nova em
 * banco (comportamento de hoje). Com "1", cada upload com removeBackground
 * grava 1 linha de SystemLog (volume: dezenas–centenas/dia — irrisório).
 */

import prisma from "../../lib/prisma";
import { SystemLogService } from "../../services/system-log.service";
import type {
  ProcessUploadedImageResult,
  RembgDegradeReason,
} from "./image-resize.service";
import type { RembgLane } from "./rembg-gate";

export type ImageEventSource = "upload" | "public" | "worker";

export interface ImagePipelineEvent {
  at: string; // ISO
  source: ImageEventSource;
  lane: RembgLane;
  /** true = recorte entregue; false = degradou (o warning foi emitido). */
  ok: boolean;
  reason?: RembgDegradeReason;
  durationMs: number;
  sidecarMs?: number;
}

const RING_MAX = 50;
const ring: ImagePipelineEvent[] = [];

/** Lido POR CHAMADA (mesma convenção do REMBG_RETRY_DISABLED): funciona com
 *  edição de .env + pm2 restart, sem rebuild. */
export function isImageMetricsEnabled(): boolean {
  const raw = (process.env.IMAGE_PIPELINE_METRICS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Snapshot dos últimos eventos (mais recente por último). */
export function getRecentImageEvents(): ImagePipelineEvent[] {
  return [...ring];
}

/** Necessário no beforeEach dos testes — o ring é estado de módulo. */
export function __resetImageTelemetry(): void {
  ring.length = 0;
}

export interface RecordImageOutcomeInput {
  source: ImageEventSource;
  lane: RembgLane;
  /** Resultado do processUploadedImage (só os campos de telemetria são lidos). */
  result: Pick<
    ProcessUploadedImageResult,
    | "removedBackground"
    | "degradeReason"
    | "sidecarTiming"
    | "sidecarMs"
    | "format"
    | "width"
    | "height"
  >;
  /** Tempo total do handler (ms), medido pela rota. */
  durationMs: number;
  userId?: string;
}

/**
 * Registra o desfecho de UMA tentativa de recorte (chamar apenas quando
 * removeBackground foi pedido — a taxa é sobre quem pediu recorte).
 *
 * Sincrona do ponto de vista do chamador: o ring é imediato e a escrita de
 * SystemLog (quando habilitada) é despachada sem await. Nunca lança.
 */
export function recordImageOutcome(input: RecordImageOutcomeInput): void {
  try {
    const ok = input.result.removedBackground === true;
    ring.push({
      at: new Date().toISOString(),
      source: input.source,
      lane: input.lane,
      ok,
      ...(input.result.degradeReason
        ? { reason: input.result.degradeReason }
        : {}),
      durationMs: input.durationMs,
      ...(input.result.sidecarMs !== undefined
        ? { sidecarMs: input.result.sidecarMs }
        : {}),
    });
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);

    if (!isImageMetricsEnabled()) return;

    const details = {
      source: input.source,
      lane: input.lane,
      durationMs: input.durationMs,
      ...(input.result.degradeReason
        ? { reason: input.result.degradeReason }
        : {}),
      ...(input.result.sidecarMs !== undefined
        ? { sidecarMs: input.result.sidecarMs }
        : {}),
      ...(input.result.sidecarTiming
        ? { sidecarTiming: input.result.sidecarTiming }
        : {}),
      format: input.result.format,
      widthPx: input.result.width,
      heightPx: input.result.height,
    };
    // SystemLogService.log já engole erros internamente; o void garante que
    // nada disso entra no caminho da resposta.
    if (ok) {
      void SystemLogService.logInfo("IMAGE_BG_REMOVED", "Fundo removido", {
        userId: input.userId,
        resource: "ImagePipeline",
        details,
      });
    } else {
      void SystemLogService.logWarning(
        "IMAGE_BG_FALLBACK",
        `Remoção de fundo degradou (${input.result.degradeReason ?? "sem-motivo"})`,
        {
          userId: input.userId,
          resource: "ImagePipeline",
          details,
        },
      );
    }
  } catch (err) {
    // Telemetria jamais derruba um upload.
    console.error("[rembg-telemetry] falha ao registrar evento:", err);
  }
}

export interface FallbackWindowStats {
  total: number;
  fallback: number;
  /** % com 1 casa, ou null quando não houve nenhum evento na janela. */
  ratePct: number | null;
}

/**
 * Taxa de fallback desde `since`, via 2 COUNTs no SystemLog (usa o índice
 * (action, createdAt) — DDL manual, espelhado no schema). Só faz sentido com
 * IMAGE_PIPELINE_METRICS ligado há tempo suficiente.
 */
export async function getFallbackStats(
  since: Date,
): Promise<FallbackWindowStats> {
  const [removed, fallback] = await Promise.all([
    prisma.systemLog.count({
      where: { action: "IMAGE_BG_REMOVED", createdAt: { gte: since } },
    }),
    prisma.systemLog.count({
      where: { action: "IMAGE_BG_FALLBACK", createdAt: { gte: since } },
    }),
  ]);
  const total = removed + fallback;
  return {
    total,
    fallback,
    ratePct: total > 0 ? Math.round((fallback / total) * 1000) / 10 : null,
  };
}
