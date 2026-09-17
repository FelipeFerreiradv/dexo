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
  // `token revoked` fica: o lojista revogou o acesso de propósito e renovar
  // não traz o token de volta. As demais formas de falha de AUTENTICAÇÃO
  // saíram daqui — ver AUTH_PATTERNS logo abaixo.
  /token revoked/i,
  /item does not exist/i,
  /item_not_found/i,
  /listing not found/i,
];

/**
 * FALHA DE AUTENTICAÇÃO NÃO É DESTINO — é espera.
 *
 * Token expirado, 401, "invalid access token": nada disso diz que a baixa de
 * estoque é impossível. Diz que ela não pode ser feita AGORA, com ESTE token.
 * Tratar como terminal apagava o job e a baixa sumia; tratar como falha comum
 * queimava as seis tentativas em poucos minutos e terminava no mesmo lugar.
 *
 * O que isso custou, medido em 15/09/2026 (60 dias): 140 falhas de
 * autenticação em ~97 anúncios, e ZERO jobs sobreviventes — todos apagados.
 * Dos anúncios atingidos, 38 seguem no ar hoje vendendo peça sem saldo (20 no
 * Mercado Livre, 12 na Magalu, 6 na Shopee), em 15 lojistas. A correção do
 * estoque deles não está atrasada: ela foi apagada.
 *
 * O destino certo já existia no arquivo, escrito para o kill-switch: adiar sem
 * consumir tentativa, nunca apagar, e alertar se a espera passar de 24h. Falha
 * de autenticação entra pelo mesmo caminho.
 */
const AUTH_PATTERNS = [
  /unauthorized/i,
  /invalid_token/i,
  /invalid access token/i,
  /access_token/i,
  /\b401\b/,
  /\b403\b/,
];

/**
 * A RENOVAÇÃO do token falhou sem 401/403 no texto — na fila isso só chega
 * pela Shopee ("Erro ao renovar token: …", lançado de dentro de
 * refreshIfNeeded; o ML engole o erro de renovação e a baixa da Magalu não
 * renova). Não casava AUTH_PATTERNS e o job queimava as 6 tentativas: na pane
 * da partner key da Shopee (16/09/2026) 8 baixas foram APAGADAS assim e 3
 * anúncios seguiram no ar sem saldo.
 *
 * Só a falha PASSAGEIRA espera. Loja desvinculada ou refresh_token vencido (os
 * mesmos códigos de ShopeeOAuthService.TERMINAL_AUTH_ERRORS, que já marcam a
 * conta ERROR) seguem o caminho de antes: esperar para sempre faria cada
 * adiamento ressincronizar o PRODUTO inteiro — todos os anúncios, em todos os
 * canais — a cada 30 min, numa loja que não volta sem nova autorização.
 */
const REFRESH_FAILURE = /erro ao renovar token/i;
const REFRESH_TERMINAL = [/has no linked/i, /refresh_token expired/i];

const isTransientRefreshFailure = (message: string) =>
  REFRESH_FAILURE.test(message) &&
  !REFRESH_TERMINAL.some((re) => re.test(message));

/**
 * O CUSTO ACEITO, para quem for mexer nisto depois.
 *
 * Adiar em vez de apagar significa que o job de uma conta que nunca mais
 * reconectar fica na fila indefinidamente, sendo reagendado a cada meia hora.
 * Isso é deliberado — o alerta de 24h existe justamente para essa conta
 * aparecer para o operador — e o risco de entupir a fila é pequeno por dois
 * motivos medidos em 15/09/2026: a fila inteira tinha 12 linhas, e os jobs
 * nascem só de contas ACTIVE (o reconciliador e a vigília filtram por status,
 * e a baixa de pedido só toca os anúncios da peça vendida).
 *
 * Starvation também não acontece: a leitura ordena por `nextRunAt` crescente,
 * então job pronto agora sempre vem antes de job adiado para daqui a meia
 * hora. O que um job represado consome é uma linha na tabela, não a vez de
 * outro.
 */

const isAuthError = (message: string) =>
  AUTH_PATTERNS.some((re) => re.test(message)) ||
  isTransientRefreshFailure(message);

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
    // CLAIM ATÔMICO ENTRE PROCESSOS. Esta fila roda em DOIS lugares —
    // dexo-api (tick de 30s) e dexo-sync-orders (firePostEffects) — e a
    // versão anterior lia com findMany puro: a trava `runInProgress` é por
    // processo, então os dois podiam pegar o MESMO job e escrever duas vezes
    // no marketplace. O UPDATE abaixo é UMA statement (funciona no pooler em
    // transaction-mode): reserva os jobs empurrando o nextRunAt 90s à frente,
    // com SKIP LOCKED para dois ticks simultâneos nunca disputarem linha —
    // cada job sai para exatamente um processo. Se o processo morrer com o
    // job reservado, o lease de 90s expira sozinho e outro tick o pega; o
    // caminho de sucesso deleta e o de falha reescreve o nextRunAt, então o
    // lease nunca fica sujo.
    const jobs: StockSyncJobRow[] = await (prisma as any).$queryRaw`
      UPDATE "StockSyncJob"
      SET "nextRunAt" = now() + interval '90 seconds'
      WHERE id IN (
        SELECT id FROM "StockSyncJob"
        WHERE status = 'PENDING' AND "nextRunAt" <= now()
        ORDER BY "nextRunAt" ASC
        LIMIT ${BATCH_LIMIT}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, "productId", "listingId", platform, "targetStock",
                attempts, status, "createdAt", "lastError"
    `;

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
   * Reagenda um job que não pode ser executado AGORA, mas cuja baixa continua
   * necessária: empurra o `nextRunAt` e mantém `attempts` intacto (adiar não é
   * tentar e falhar). O job sobrevive até a condição passar.
   *
   * Dois motivos usam este caminho:
   *  - `kill-switch`: o operador desligou a integração da plataforma;
   *  - `auth`: o token da conta expirou, foi rejeitado ou voltou 401/403.
   *
   * Em ambos, apagar o job devolveria o oversell que ele existe para evitar.
   */
  private static async deferJob(
    job: {
      id: string;
      listingId: string;
      productId?: string;
      platform?: string;
      createdAt?: Date | string | null;
      lastError?: string | null;
    },
    motivo: "kill-switch" | "auth" = "kill-switch",
    detalhe?: string,
  ): Promise<void> {
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

    const base =
      motivo === "auth"
        ? `auth_pendente: reagendado (token da conta rejeitado)${
            detalhe ? ` — ${detalhe.slice(0, 300)}` : ""
          }`
        : "integration_disabled: reagendado (kill-switch ligado)";

    await (prisma as any).stockSyncJob.updateMany({
      where: { id: job.id },
      data: {
        nextRunAt,
        lastError:
          deveAlertar || jaAlertado ? `${base} ${DEFER_ALERT_MARK}` : base,
      },
    });

    if (!deveAlertar) return;

    const causa =
      motivo === "auth"
        ? `o token da conta ${job.platform ?? ""} está sendo rejeitado pelo canal. ` +
          `O job NÃO foi perdido e será processado assim que a conta for reconectada.`
        : `a integração ${job.platform ?? ""} segue desligada por kill-switch. ` +
          `O job NÃO foi perdido e será processado assim que a integração religar.`;

    const horas = Math.floor(deferredForMs / (60 * 60 * 1000));
    try {
      await SystemLogService.logError(
        "STOCK_SYNC_DEFERRED_TOO_LONG",
        `Baixa de estoque do listing ${job.listingId} está represada há ${horas}h: ${causa}`,
        {
          resource: "ProductListing",
          resourceId: job.listingId,
          details: {
            productId: job.productId,
            platform: job.platform,
            deferredForHours: horas,
            motivo,
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
    // ORDEM IMPORTA, e o teste de `token revoked` prova por quê: a mensagem
    // real do canal é "invalid_token: token revoked", que carrega os DOIS
    // vocabulários. Revogação é definitiva — renovar não traz o acesso de
    // volta —, então o terminal decide primeiro. Só o que sobra vai para a
    // espera por autenticação.
    if (isTerminalError(message, job.platform)) {
      await this.markFailed(job, message);
      return;
    }

    if (isAuthError(message)) {
      await this.deferJob(job, "auth", message);
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
