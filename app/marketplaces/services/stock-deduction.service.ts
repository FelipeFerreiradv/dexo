import type { Prisma } from "@prisma/client";
import { Platform } from "@prisma/client";

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

/**
 * Plataformas em que o anúncio REALMENTE sai do ar quando o estoque zera por
 * venda de MARKETPLACE.
 *
 * ML: `updateItem({status:"paused"})`. OLX: `deleteAd` (a OLX não tem pausa).
 * Facebook: `setAvailability("out of stock")`.
 *
 * Shopee e Magalu ficam DE FORA, e a ausência é a parte importante: o
 * cancelamento de pedido nunca passou `pauseOnZero` (ver o comentário em
 * `OrderUseCase.deductStockForOrder`), e o sync a estoque zero desses dois só
 * empurra QUANTIDADE — `updateItemStock(0)` e `setStock(0)`. O anúncio
 * continua publicado, só sem unidade. Mandar `paused` para eles seria
 * DESPUBLICAR (`unlist_item`, `active:false`) algo que nunca saiu do ar — e
 * nenhuma rotina automática desfaz isso: não existe `unlist:false` nem
 * `active:true` em nenhum caminho de sync, só no botão manual da tela.
 *
 * ⚠️ Vale só para o caminho de PEDIDO. No balcão o `markPaid` passa
 * `pauseOnZero` (finance.usecase.ts), então lá os cinco canais saíram do ar de
 * verdade e o estorno pode devolver todos — por isso `FinanceUseCase.reverse`
 * NÃO usa esta lista.
 */
export const PLATAFORMAS_QUE_SAEM_DO_AR_POR_ESTOQUE: Platform[] = [
  Platform.MERCADO_LIVRE,
  Platform.OLX,
  Platform.FACEBOOK,
];
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
  /**
   * Opt-in — o ESPELHO de `reopenOnRefill`, para o tenant que desligou
   * `User.reopenListingsOnSaleCancel`: a peça volta ao estoque, mas o anúncio
   * NÃO pode voltar ao ar.
   *
   * POR QUE NÃO BASTA OMITIR `reopenOnRefill`.
   * Omitir só suprime o `updateItem({status:"active"})` — que nunca foi o que
   * reabria o anúncio no caminho de cancelamento. Quem reabre é o empurrão de
   * QUANTIDADE, que acontece sempre (o `runOnce()` logo abaixo é
   * incondicional, e tem de ser): o Mercado Livre tira sozinho o
   * `sub_status: out_of_stock` assim que `available_quantity` sobe, e
   * Shopee/Magalu voltam a vender porque no cancelamento de PEDIDO o anúncio
   * nunca chegou a ser despausado (não há `pauseOnZero` ali).
   *
   * Medido em produção (28/08): 5 anúncios ML da conta REBOOTEC, com a
   * preferência OFF desde 19/08, voltaram a `active` — o `last_updated` do
   * item no ML é, ao milissegundo, a nossa própria chamada de estoque.
   *
   * Por isso a única forma de cumprir a preferência é ADICIONAR uma pausa
   * DEPOIS que o estoque chega ao marketplace. Ver o encadeamento em
   * `firePostEffects`: a ordem é o ponto todo.
   *
   * Mesmo filtro do irmão: só produtos que saíram de zero.
   */
  keepPausedOnRefill?: { userId: string; platforms?: Platform[] };
  /**
   * Opcional, só para observabilidade: o mesmo `reason` que foi para o
   * StockLog. Enriquece o SystemLog de `STOCK_ZEROED_IN_ONE_MOVE`. Ausente =
   * o alerta ainda é gravado, apenas sem a origem do movimento.
   */
  reason?: string;
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

      // OBSERVABILIDADE (não altera o cálculo): um único movimento levou um
      // produto multi-unidade a zero. Com a aritmética acima isso só acontece
      // quando a quantidade vendida cobre TODO o saldo — legítimo em venda de
      // lote, suspeito em qualquer outro caso. Sem este sinal, uma zeragem
      // indevida de produto com 50 unidades fica invisível por semanas (foi o
      // que ocorreu com scripts/balcao-stock-fix.ts em 21-22/05/2026).
      // O SystemLog correspondente é gravado em firePostEffects (pós-commit).
      if (previousStock > 1 && newStock === 0) {
        console.warn(
          JSON.stringify({
            event: "stock.zeroed_in_one_move",
            productId: item.productId,
            previousStock,
            quantity: item.quantity,
            reason: input.reason,
          }),
        );
      }

      // Enfileira sync durável para cada listing vinculado ao produto.
      //
      // `select` e não `include`: destes registros o código usa exatamente DOIS
      // campos — `listing.id` e `marketplaceAccount.platform`. O `include`
      // trazia as 61 colunas de `ProductListing`, entre elas o JSON de
      // `compatDiagnostics` e o texto de `lastError`.
      //
      // MEDIDO em produção (25/08), sobre 402.305 linhas: 280 bytes por linha
      // inteira contra 52 bytes dos campos usados — 5,4× de desperdício, num
      // caminho que roda em TODA baixa de estoque (venda de balcão e pedido de
      // marketplace). É a regra "nenhuma leitura sem seleção explícita em
      // caminho recorrente" (scripts/docs/doc-ingestao-pedidos.tsx).
      //
      // A consulta continua sendo por item, e não em lote, DE PROPÓSITO: o
      // advisory lock é adquirido na ordem em que os listings saem daqui, e
      // agrupar mudaria essa ordem num caminho onde três produtores disputam a
      // mesma chave. Uma dedução típica tem 1–5 itens; o ganho do lote seria
      // marginal e o risco não é.
      const listings = await tx.productListing.findMany({
        where: { productId: item.productId },
        select: {
          id: true,
          marketplaceAccount: { select: { platform: true } },
        },
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

      // `select` e não `include` — mesmo motivo do gêmeo em `deductWithinTx`:
      // dois campos usados, 61 carregados. Ver a nota lá.
      const listings = await tx.productListing.findMany({
        where: { productId: item.productId },
        select: {
          id: true,
          marketplaceAccount: { select: { platform: true } },
        },
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
        )
        // ⚠️ ENCADEADO NO `runOnce`, e não num `setImmediate` próprio: a ordem
        // é a correção inteira. O empurrão de quantidade REABRE o anúncio (o
        // ML tira o `out_of_stock` sozinho; Shopee/Magalu voltam a vender), e
        // uma pausa disparada em paralelo poderia chegar ANTES dele e ser
        // desfeita. Mesmo desenho de `firePostReservationEffects`, que já
        // sequencia empurrar-e-reabrir no mesmo timer pelo motivo simétrico.
        //
        // O `.catch` acima já neutralizou a falha do runOnce: a pausa acontece
        // mesmo quando o sync falha — ali o anúncio nem chegou a reabrir, e
        // `pauseListings` é idempotente.
        .then(() => StockDeductionService.keepListingsPaused(input, logPrefix))
        .catch((err) =>
          console.error(
            `${logPrefix} Falha ao manter anuncios pausados (best-effort):`,
            err,
          ),
        );
    });

    // OBSERVABILIDADE (não altera comportamento): grava SystemLog para cada
    // produto multi-unidade que foi a zero num único movimento. Roda para
    // todos os callers, sem opt-in, porque o objetivo é justamente não depender
    // de ninguém lembrar de ligar. Em restauração o filtro nunca casa
    // (restoreWithinTx só aumenta o estoque). Best-effort e pós-commit: falha
    // aqui não afeta o estoque já persistido.
    const zeroedInOneMove = input.deductions.filter(
      (d) => d.previousStock > 1 && d.newStock === 0,
    );
    if (zeroedInOneMove.length > 0) {
      setImmediate(() => {
        void import("@/app/services/system-log.service")
          .then(async ({ SystemLogService }) => {
            for (const d of zeroedInOneMove) {
              await SystemLogService.logWarning(
                "STOCK_ZEROED_IN_ONE_MOVE",
                `Produto "${d.productName}" foi de ${d.previousStock} para 0 em um unico movimento`,
                {
                  resource: "Product",
                  resourceId: d.productId,
                  details: {
                    productId: d.productId,
                    productName: d.productName,
                    previousStock: d.previousStock,
                    newStock: d.newStock,
                    quantity: d.quantity,
                    reason: input.reason ?? null,
                  },
                },
              );
            }
          })
          .catch((err) =>
            console.error(
              `${logPrefix} Falha ao registrar SystemLog de zeragem em um movimento (best-effort):`,
              err,
            ),
          );
      });
    }

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

  /**
   * Espelho de `reopenOnRefill`: garante que o anúncio NÃO volte ao ar quando
   * o tenant desligou `User.reopenListingsOnSaleCancel`.
   *
   * Roda DEPOIS do `StockSyncRetryService.runOnce()` (ver o encadeamento em
   * `firePostEffects`), porque é o próprio empurrão de quantidade que reabre:
   *   · ML — `updateItemStock(qty>0)` faz o ML remover o `out_of_stock` e o
   *     item volta a `active` sozinho;
   *   · Shopee/Magalu — no cancelamento de PEDIDO o anúncio nunca foi
   *     despausado (sem `pauseOnZero`), então a quantidade restaurada basta;
   *   · OLX/Facebook — o sync republica / marca "in stock".
   *
   * `forceRemote: true` NÃO é opcional aqui: nesse instante o status LOCAL
   * pode estar em `paused` enquanto o remoto já voltou a `active`, e é
   * exatamente esse par que o fast-path `alreadyInState` de
   * `updateListingStatus` transformaria em no-op — justo no caso que importa.
   *
   * Best-effort e NUNCA lança: o cancelamento e o estorno de estoque já
   * commitaram, e nada aqui pode desfazê-los.
   */
  private static async keepListingsPaused(
    input: FirePostEffectsInput,
    logPrefix: string,
  ): Promise<void> {
    if (!input.keepPausedOnRefill) return;

    // Mesmo filtro do irmão: só o que SAIU de zero. Um produto que foi de 3
    // para 4 nunca teve anúncio pausado por falta de estoque — pausá-lo aqui
    // seria tirar do ar um anúncio que a preferência não governa.
    const refilled = input.deductions.filter(
      (d) => d.previousStock === 0 && d.newStock > 0,
    );
    if (refilled.length === 0) return;

    const { userId, platforms } = input.keepPausedOnRefill;
    try {
      const { ProductUseCase } = await import("@/app/usecases/product.usercase");
      const uc = new ProductUseCase();
      for (const d of refilled) {
        try {
          await uc.pauseListings(d.productId, userId, "paused", {
            forceRemote: true,
            // Ausente ⇒ todos os canais — é o caso do estorno de balcão, que
            // pausou os cinco ao receber a venda.
            ...(platforms ? { platforms } : {}),
          });
        } catch (err) {
          console.error(
            `${logPrefix} Falha ao manter pausados os anuncios do produto ${d.productId} (best-effort):`,
            err,
          );
        }
      }
    } catch (err) {
      console.error(
        `${logPrefix} Falha ao importar ProductUseCase para manter anuncios pausados:`,
        err,
      );
    }
  }
}
