/**
 * ImageBgWorkerService — worker do RECORTE ASSÍNCRONO (PR 4).
 *
 * POR QUE EXISTE
 * --------------
 * A Fase 0 (29/07) provou que a mensagem "Remoção de fundo indisponível…" é
 * 100% um problema de TEMPO: num lote de 10 fotos, o último request chega a
 * 37s de fila JÁ em condição ideal — o orçamento síncrono de 45s estoura por
 * design. Este worker tira o recorte do caminho da requisição: o upload
 * responde na hora com a WebP otimizada e cria um ImageBgJob; aqui o recorte
 * roda com orçamento PRÓPRIO (IMAGE_BG_JOB_BUDGET_MS, default 10min) e
 * insiste com backoff até conseguir — "nunca desistir, só adiar".
 *
 * POR QUE IN-PROCESS (dexo-api), e não um processo pm2 separado: o gate de
 * concorrência do sidecar (rembg-gate) é um singleton POR PROCESSO. Um worker
 * externo não enxergaria os slots ocupados pelo tráfego síncrono
 * (/v1/images/process continua síncrono) e o sidecar de 1 worker seria
 * sobrecarregado. Aqui, o job passa pelo MESMO gate/lane que todo mundo.
 *
 * Molde: StockSyncRetryService (tick + runInProgress + backoff + terminal →
 * SystemLog), com duas adições: LEASE (PROCESSING com lease vencida volta a
 * PENDING — cobre pm2 restart no meio do job) e SWEEPS de swap pós-conclusão
 * (+2min/+10min — cobrem a corrida "produto salvo com a WebP depois do swap").
 *
 * KILL-SWITCH: UPLOAD_ASYNC_REMBG vazio/ausente => o worker nem inicia (e a
 * rota nem cria jobs). Jobs PENDING ficam inertes até religar.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import prisma from "@/app/lib/prisma";
import { SystemLogService } from "@/app/services/system-log.service";
import { processUploadedImage } from "./image-resize.service";
import { recordImageOutcome } from "./rembg-telemetry";
import { swapImageUrlReferences } from "./image-bg-swap";
import {
  externalRembgBreaker,
  localRembgBreaker,
} from "./rembg-breaker";
import {
  isLocalSidecarConfigured,
  readExternalProviderConfig,
} from "./rembg-providers";

const BACKOFF_SECONDS = [30, 120, 300, 900, 1800];
const LEASE_MS = 15 * 60 * 1000;
// Sweeps de swap: 1º aos +2min da conclusão, 2º aos +10min (2min + 8min).
const SWEEP_DELAYS_MS = [2 * 60 * 1000, 8 * 60 * 1000];
// Re-tentativa de um sweep cujo SWAP falhou (soluço de pooler): não consome
// o contador — só re-agenda.
const SWEEP_RETRY_MS = 2 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 1000;

const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function isAsyncBgEnabled(): boolean {
  const raw = (process.env.UPLOAD_ASYNC_REMBG ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function readJobBudgetMs(): number {
  const parsed = Number(process.env.IMAGE_BG_JOB_BUDGET_MS);
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : 600_000;
}

function readMaxAttempts(): number {
  const parsed = Number(process.env.IMAGE_BG_MAX_ATTEMPTS);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : BACKOFF_SECONDS.length;
}

function uploadsDir(): string {
  return join(process.cwd(), "public", "uploads");
}

function publicUrlFor(fileName: string): string {
  const baseUrl = process.env.APP_BACKEND_URL || "http://localhost:3333";
  return `${baseUrl}/uploads/${fileName}`;
}

type ImageBgJobRow = {
  id: string;
  uploadUuid: string;
  origFileName: string;
  webpFileName: string;
  addShadow: boolean;
  attempts: number;
  userId: string | null;
};

export class ImageBgWorkerService {
  private static running = false;
  private static intervalId: NodeJS.Timeout | null = null;
  private static runInProgress = false;

  static async runOnce(): Promise<void> {
    if (this.runInProgress) return;
    this.runInProgress = true;
    try {
      if (!isAsyncBgEnabled()) return; // lido por tick: liga/desliga por .env+restart
      await this.reclaimExpiredLeases();
      await this.runDueSweeps();
      await this.processNextJob();
    } catch (err) {
      console.error("[ImageBgWorker] tick falhou:", err);
    } finally {
      this.runInProgress = false;
    }
  }

  /** PROCESSING com lease vencida = worker morreu no meio (pm2 restart). */
  private static async reclaimExpiredLeases(): Promise<void> {
    const reclaimed = await (prisma as any).imageBgJob.updateMany({
      where: { status: "PROCESSING", leaseExpiresAt: { lt: new Date() } },
      data: { status: "PENDING", leaseExpiresAt: null, nextRunAt: new Date() },
    });
    if (reclaimed.count > 0) {
      console.warn(
        `[ImageBgWorker] ${reclaimed.count} job(s) recuperado(s) de lease vencida`,
      );
    }
  }

  /** Varreduras extras de swap: cobrem produto salvo APÓS o swap principal. */
  private static async runDueSweeps(): Promise<void> {
    const due = await (prisma as any).imageBgJob.findMany({
      where: {
        status: "COMPLETED",
        swapSweepsLeft: { gt: 0 },
        nextSweepAt: { lte: new Date() },
      },
      take: 10,
    });
    for (const job of due) {
      if (job.resultFileName && job.userId) {
        try {
          await swapImageUrlReferences({
            userId: job.userId,
            oldUrl: publicUrlFor(job.webpFileName),
            newUrl: publicUrlFor(job.resultFileName),
          });
        } catch (err) {
          // Sweep é a rede de segurança da corrida save-depois-do-swap:
          // falha de banco NÃO consome o contador — só re-agenda.
          console.error(
            `[ImageBgWorker] sweep de swap falhou para ${job.id}: ${errMsg(err)}`,
          );
          await (prisma as any).imageBgJob.update({
            where: { id: job.id },
            data: { nextSweepAt: new Date(Date.now() + SWEEP_RETRY_MS) },
          });
          continue;
        }
      }
      const remaining = job.swapSweepsLeft - 1;
      await (prisma as any).imageBgJob.update({
        where: { id: job.id },
        data: {
          swapSweepsLeft: remaining,
          nextSweepAt:
            remaining > 0
              ? new Date(Date.now() + SWEEP_DELAYS_MS[1])
              : null,
        },
      });
    }
  }

  /** PR 5: consulta os BREAKERS antes do claim — com falha de infra certa em
   *  todos os elos, claim só queimaria uma tentativa do backoff. Consulta
   *  PURA (peek): não reivindica a sonda HALF_OPEN. Importante: só o BREAKER
   *  segura o claim (estado transitório de ≤60s); "nada configurado"/
   *  killswitch preserva o comportamento do PR 4 (claim + degradação +
   *  backoff) — inclusive nos specs do worker, que mockam o
   *  processUploadedImage sem configurar env nenhuma. */
  private static anyProviderMightServe(): boolean {
    const localConfigured = isLocalSidecarConfigured();
    if (localConfigured && localRembgBreaker.peekAllowed()) return true;
    const externalCfg = readExternalProviderConfig();
    if (externalCfg !== null && externalRembgBreaker.peekAllowed()) return true;
    const breakerIsTheBlocker =
      (localConfigured && !localRembgBreaker.peekAllowed()) ||
      (externalCfg !== null && !externalRembgBreaker.peekAllowed());
    return !breakerIsTheBlocker;
  }

  /** Processa UM job por tick — o sidecar tem 1 worker; paralelizar aqui só
   *  criaria fila interna e roubaria os slots do tráfego síncrono. */
  private static async processNextJob(): Promise<void> {
    if (!this.anyProviderMightServe()) {
      return; // breaker(s) abertos/killswitch — espera o próximo tick
    }
    const candidate: ImageBgJobRow | null = await (
      prisma as any
    ).imageBgJob.findFirst({
      where: { status: "PENDING", nextRunAt: { lte: new Date() } },
      orderBy: { nextRunAt: "asc" },
      select: {
        id: true,
        uploadUuid: true,
        origFileName: true,
        webpFileName: true,
        addShadow: true,
        attempts: true,
        userId: true,
      },
    });
    if (!candidate) return;

    // Claim CAS: só processa se NINGUÉM mudou o status desde o findFirst.
    const claimed = await (prisma as any).imageBgJob.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: {
        status: "PROCESSING",
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return;
    const attempt = candidate.attempts + 1;

    // Teto TAMBÉM no claim: um job que DERRUBA o processo (crash nativo do
    // sharp, OOM) nunca chega ao handleFailure — sem este guard ele ficaria
    // no loop lease-expira→reclaim→claim para sempre.
    if (attempt > readMaxAttempts()) {
      await this.markFailed(
        candidate,
        `tentativas esgotadas (${candidate.attempts}) sem desfecho — processamento pode ter derrubado o processo`,
        Date.now(),
      );
      return;
    }

    const startedAt = Date.now();
    let buffer: Buffer;
    try {
      buffer = await readFile(join(uploadsDir(), candidate.origFileName));
    } catch (err) {
      // Original sumiu do disco = terminal (não adianta retry).
      await this.markFailed(
        candidate,
        `original ausente: ${errMsg(err)}`,
        startedAt,
      );
      return;
    }

    try {
      const jobBudgetMs = readJobBudgetMs();
      const result = await processUploadedImage(buffer, {
        removeBackground: true,
        addShadow: candidate.addShadow,
        // Mesma lane do modal: prioridade sobre o tráfego público, e o gate
        // continua limitando o total em voo no sidecar.
        lane: "internal",
        deadlineAt: Date.now() + jobBudgetMs,
        // Sem este override, o min() do orçamento prende cada tentativa ao
        // REMBG_TIMEOUT_MS do env (60s, calibrado para caber no nginx) e o
        // "orçamento de 10min" vira ilusão: foto com round-trip >60s
        // queimaria as 5 tentativas e viraria FAILED — a classe de falha
        // por TEMPO que este worker existe para eliminar. Aqui não há proxy
        // no caminho; o teto real é o lease (15min > 10min do budget).
        rembgTimeoutMs: jobBudgetMs,
        // Rastro LGPD caso o recorte saia pelo provedor externo (PR 5).
        tenantUserId: candidate.userId ?? undefined,
      });

      if (!result.removedBackground) {
        // Degradação dentro do orçamento folgado = sidecar indisponível ou
        // fila extrema — retry com backoff, nunca "desistir" antes do teto.
        await this.handleFailure(
          candidate,
          attempt,
          `degradou (${result.degradeReason ?? "sem-motivo"})`,
        );
        return;
      }

      const resultFileName = `${candidate.uploadUuid}.png`;
      await writeFile(join(uploadsDir(), resultFileName), result.processed);

      let swapError: string | null = null;
      if (candidate.userId) {
        try {
          await swapImageUrlReferences({
            userId: candidate.userId,
            oldUrl: publicUrlFor(candidate.webpFileName),
            newUrl: publicUrlFor(resultFileName),
          });
        } catch (err) {
          // O arquivo está pronto e o polling do front ainda troca na tela;
          // os sweeps re-tentam o swap de banco.
          swapError = errMsg(err);
          console.error(
            `[ImageBgWorker] swap falhou para ${candidate.id}: ${swapError}`,
          );
        }
      }

      await (prisma as any).imageBgJob.update({
        where: { id: candidate.id },
        data: {
          status: "COMPLETED",
          resultFileName,
          leaseExpiresAt: null,
          lastError: swapError ? `swap: ${swapError}`.slice(0, 500) : null,
          swapSweepsLeft: 2,
          nextSweepAt: new Date(Date.now() + SWEEP_DELAYS_MS[0]),
        },
      });

      recordImageOutcome({
        source: "worker",
        lane: "internal",
        result,
        durationMs: Date.now() - startedAt,
        userId: candidate.userId ?? undefined,
      });
      console.log(
        `[ImageBgWorker] job ${candidate.id} concluído em ${Date.now() - startedAt}ms (tentativa ${attempt})`,
      );
    } catch (err) {
      // processUploadedImage não lança por falha de sidecar (degrada), então
      // aqui é erro inesperado (disco, bug) — retry com backoff mesmo assim.
      await this.handleFailure(candidate, attempt, errMsg(err));
    }
  }

  private static async handleFailure(
    job: ImageBgJobRow,
    attempt: number,
    message: string,
  ): Promise<void> {
    if (attempt >= readMaxAttempts()) {
      await this.markFailed(job, message, Date.now());
      return;
    }
    const delaySec =
      BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)];
    await (prisma as any).imageBgJob.updateMany({
      where: { id: job.id },
      data: {
        status: "PENDING",
        leaseExpiresAt: null,
        nextRunAt: new Date(Date.now() + delaySec * 1000),
        lastError: message.slice(0, 500),
      },
    });
    console.warn(
      `[ImageBgWorker] job ${job.id} tentativa ${attempt} falhou (${message}); retry em ${delaySec}s`,
    );
  }

  private static async markFailed(
    job: ImageBgJobRow,
    message: string,
    startedAt: number,
  ): Promise<void> {
    await (prisma as any).imageBgJob.updateMany({
      where: { id: job.id },
      data: {
        status: "FAILED",
        leaseExpiresAt: null,
        lastError: message.slice(0, 500),
      },
    });
    recordImageOutcome({
      source: "worker",
      lane: "internal",
      result: { removedBackground: false, format: "webp" },
      durationMs: Date.now() - startedAt,
      userId: job.userId ?? undefined,
    });
    try {
      await SystemLogService.logError(
        "IMAGE_BG_JOB_FAILED",
        `Recorte assíncrono falhou em definitivo (job ${job.id}): ${message}`,
        {
          resource: "ImageBgJob",
          resourceId: job.id,
          details: { uploadUuid: job.uploadUuid, error: message },
        },
      );
    } catch (logErr) {
      console.error("[ImageBgWorker] falha ao registrar log terminal:", logErr);
    }
  }

  static start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
    console.log(`[ImageBgWorker] started (interval=${intervalMs}ms)`);
  }

  static stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.running = false;
  }
}
