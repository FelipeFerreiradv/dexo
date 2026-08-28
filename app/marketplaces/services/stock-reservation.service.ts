import prisma from "../../lib/prisma";
import { resolveReopenPrefForOwners } from "../../services/reopen-listings-preference";
import {
  availableForSale,
  isStockReservationEnabled,
  isStockReservationSyncEnabled,
} from "../../financeiro/lib/stock-reservation";

// BLOCO G — mantém `Product.reservedStock` E leva a mudança até o anúncio.
//
// ⭐ A DECISÃO DE DESENHO QUE IMPORTA: RECALCULAR, NÃO ACUMULAR.
//
// O caminho óbvio seria somar no create e subtrair no markPaid/reverse/delete.
// Ele tem uma classe de bug embutida: basta UM caminho esquecer de subtrair e
// a peça fica reservada para sempre, sem ninguém saber por quê. Uma reserva
// órfã não seria percebida — ela só apareceria como "peça que sumiu do estoque
// disponível", semanas depois.
//
// Aqui o valor é RECALCULADO a partir da fonte da verdade (as linhas de venda
// em aberto) para os produtos tocados. Consequências:
//   · reserva órfã deixa de ser possível — não há acumulação a divergir;
//   · um caminho esquecido causa valor DESATUALIZADO, não valor ERRADO para
//     sempre: o próximo toque naquele produto o conserta sozinho;
//   · e existe uma função única para consertar tudo, se algum dia precisar.
//
// O custo é um `groupBy` por escrita de venda. Uma venda tem poucos itens, e
// isso acontece no fluxo do balcão — não numa importação de 13 mil peças.
// (Medido em 25/08: `ReceivableItem` tem 359 linhas em TODA a produção.)
//
// ── A PROPAGAÇÃO (o que faltava) ──
//
// Até 25/08 esta função terminava no `updateMany` e mais nada: não enfileirava
// `StockSyncJob`, não disparava o retry, não pausava anúncio. O número existia
// na tabela e nunca saía dela. E a rede de segurança não pegava: o
// `StockReconciliationService` só varre produtos com `StockLog` na última hora
// (stock-reconciliation.service.ts:37-42), e a reserva NÃO gera `StockLog` —
// por desenho, já que `stock` não muda. Ou seja, "o anúncio reflete no próximo
// sync" era, na prática, NUNCA.
//
// Era exatamente o sintoma relatado: peça vendida fiado sai com o cliente e o
// anúncio continua no ar.
//
// O que se enfileira é o espelho do caminho da baixa real
// (stock-deduction.service.ts:174-207): listings do produto → advisory lock por
// listing → upsert em (listingId, "PENDING"). Nada mais é preciso, porque o
// consumidor RELÊ o produto e aplica a sombra (stock-sync-retry.service.ts:148
// → sync.usercase.ts:3408-3426), e cada plataforma já sabe o que fazer quando o
// disponível chega a zero: ML pausa, Facebook marca out-of-stock, OLX
// despublica, Shopee e Magalu mandam quantidade 0.
//
// ⭐ É POR ISSO QUE A PROPAGAÇÃO NÃO CHAMA `pauseListings`. Ela não precisa — e
// não precisar é o que a mantém livre de `userId`, porque `StockSyncJob` não
// tem coluna de tenant. `pauseListings` só entra na REABERTURA, e lá o `userId`
// vem do próprio produto (ver `firePostReservationEffects`).

/** Status em que a venda SEGURA a peça. Espelha `reservesStock` do módulo puro. */
const STATUS_QUE_RESERVAM = ["PENDENTE", "VENCIDA"] as const;

/**
 * Quanto o job da reserva espera antes de poder rodar.
 *
 * NÃO é folga arbitrária — é o que impede uma regressão concreta. Toda venda do
 * PDV nasce PENDENTE, inclusive a À VISTA: o dialog salva com
 * `POST /finance/receivables` e o cliente encadeia `POST /:id/pay`
 * (pdv-view.tsx:389). Sem o atraso, cada venda de balcão tocaria o marketplace
 * DUAS vezes — uma pela reserva, outra milissegundos depois pela baixa real.
 *
 * Pior que o desperdício: a segunda passada encontraria o anúncio ML já
 * `paused` com `available_quantity` ainda em 1 (a pausa por estoque zero NÃO
 * zera a quantidade remota) e cairia no ramo `ml_paused_with_remote_qty`
 * (sync.usercase.ts:3664-3679), acendendo "RISCO DE OVERSELL" em toda venda
 * paga. Alerta falso em massa é pior que alerta nenhum: ensina o operador a
 * ignorar o canal.
 *
 * Com o atraso, o upsert em (listingId, "PENDING") faz os dois eventos caírem
 * na MESMA linha e o marketplace é tocado UMA vez, já com o estado final.
 */
const RESERVATION_SYNC_DELAY_MS = 5_000;

/** O que o recálculo mudou, e o que o chamador precisa disparar pós-commit. */
export interface ReservationPropagation {
  /** Produtos cujo DISPONÍVEL mudou. Produto sem mudança não entra. */
  changed: Array<{ productId: string; before: number; after: number }>;
  /**
   * Produtos cujo disponível SUBIU DE ZERO — o anúncio precisa voltar ao ar.
   *
   * Gatilho próprio, e não o `reopenOnRefill` que já existe: aquele dispara em
   * `previousStock === 0 && newStock > 0` (stock-deduction.service.ts:425-427),
   * condição que a reserva NUNCA produz, porque `stock` não muda. A liberação
   * só é visível comparando o DISPONÍVEL antes e depois.
   */
  reopened: Array<{ productId: string; userId: string }>;
  /** Quantos `StockSyncJob` foram enfileirados (0 ⇒ nada a disparar). */
  enqueued: number;
}

function nadaAPropagar(): ReservationPropagation {
  return { changed: [], reopened: [], enqueued: 0 };
}

/**
 * Recalcula `reservedStock` dos produtos informados, DENTRO da transação do
 * chamador, e enfileira a propagação para os anúncios afetados.
 *
 * Roda depois da escrita que mudou a venda — é por isso que lê o estado já
 * atualizado. Fora da transação, uma venda criada e recebida em sequência
 * (o "receber agora" do PDV) poderia recalcular na ordem errada.
 *
 * Flag ausente ⇒ NADA acontece e nenhuma consulta é feita: a coluna pode não
 * existir no banco ainda.
 *
 * O retorno é ADITIVO: quem ignora continua funcionando exatamente como antes.
 */
export async function recomputeReservedStockWithinTx(
  tx: any,
  productIds: Array<string | null | undefined>,
): Promise<ReservationPropagation> {
  if (!isStockReservationEnabled()) return nadaAPropagar();
  const ids = Array.from(new Set(productIds.filter((p): p is string => !!p)));
  if (ids.length === 0) return nadaAPropagar();

  // Sub-flag DESLIGADA ⇒ nem esta leitura acontece. O caminho fica com
  // exatamente as mesmas consultas de antes desta entrega: o groupBy e os
  // updateMany, nada mais.
  const propagar = isStockReservationSyncEnabled();

  // O estado ANTES da escrita. Precisa vir daqui e não de um parâmetro: o
  // chamador conhece os ITENS da venda, não o estoque das peças — e no
  // `markPaid` o `stock` já foi decrementado pelo `deductWithinTx`
  // (finance.usecase.ts:773, antes daqui em :813). Ler o valor corrente é o que
  // faz o recebimento sair como "disponível não mudou" em vez de "liberou".
  const antes = propagar
    ? ((await tx.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, userId: true, stock: true, reservedStock: true },
      })) as Array<{
        id: string;
        userId: string;
        stock: number;
        reservedStock: number | null;
      }>)
    : [];
  const estadoAntes = new Map(antes.map((p) => [p.id, p]));

  // A verdade: quanto cada peça está comprometida em vendas AINDA ABERTAS.
  const somas = await tx.receivableItem.groupBy({
    by: ["productId"],
    where: {
      productId: { in: ids },
      receivable: {
        status: { in: STATUS_QUE_RESERVAM as unknown as string[] },
      },
    },
    _sum: { quantity: true },
  });

  const porProduto = new Map<string, number>();
  for (const s of somas as Array<{
    productId: string;
    _sum: { quantity: number | null };
  }>) {
    porProduto.set(s.productId, s._sum.quantity ?? 0);
  }

  // Um UPDATE por produto. Produto sem linha aberta cai em 0 — é o que libera
  // a reserva quando a venda é recebida, cancelada ou excluída, sem nenhum dos
  // caminhos precisar saber disso.
  for (const id of ids) {
    const valor = porProduto.get(id) ?? 0;
    await tx.product.updateMany({
      where: { id },
      data: { reservedStock: valor },
    });
  }

  if (!propagar) return nadaAPropagar();

  // Só o que MUDOU de disponível vira trabalho. Um recompute que chega ao mesmo
  // número — o caso mais comum, porque o `markPaid` baixa `stock` e zera a
  // reserva na mesma transação — não pode gerar chamada nenhuma. É esta linha
  // que garante que RECEBER a venda não faz o anúncio piscar de volta ao ar.
  const changed: ReservationPropagation["changed"] = [];
  const reopened: ReservationPropagation["reopened"] = [];
  for (const id of ids) {
    const p = estadoAntes.get(id);
    if (!p) continue; // produto apagado entre a leitura e agora
    const before = availableForSale(p.stock, p.reservedStock);
    const after = availableForSale(p.stock, porProduto.get(id) ?? 0);
    if (before === after) continue;
    changed.push({ productId: id, before, after });
    if (before === 0 && after > 0) {
      reopened.push({ productId: id, userId: p.userId });
    }
  }

  if (changed.length === 0) return nadaAPropagar();

  let enqueued = 0;
  const nextRunAt = new Date(Date.now() + RESERVATION_SYNC_DELAY_MS);

  // ── Pré-carga em LOTE ───────────────────────────────────────────────────
  //
  // Duas das sete regras de egress da casa
  // (scripts/docs/doc-ingestao-pedidos.tsx) se aplicam aqui, e a primeira
  // versão deste código violava as duas:
  //
  //  · "Pré-carga em lote no lugar de consultas repetidas dentro de laços" —
  //    era um `findMany` POR PRODUTO dentro do `for`. Num backfill de lote 25
  //    isso são 25 idas ao banco onde uma basta.
  //
  //  · "Nenhuma leitura sem seleção explícita de campos em caminho recorrente"
  //    e "proibido carregar a linha inteira de um produto numa consulta de
  //    anúncios" — o `include` sem `select` trazia as 61 colunas de
  //    `ProductListing`, incluindo `compatDiagnostics` (JSON, média 310 bytes
  //    nas 11.155 linhas que o têm) e `lastError`. MEDIDO em produção (25/08):
  //    280 bytes/linha inteira contra 52 bytes dos campos realmente usados —
  //    5,4× de desperdício, em 402.305 linhas.
  //
  // `orderBy` explícito não é enfeite: o lock é adquirido na ordem em que os
  // listings saem daqui, e ordem determinística entre os três produtores que
  // disputam `stock_sync_job:<listingId>` é a cura clássica para deadlock. A
  // iteração externa continua sendo por `changed`, na mesma ordem de antes.
  const listings = (await tx.productListing.findMany({
    where: { productId: { in: changed.map((c) => c.productId) } },
    select: {
      id: true,
      productId: true,
      marketplaceAccount: { select: { platform: true } },
    },
    orderBy: { id: "asc" },
  })) as Array<{
    id: string;
    productId: string;
    marketplaceAccount: { platform: string } | null;
  }>;

  const listingsPorProduto = new Map<string, typeof listings>();
  for (const l of listings) {
    const lista = listingsPorProduto.get(l.productId);
    if (lista) lista.push(l);
    else listingsPorProduto.set(l.productId, [l]);
  }

  for (const c of changed) {
    for (const listing of listingsPorProduto.get(c.productId) ?? []) {
      // Serializa com StockReconciliationService e StockDeductionService pelo
      // mesmo listing para evitar P2002 no upsert não-atômico do Prisma: os
      // três lados pegam o mesmo advisory lock antes de SELECT/INSERT.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock_sync_job:" + listing.id}))`;

      await tx.stockSyncJob.upsert({
        where: {
          listingId_status: { listingId: listing.id, status: "PENDING" },
        },
        create: {
          productId: c.productId,
          listingId: listing.id,
          platform: listing.marketplaceAccount!.platform,
          // O DISPONÍVEL, como o reconciliador grava
          // (stock-reconciliation.service.ts:117). Hoje a coluna é write-only —
          // o consumidor relê o produto —, mas gravar o número errado seria uma
          // mina para o primeiro leitor que ela vier a ter.
          targetStock: c.after,
          status: "PENDING",
          nextRunAt,
        },
        update: {
          // ⚠️ SÓ `targetStock`, como faz o reconciliador (:148-150).
          //
          // Mexer em `nextRunAt` aqui seria uma REGRESSÃO silenciosa e cara: no
          // `markPaid` o `deductWithinTx` acabou de enfileirar este mesmo job
          // com `nextRunAt: new Date()` (stock-deduction.service.ts:201-205), e
          // sobrescrevê-lo com "daqui a 5s" ATRASARIA a baixa real por causa de
          // um recálculo de reserva que nem mudou nada.
          //
          // Não resetar `attempts`/`lastError` é deliberado pelo mesmo motivo do
          // reconciliador: um job que vinha falhando não pode ser "curado" por
          // uma reserva. O preço é que uma reserva nova sobre um job em backoff
          // longo espera o backoff — raro (21 jobs pendentes em toda a produção
          // em 25/08) e preferível a mascarar falha.
          targetStock: c.after,
        },
      });
      enqueued++;
    }
  }

  return { changed, reopened, enqueued };
}

/**
 * Efeitos pós-commit da propagação. Espelho de
 * `StockDeductionService.firePostEffects`, com duas diferenças que importam.
 *
 * 1. `setTimeout` e não `setImmediate`. O job nasce com `nextRunAt = +5s` e a
 *    query do retry filtra por `nextRunAt <= now`
 *    (stock-sync-retry.service.ts:124-131): um `runOnce()` imediato não veria o
 *    próprio job que acabou de ser criado, e a peça só sairia do disponível no
 *    tick de 30s. O timer é `unref`ado para nunca segurar o processo (nem a
 *    suíte de testes).
 *
 * 2. Empurrar estoque e reabrir acontecem em SEQUÊNCIA, no mesmo timer. No ML a
 *    reabertura exige `pauseListings("active")`: quando o anúncio foi pausado
 *    por disponível zero, o sync fez `updateItem({status:"paused"})`
 *    (sync.usercase.ts:3697-3703) e NÃO zerou a quantidade remota, então um
 *    `updateItemStock` posterior não o traz de volta ao ar.
 *
 * NUNCA lança: a venda já commitou, e nada aqui pode desfazê-la.
 */
export function firePostReservationEffects(
  resultado: ReservationPropagation | null | undefined,
  logPrefix = "[StockReservation]",
): void {
  const r = resultado;
  if (!r || r.enqueued === 0) return;

  const timer = setTimeout(() => {
    void (async () => {
      try {
        const { StockSyncRetryService } =
          await import("./stock-sync-retry.service");
        await StockSyncRetryService.runOnce();
      } catch (err) {
        console.error(
          `${logPrefix} Falha ao disparar StockSyncRetryService.runOnce (ignorado):`,
          err,
        );
      }

      if (r.reopened.length === 0) return;

      // ── A PREFERÊNCIA DO TENANT, que este motor não conhecia ──
      //
      // Este é um SEGUNDO motor de reabertura, criado depois de
      // `User.reopenListingsOnSaleCancel` e nunca ligado a ela. Liberar a
      // reserva ao excluir uma venda pendente é, para o lojista, cancelar a
      // venda — e quem desligou a preferência não quer o anúncio de volta.
      //
      // A resolução do tenant NÃO pode usar `p.userId` cru: `Product.userId`
      // aponta para um COLABORADOR em 1.049 produtos de produção, e a linha do
      // colaborador nunca governa nada. Uma chamada só, agrupada pelos
      // `userId` distintos (o array costuma ter 1 a 3 itens), com a mesma
      // precedência do cancelamento de pedido: o valor do PAI vence.
      const prefPorUsuario = await resolveReopenPrefForOwners(
        r.reopened.map((p) => p.userId),
      );

      try {
        const { ProductUseCase } =
          await import("@/app/usecases/product.usercase");
        const uc = new ProductUseCase();
        for (const p of r.reopened) {
          // Preferência OFF ⇒ o oposto de reabrir, e não "não fazer nada": o
          // `runOnce()` logo acima já empurrou o disponível, e é esse empurrão
          // que faz o ML remover o `out_of_stock` e devolver o item ao ar.
          const alvo = (prefPorUsuario.get(p.userId) ?? true)
            ? "active"
            : "paused";
          try {
            // `userId` vem do PRÓPRIO produto, e não do `dataOwnerId` da
            // requisição. `pauseListings` valida posse com
            // `productRepository.findById(productId, userId)`
            // (product.usercase.ts:609), que compara contra `Product.userId`
            // — então ler do produto é auto-consistente por construção.
            //
            // Não é teoria: 1.049 produtos em produção (28/08) têm
            // `Product.userId` apontando para um COLABORADOR (usuário com
            // `parentUserId`). Neles, passar o dataOwnerId da rota faria o
            // `findById` não achar o produto e a reabertura falhar em
            // silêncio.
            if (alvo === "active") {
              // Aridade de 3 args preservada: caminho byte-idêntico ao de
              // antes desta correção para os tenants com a preferência ON.
              await uc.pauseListings(p.productId, p.userId, "active");
            } else {
              // `forceRemote`: o status local pode dizer `paused` enquanto o
              // remoto já voltou a `active` pelo empurrão de quantidade — e é
              // esse par que o fast-path `alreadyInState` tornaria no-op.
              //
              // Todos os canais, como no cancelamento de pedido: a peça é uma
              // só e continua fora do pátio.
              await uc.pauseListings(p.productId, p.userId, "paused", {
                forceRemote: true,
              });
            }
          } catch (err) {
            console.error(
              `${logPrefix} Falha ao reabrir anuncios do produto ${p.productId} (best-effort):`,
              err,
            );
          }
        }
      } catch (err) {
        console.error(
          `${logPrefix} Falha ao importar ProductUseCase para reabrir anuncios:`,
          err,
        );
      }
    })();
  }, RESERVATION_SYNC_DELAY_MS + 500);

  // Não segura o event loop: em processo de longa duração é indiferente, mas na
  // suíte de testes um timer pendente atrasaria o encerramento do worker.
  timer.unref?.();
}

/**
 * Mesma coisa, fora de transação — para os caminhos que não têm uma.
 *
 * Best-effort e NUNCA lança: a reserva é informação, e uma falha ao recalcular
 * não pode derrubar a venda que acabou de acontecer. O valor fica
 * desatualizado até o próximo toque, que é exatamente o modo de falha que o
 * desenho por recálculo torna aceitável.
 */
export function recomputeReservedStock(
  productIds: Array<string | null | undefined>,
  logPrefix = "[StockReservation]",
): void {
  if (!isStockReservationEnabled()) return;
  const ids = productIds.filter((p): p is string => !!p);
  if (ids.length === 0) return;
  setImmediate(() => {
    void (async () => {
      // Com a propagação ligada há advisory lock e upsert de job em jogo, e
      // `pg_advisory_xact_lock` fora de transação é liberado no fim do próprio
      // statement — ou seja, não protege nada. Abrir a transação aqui é o que
      // torna o lock real. Sem a sub-flag, o caminho fica idêntico ao de antes
      // desta entrega: `prisma` cru, sem transação nova.
      const r = isStockReservationSyncEnabled()
        ? await prisma.$transaction(
            (tx) => recomputeReservedStockWithinTx(tx as any, ids),
            { timeout: 60_000, maxWait: 20_000 },
          )
        : await recomputeReservedStockWithinTx(prisma as any, ids);
      firePostReservationEffects(r, logPrefix);
    })().catch((err) =>
      console.error(
        `${logPrefix} Falha ao recalcular estoque reservado (ignorado):`,
        err,
      ),
    );
  });
}
