import type { Prisma } from "@prisma/client";

/**
 * Serviço compartilhado de baixa atômica de estoque.
 *
 * Extraído mecanicamente de `OrderUseCase.deductStockForOrder` (Fase 3 do
 * plano venda-balcão). A lógica é IDÊNTICA ao caminho original; este arquivo
 * concentra o núcleo in-transação + efeitos pós-commit para ser reutilizado
 * pelo `FinanceUseCase.markPaid` (Fase 6) sem duplicar código.
 *
 * Design:
 *  - `deductWithinTx(tx, input)` faz APENAS o trabalho dentro da transação
 *    (FOR UPDATE → update stock → stockLog → advisory lock → upsert do
 *    StockSyncJob). NÃO abre transação. NÃO dispara efeitos pós-commit.
 *  - `firePostEffects(input)` faz APENAS os efeitos pós-commit não-bloqueantes
 *    (setImmediate → StockSyncRetryService.runOnce e, opt-in, pauseListings
 *    para produtos zerados). Síncrono (void). NÃO faz o log de oversell — esse
 *    fica com o caller, pois message/details variam por contexto.
 *
 * REGRA ZERO: o caller `OrderUseCase.deductStockForOrder` mantém comportamento
 * byte-idêntico ao anterior — mesmos opts de tx, mesmos logs (via logPrefix),
 * mesma forma de oversell log, mesmo retorno.
 */

export interface StockDeductionItem {
  productId: string;
  quantity: number;
}

export interface StockDeductionResult {
  productId: string;
  productName: string;
  previousStock: number;
  newStock: number;
  quantity: number;
}

export interface StockOversellAlert {
  productId: string;
  productName: string;
  requested: number;
  available: number;
}

export interface DeductWithinTxInput {
  items: StockDeductionItem[];
  /** Vai para `StockLog.reason` (ex.: "Venda ML #123", "Venda balcão — Conta a Receber X"). */
  reason: string;
  /** Vai para `StockSyncJob.orderId` (campo String? sem FK — anotação livre). */
  orderId?: string | null;
  /** Preserva prefixo de log do caller (ex.: "[OrderUseCase]"). Default: "[StockDeductionService]". */
  logPrefix?: string;
}

export interface FirePostEffectsInput {
  deductions: StockDeductionResult[];
  /** Preserva prefixo de log do caller. */
  logPrefix?: string;
  /**
   * Opt-in: ao detectar `newStock === 0` em qualquer item, pausa os anúncios
   * do produto em ML/Shopee via `ProductUseCase.pauseListings` (idempotente,
   * best-effort, em `setImmediate` — não trava o caller). Order NÃO usa
   * (preserva comportamento atual); venda balcão (Fase 7) usa.
   */
  pauseOnZero?: { userId: string };
  /**
   * Opt-in (Fase 9 — estorno): ao detectar `previousStock === 0 && newStock > 0`
   * (estoque saiu de zero), reabre os anúncios via `pauseListings(_, _, "active")`.
   * Espelho de `pauseOnZero` para o caminho de restore. Idempotente,
   * best-effort. Usado pelo `FinanceUseCase.reverse` e (com `force`) pelo
   * cancelamento de pedido marketplace.
   *
   * `force` (opcional, default = comportamento atual): força a chamada à API
   * mesmo quando o status LOCAL do anúncio já é "active". Necessário no
   * cancelamento de pedido: quando o estoque zera por venda de marketplace,
   * o sync pausa o item ML só REMOTAMENTE (status local segue "active") e o
   * fast-path alreadyInState faria no-op, deixando o anúncio pausado para
   * sempre apesar do estoque restaurado.
   */
  reopenOnRefill?: { userId: string; force?: boolean };
}

export class StockDeductionService {
  /**
   * Núcleo in-transação. O caller é responsável por abrir o `$transaction`
   * com os opts que quiser (Order usa `{ timeout: 60_000, maxWait: 20_000 }`).
   */
  static async deductWithinTx(
    tx: Prisma.TransactionClient,
    input: DeductWithinTxInput,
  ): Promise<{
    deductions: StockDeductionResult[];
    oversellAlerts: StockOversellAlert[];
  }> {
    const deductions: StockDeductionResult[] = [];
    const oversellAlerts: StockOversellAlert[] = [];
    const logPrefix = input.logPrefix ?? "[StockDeductionService]";

    for (const item of input.items) {
      // Lock da linha do produto até o fim da transação.
      const locked = await tx.$queryRaw<
        { id: string; name: string; stock: number }[]
      >`SELECT id, name, stock FROM "Product" WHERE id = ${item.productId} FOR UPDATE`;

      const product = locked[0];
      if (!product) continue;

      const previousStock = product.stock;
      const decrementBy = Math.min(item.quantity, Math.max(0, previousStock));
      const newStock = previousStock - decrementBy;

      await tx.product.update({
        where: { id: item.productId },
        data: { stock: newStock },
      });

      await tx.stockLog.create({
        data: {
          productId: item.productId,
          change: -decrementBy,
          reason: input.reason,
          previousStock,
          newStock,
        },
      });

      deductions.push({
        productId: item.productId,
        productName: product.name,
        previousStock,
        newStock,
        quantity: item.quantity,
      });

      if (decrementBy < item.quantity) {
        oversellAlerts.push({
          productId: item.productId,
          productName: product.name,
          requested: item.quantity,
          available: previousStock,
        });
      }

      console.log(
        `${logPrefix} Stock deducted: ${product.name} (${previousStock} → ${newStock})`,
      );

      // Enfileira sync durável para cada listing vinculado ao produto.
      const listings = await tx.productListing.findMany({
        where: { productId: item.productId },
        include: { marketplaceAccount: { select: { platform: true } } },
      });

      for (const listing of listings) {
        // Serializa com StockReconciliationService pelo mesmo listing para
        // evitar P2002 no upsert não-atômico do Prisma: ambos lados pegam
        // o mesmo advisory lock antes de SELECT/INSERT.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock_sync_job:" + listing.id}))`;

        await tx.stockSyncJob.upsert({
          where: {
            listingId_status: {
              listingId: listing.id,
              status: "PENDING",
            },
          },
          create: {
            productId: item.productId,
            listingId: listing.id,
            platform: listing.marketplaceAccount.platform,
            targetStock: newStock,
            orderId: input.orderId ?? null,
            status: "PENDING",
          },
          update: {
            targetStock: newStock,
            attempts: 0,
            nextRunAt: new Date(),
            lastError: null,
            orderId: input.orderId ?? null,
          },
        });
      }
    }

    return { deductions, oversellAlerts };
  }

  /**
   * Fase 9 — Restaura estoque dentro de uma transação (espelho invertido de
   * `deductWithinTx`). Usado pelo `FinanceUseCase.reverse` ao estornar
   * conta PAGA. Estrutura idêntica:
   *  - `SELECT … FOR UPDATE` para serializar com webhooks concorrentes.
   *  - `product.update` somando `quantity` ao estoque atual.
   *  - `stockLog.create` com `change: +quantity` (positivo, distingue de
   *    deduções).
   *  - `pg_advisory_xact_lock` por listing + `stockSyncJob.upsert` com
   *    `targetStock = newStock` (estoque restaurado) — propaga aos
   *    marketplaces via `runOnce` na fase pós-commit.
   * Diferenças em relação ao `deductWithinTx`:
   *  - Sem clamping (estoque sempre sobe `+quantity`).
   *  - Sem oversellAlerts (não faz sentido em restauração).
   *  - `change` no StockLog é positivo, não negativo.
   */
  static async restoreWithinTx(
    tx: Prisma.TransactionClient,
    input: DeductWithinTxInput,
  ): Promise<{ deductions: StockDeductionResult[] }> {
    const restorations: StockDeductionResult[] = [];
    const logPrefix = input.logPrefix ?? "[StockDeductionService]";

    for (const item of input.items) {
      const locked = await tx.$queryRaw<
        { id: string; name: string; stock: number }[]
      >`SELECT id, name, stock FROM "Product" WHERE id = ${item.productId} FOR UPDATE`;

      const product = locked[0];
      if (!product) continue;

      const previousStock = product.stock;
      const restoreBy = item.quantity;
      const newStock = previousStock + restoreBy;

      await tx.product.update({
        where: { id: item.productId },
        data: { stock: newStock },
      });

      await tx.stockLog.create({
        data: {
          productId: item.productId,
          change: +restoreBy, // positivo: distingue claramente de deduções
          reason: input.reason,
          previousStock,
          newStock,
        },
      });

      // O mesmo formato de StockDeductionResult — facilita o consumidor
      // (firePostEffects) tratar deduct/restore com a mesma interface.
      // `quantity` aqui é a magnitude positiva restaurada.
      restorations.push({
        productId: item.productId,
        productName: product.name,
        previousStock,
        newStock,
        quantity: item.quantity,
      });

      console.log(
        `${logPrefix} Stock restored: ${product.name} (${previousStock} → ${newStock})`,
      );

      const listings = await tx.productListing.findMany({
        where: { productId: item.productId },
        include: { marketplaceAccount: { select: { platform: true } } },
      });

      for (const listing of listings) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock_sync_job:" + listing.id}))`;

        await tx.stockSyncJob.upsert({
          where: {
            listingId_status: {
              listingId: listing.id,
              status: "PENDING",
            },
          },
          create: {
            productId: item.productId,
            listingId: listing.id,
            platform: listing.marketplaceAccount.platform,
            targetStock: newStock,
            orderId: input.orderId ?? null,
            status: "PENDING",
          },
          update: {
            targetStock: newStock,
            attempts: 0,
            nextRunAt: new Date(),
            lastError: null,
            orderId: input.orderId ?? null,
          },
        });
      }
    }

    // Retornamos como `deductions` para casar com a interface do
    // FirePostEffectsInput — semanticamente são "movimentações de estoque",
    // o sinal indica direção (sempre positivo aqui).
    return { deductions: restorations };
  }

  /**
   * Efeitos pós-commit. NÃO-bloqueante: ambos os side-effects rodam em
   * `setImmediate`, então erros não param o caller (e o caller já commitou
   * a transação, então estoque está persistido independentemente do que
   * acontecer aqui).
   *
   * NÃO faz o log de oversell — o caller faz, com message/details específicos
   * do seu contexto (Order, Receivable, etc.).
   */
  static firePostEffects(input: FirePostEffectsInput): void {
    if (input.deductions.length === 0) return;

    const logPrefix = input.logPrefix ?? "[StockDeductionService]";

    // Dispara processamento imediato dos jobs recém-enfileirados (best-effort;
    // se falhar, o interval do service pegará no próximo ciclo).
    setImmediate(() => {
      void import("./stock-sync-retry.service")
        .then(({ StockSyncRetryService }) => StockSyncRetryService.runOnce())
        .catch((err) =>
          console.error(
            `${logPrefix} Falha ao disparar StockSyncRetryService.runOnce:`,
            err,
          ),
        );
    });

    // Pausa-ao-zerar é OPT-IN por caller (venda balcão na Fase 7). Order não
    // passa esse campo → comportamento atual preservado.
    if (input.pauseOnZero) {
      const zeroed = input.deductions.filter((d) => d.newStock === 0);
      if (zeroed.length > 0) {
        const { userId } = input.pauseOnZero;
        setImmediate(() => {
          void import("@/app/usecases/product.usercase")
            .then(async ({ ProductUseCase }) => {
              const uc = new ProductUseCase();
              for (const d of zeroed) {
                try {
                  await uc.pauseListings(d.productId, userId, "paused");
                } catch (err) {
                  console.error(
                    `${logPrefix} Falha ao pausar anuncios do produto ${d.productId} (best-effort):`,
                    err,
                  );
                }
              }
            })
            .catch((err) =>
              console.error(
                `${logPrefix} Falha ao importar ProductUseCase para pausar anuncios:`,
                err,
              ),
            );
        });
      }
    }

    // Fase 9 — Reabrir-ao-restaurar: opt-in para o caminho de estorno
    // (FinanceUseCase.reverse). Filtra produtos que SAÍRAM de zero
    // (previousStock===0 && newStock>0): foram pausados quando zeraram
    // (via pauseOnZero), e agora têm estoque novamente. pauseListings com
    // status "active" é idempotente — anúncios que já estão active são
    // contados como alreadyInState. Best-effort, mesmo padrão.
    if (input.reopenOnRefill) {
      const refilled = input.deductions.filter(
        (d) => d.previousStock === 0 && d.newStock > 0,
      );
      if (refilled.length > 0) {
        const { userId, force } = input.reopenOnRefill;
        setImmediate(() => {
          void import("@/app/usecases/product.usercase")
            .then(async ({ ProductUseCase }) => {
              const uc = new ProductUseCase();
              for (const d of refilled) {
                try {
                  // Aridade condicional: sem force, chamada byte-idêntica à
                  // atual (3 args) — preserva o caminho do reverse.
                  if (force) {
                    await uc.pauseListings(d.productId, userId, "active", {
                      forceRemote: true,
                    });
                  } else {
                    await uc.pauseListings(d.productId, userId, "active");
                  }
                } catch (err) {
                  console.error(
                    `${logPrefix} Falha ao reabrir anuncios do produto ${d.productId} (best-effort):`,
                    err,
                  );
                }
              }
            })
            .catch((err) =>
              console.error(
                `${logPrefix} Falha ao importar ProductUseCase para reabrir anuncios:`,
                err,
              ),
            );
        });
      }
    }
  }
}
