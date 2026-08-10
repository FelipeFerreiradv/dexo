import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "../usecases/sync.usercase";
import { SystemLogService } from "@/app/services/system-log.service";

const BACKOFF_SECONDS = [30, 60, 120, 300, 900, 1800];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;
const BATCH_LIMIT = 100;

// Kill-switch ligado (OLX/FACEBOOK_INTEGRATION_DISABLED=1): reagenda o job p/
// mais tarde SEM consumir tentativa. Não é sucesso (não pode apagar o job, senão
// a baixa some e vira oversell) nem falha (não pode queimar as 6 tentativas e
// marcar FAILED enquanto o operador só desligou temporariamente).
const DISABLED_DEFER_SECONDS = 1800;

// Teto do adiamento. O job NUNCA é apagado por idade — apagar devolveria
// exatamente o oversell que o defer existe para evitar. O que o teto faz é
// PARAR DE SER SILENCIOSO: passadas 24h com o kill-switch ligado, cada job
// adiado emite um SystemLog de alerta UMA única vez (marcado no lastError,
// que é reescrito a cada defer) e segue reagendando normalmente.
const DISABLED_DEFER_ALERT_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFER_ALERT_MARK = "[alertado]";

const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// Vocabulário terminal ESCOPADO POR PLATAFORMA — mesmo desenho com que o
// ListingRetryService trata o vocabulário da Shopee. Um termo específico de um
// canal não pode decidir o destino do job de outro: `refused_` é definitivo na
// OLX, mas não significa nada no ML, e classificar por engano faz o job morrer
// sem nunca ter sido tentado de verdade.
const TERMINAL_PATTERNS_COMUNS = [
  /invalid_token/i,
  /token revoked/i,
  /item does not exist/i,
  /item_not_found/i,
  /listing not found/i,
  /unauthorized/i,
];

// Espelha classifyOlxRemoveError (listing-removal.helpers.ts): sem isto uma
// recusa definitiva da OLX (preço suspeito, sem slot, imagem pequena) era
// tratada como transitória e queimava as 6 tentativas do backoff.
// Os códigos -4 (validação) e -6 (permissão/plano) chegam aqui já achatados
// dentro da mensagem por olxRespError, por isso são casados como texto.
const TERMINAL_PATTERNS_OLX = [
  /refused_/i,
  /error_image_too_small/i,
  /not_enough_ad_slots/i,
  /statusCode\s*-4\b/i,
  /statusCode\s*-6\b/i,
  /ad_not_found/i,
];

// Graph API da Meta. O código numérico (190/100/200) NÃO chega até aqui —
// FacebookApiService.formatError monta só a mensagem —, então o casamento é
// por texto, que é o que de fato trafega.
const TERMINAL_PATTERNS_FACEBOOK = [
  /invalid oauth access token/i,
  /session has expired/i,
  /error validating access token/i,
  /oauthexception/i,
  /does not exist, cannot be loaded due to missing permission/i,
  /unsupported get request/i,
];

const TERMINAL_PATTERNS_POR_PLATAFORMA: Record<string, RegExp[]> = {
  OLX: TERMINAL_PATTERNS_OLX,
  FACEBOOK: TERMINAL_PATTERNS_FACEBOOK,
};

const isTerminalError = (message: string, platform?: string) => {
  if (TERMINAL_PATTERNS_COMUNS.some((re) => re.test(message))) return true;
  const especificos = platform
    ? TERMINAL_PATTERNS_POR_PLATAFORMA[platform]
    : undefined;
  return especificos ? especificos.some((re) => re.test(message)) : false;
};

type StockSyncJobRow = {
  id: string;
  productId: string;
  listingId: string;
  platform: string;
  targetStock: number;
  attempts: number;
  status: string;
  createdAt?: Date | string | null;
  lastError?: string | null;
};

/**
 * StockSyncRetryService
 *
 * Processa jobs duráveis de sincronização de estoque cross-marketplace.
 * Jobs são enfileirados por `OrderUseCase.deductStockForOrder` dentro da
 * mesma transação que decrementa o estoque local, garantindo que nenhum
 * decremento fique sem propagação aos marketplaces.
 *
 * Retry com backoff exponencial [30s, 60s, 120s, 300s, 900s, 1800s].
 * Falhas terminais (token revogado, listing inexistente) viram status FAILED
 * e disparam SystemLog de alerta.
 */
export class StockSyncRetryService {
  private static running = false;
  private static intervalId: NodeJS.Timeout | null = null;
  private static runInProgress = false;

  static async runOnce(): Promise<void> {
    // Evita sobreposição entre ticks do setInterval (batches > intervalo).
    // Dois workers pegariam o mesmo job e tentariam deletar em paralelo,
    // causando P2025 e chamadas duplicadas às APIs dos marketplaces.
    if (this.runInProgress) return;
    this.runInProgress = true;
    try {
      await this.runOnceInner();
    } finally {
      this.runInProgress = false;
    }
  }

  private static async runOnceInner(): Promise<void> {
    const now = new Date();

    const jobs: StockSyncJobRow[] = await (prisma as any).stockSyncJob.findMany({
      where: {
        status: "PENDING",
        nextRunAt: { lte: now },
      },
      orderBy: { nextRunAt: "asc" },
      take: BATCH_LIMIT,
    });

    if (jobs.length === 0) return;

    console.log(`[StockSyncRetryService] processing ${jobs.length} job(s)`);

    // Agrupar por productId para chamar syncProductStock uma única vez por produto.
    const byProduct = new Map<string, StockSyncJobRow[]>();
    for (const job of jobs) {
      const arr = byProduct.get(job.productId) ?? [];
      arr.push(job);
      byProduct.set(job.productId, arr);
    }

    for (const [productId, productJobs] of byProduct) {
      let results: Awaited<ReturnType<typeof SyncUseCase.syncProductStock>>;
      try {
        results = await SyncUseCase.syncProductStock(productId);
      } catch (err) {
        const message = errMsg(err);
        console.error(
          `[StockSyncRetryService] syncProductStock threw for ${productId}: ${message}`,
        );
        await Promise.all(
          productJobs.map((job) => this.handleFailure(job, message)),
        );
        continue;
      }

      // Indexar resultados por listingId — chave ÚNICA por anúncio.
      //
      // Antes a chave era `externalListingId`, que é o SKU em MAGALU, OLX e
      // FACEBOOK: um produto anunciado em duas dessas plataformas produzia dois
      // resultados com a MESMA chave, o Map guardava só o último e os dois jobs
      // liam o mesmo resultado. Se um lado tinha sucesso e o outro falha, os
      // dois jobs eram apagados e a baixa daquele canal se perdia — o anúncio
      // ficava no ar com a peça vendida (oversell).
      //
      // `listingId` vem do funil único de `syncProductStock`. O fallback por
      // `externalListingId` cobre resultados de caminhos que não o preencham,
      // preservando o comportamento anterior para eles.
      const resultByListingId = new Map<string, (typeof results)[number]>();
      const resultByExternalId = new Map<string, (typeof results)[number]>();
      for (const r of results) {
        if (r.listingId) resultByListingId.set(r.listingId, r);
        if (r.externalListingId) resultByExternalId.set(r.externalListingId, r);
      }

      const listingRows = await prisma.productListing.findMany({
        where: { id: { in: productJobs.map((j) => j.listingId) } },
        select: { id: true, externalListingId: true },
      });
      const listingMap = new Map(listingRows.map((l) => [l.id, l]));

      for (const job of productJobs) {
        const listing = listingMap.get(job.listingId);
        if (!listing) {
          await this.markFailed(job, "Listing removido");
          continue;
        }
        const r =
          resultByListingId.get(job.listingId) ??
          resultByExternalId.get(listing.externalListingId);
        if (!r) {
          await this.handleFailure(job, "Sem resultado da sincronização");
          continue;
        }
        // Integração desligada: o sync devolve success:true + skipped (nenhuma
        // chamada saiu). NÃO apagar o job — a baixa precisa reprocessar quando o
        // operador religar. Reagenda sem consumir tentativa (evita oversell).
        if (r.skipped && r.skipReason === "integration_disabled") {
          await this.deferJob(job);
          continue;
        }
        if (r.success) {
          // deleteMany é idempotente: não lança P2025 se outro tick já removeu o job.
          await (prisma as any).stockSyncJob.deleteMany({
            where: { id: job.id },
          });
        } else {
          await this.handleFailure(job, r.error ?? "Erro desconhecido");
        }
      }
    }
  }

  /**
   * Reagenda um job cuja plataforma está com o kill-switch ligado: empurra o
   * nextRunAt e mantém `attempts` intacto (o adiamento não é uma tentativa
   * falha). O job sobrevive até o operador religar a integração.
   */
  private static async deferJob(job: {
    id: string;
    listingId: string;
    productId?: string;
    platform?: string;
    createdAt?: Date | string | null;
    lastError?: string | null;
  }): Promise<void> {
    const nextRunAt = new Date(Date.now() + DISABLED_DEFER_SECONDS * 1000);

    // Teto por idade: só muda a VISIBILIDADE do problema, nunca o destino do
    // job. Um adiamento que já dura mais de 24h deixou de ser "o operador
    // desligou por um instante" e virou baixa de estoque parada — o operador
    // precisa saber. Alerta uma vez só: o marcador vive no próprio lastError.
    const createdAtMs = job.createdAt ? new Date(job.createdAt).getTime() : NaN;
    const deferredForMs = Number.isFinite(createdAtMs)
      ? Date.now() - createdAtMs
      : 0;
    const jaAlertado = (job.lastError ?? "").includes(DEFER_ALERT_MARK);
    const deveAlertar =
      deferredForMs > DISABLED_DEFER_ALERT_AFTER_MS && !jaAlertado;

    await (prisma as any).stockSyncJob.updateMany({
      where: { id: job.id },
      data: {
        nextRunAt,
        lastError:
          deveAlertar || jaAlertado
            ? `integration_disabled: reagendado (kill-switch ligado) ${DEFER_ALERT_MARK}`
            : "integration_disabled: reagendado (kill-switch ligado)",
      },
    });

    if (!deveAlertar) return;

    const horas = Math.floor(deferredForMs / (60 * 60 * 1000));
    try {
      await SystemLogService.logError(
        "STOCK_SYNC_DEFERRED_TOO_LONG",
        `Baixa de estoque do listing ${job.listingId} está represada há ${horas}h: ` +
          `a integração ${job.platform ?? ""} segue desligada por kill-switch. ` +
          `O job NÃO foi perdido e será processado assim que a integração religar.`,
        {
          resource: "ProductListing",
          resourceId: job.listingId,
          details: {
            productId: job.productId,
            platform: job.platform,
            deferredForHours: horas,
          },
        },
      );
    } catch (logErr) {
      console.error(
        "[StockSyncRetryService] Falha ao registrar alerta de adiamento:",
        logErr,
      );
    }
  }

  private static async handleFailure(
    job: {
      id: string;
      attempts: number;
      productId: string;
      listingId: string;
      platform?: string;
    },
    message: string,
  ): Promise<void> {
    if (isTerminalError(message, job.platform)) {
      await this.markFailed(job, message);
      return;
    }

    const nextAttempts = job.attempts + 1;
    if (nextAttempts >= MAX_ATTEMPTS) {
      await this.markFailed(job, message);
      return;
    }

    const delaySec = BACKOFF_SECONDS[nextAttempts] ?? BACKOFF_SECONDS[MAX_ATTEMPTS - 1];
    const nextRunAt = new Date(Date.now() + delaySec * 1000);

    await (prisma as any).stockSyncJob.update({
      where: { id: job.id },
      data: {
        attempts: nextAttempts,
        nextRunAt,
        lastError: message.slice(0, 500),
      },
    });
  }

  private static async markFailed(
    job: { id: string; productId: string; listingId: string },
    message: string,
  ): Promise<void> {
    // Deleta o job em vez de transicionar status — o unique constraint
    // @@unique([listingId, status]) em StockSyncJob impede manter linhas
    // históricas FAILED/SUCCESS na mesma listing (colide com próximo enqueue).
    // Histórico de falha terminal fica preservado em SystemLog (logError abaixo).
    await (prisma as any).stockSyncJob.deleteMany({
      where: { id: job.id },
    });

    try {
      await SystemLogService.logError(
        "STOCK_SYNC_FAILED",
        `Sincronização de estoque falhou em definitivo para listing ${job.listingId}: ${message}`,
        {
          resource: "ProductListing",
          resourceId: job.listingId,
          details: { productId: job.productId, error: message },
        },
      );
    } catch (logErr) {
      console.error(
        "[StockSyncRetryService] Falha ao registrar log terminal:",
        logErr,
      );
    }
  }

  static start(intervalMs = 30 * 1000) {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      void this.runOnce().catch((err) => {
        console.error("[StockSyncRetryService] runOnce failed:", err);
      });
    }, intervalMs);
    console.log(
      `[StockSyncRetryService] started (interval=${intervalMs}ms, maxAttempts=${MAX_ATTEMPTS})`,
    );
  }

  static stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.running = false;
  }
}
