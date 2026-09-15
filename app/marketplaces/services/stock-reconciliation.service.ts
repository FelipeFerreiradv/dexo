import prisma from "@/app/lib/prisma";
import { availableForSale } from "@/app/financeiro/lib/stock-reservation";
import { MLApiService } from "./ml-api.service";
import { SystemLogService } from "@/app/services/system-log.service";

const RECONCILE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const BATCH_LIMIT = 500;

/**
 * VIGÍLIA DE DISPONIBILIDADE — cadência horária.
 *
 * Por que uma hora e não 15 min: cada passada custa um GET por anúncio
 * vigiado (566 em 14/09/2026). De hora em hora isso é ~0,16 req/s contra a
 * API do ML, invisível no limite deles; a cada 15 min seria 4x por nada,
 * porque o evento vigiado — um anúncio voltar ao ar — é raro.
 */
const AVAILABILITY_WATCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * FATIAMENTO DETERMINÍSTICO — por que não existe mais cursor.
 *
 * A versão anterior varria com OFFSET e guardava a posição em memória. Como o
 * processo reinicia de tempos em tempos, a posição zerava e a varredura
 * recomeçava do início: medido em 15/09/2026, o deslocamento NUNCA passou de
 * 4.000 de 10.698 candidatos — 62,6% da base jamais foi verificada uma única
 * vez, e 27 das 29 contas de ML estavam inteiras nessa zona cega. O anúncio
 * que causou a venda dupla do SKU 34049 estava na posição ~7.921.
 *
 * Agora cada anúncio cai numa fatia fixa pelo hash do próprio id, e a fatia
 * visitada sai da HORA DO RELÓGIO. Três consequências: reiniciar o processo
 * não reposiciona nada; nenhum anúncio fica preso no fim de uma fila; e a base
 * inteira é coberta a cada 24 horas por construção, não por sorte.
 */
const AVAILABILITY_WATCH_SLICES = 24;
/**
 * Teto por passada. Com a base de 15/09/2026 (10.698 candidatos) uma fatia tem
 * ~446 anúncios, bem abaixo disto. Se o teto chegar a cortar, a varredura
 * perde cobertura — por isso o corte é LOGADO como aviso, nunca silencioso.
 */
const AVAILABILITY_WATCH_MAX_PER_TICK = 900;
/** Respiro entre chamadas: a vigília nunca deve competir com o sync do usuário. */
const AVAILABILITY_WATCH_DELAY_MS = 150;

type DriftCandidate = {
  productId: string;
  stock: number;
  listingId: string;
  marketplaceAccountId: string;
  platform: string;
};

/**
 * StockReconciliationService
 *
 * Defesa em profundidade contra drift entre o estoque local e o estoque
 * anunciado nos marketplaces. A cada 15 min varre produtos cujo estoque
 * mudou na última hora (via StockLog) e enfileira um StockSyncJob por
 * listing ativo — o upsert em (listingId, status=PENDING) garante que não
 * há inflação da fila.
 *
 * Cenários que isso corrige:
 *  - Processo caiu entre o commit do decremento e o enfileiramento.
 *  - Job FAILED terminal ficou preso sem retry manual.
 *  - Ajuste manual de estoque no banco sem passar por deductStockForOrder.
 */
export class StockReconciliationService {
  private static intervalId: NodeJS.Timeout | null = null;
  private static running = false;

  static async runOnce(): Promise<void> {
    const since = new Date(Date.now() - RECONCILE_WINDOW_MS);

    const recentLogs = await prisma.stockLog.findMany({
      where: { createdAt: { gte: since } },
      select: { productId: true },
      distinct: ["productId"],
      take: BATCH_LIMIT,
    });

    // O PONTO CEGO desta varredura, registrado em
    // stock-reservation.service.ts:34-38: ela entra por `StockLog`, e a RESERVA
    // não gera `StockLog` por desenho — `stock` não muda, só `reservedStock`.
    // Uma peça comprometida em venda pendente é, portanto, invisível aqui.
    //
    // Hoje a propagação da reserva é feita pelo `firePostReservationEffects`,
    // que agenda com `setTimeout(...).unref()`: um restart do processo dentro
    // da janela de ~5,5s perde o disparo. Os StockSyncJob já gravados são
    // duráveis, mas quando a perda acontece ANTES do enfileiramento não sobra
    // nada — e nenhuma rede pega, porque não há `StockLog`.
    //
    // Incluir os produtos com `reservedStock > 0` fecha esse buraco pelo mesmo
    // caminho de sempre (upsert idempotente em (listingId, PENDING), alvo =
    // disponível). É barato e termina sozinho: o conjunto é o das vendas
    // ABERTAS com item (9 produtos em produção em 14/09/2026), e cada peça sai
    // dele quando a venda é recebida ou cancelada.
    //
    // Default DESLIGADO: é varredura nova, não correção de defeito provado.
    // RESERVED_STOCK_RECONCILE_ENABLED=1 liga.
    const reservedIds =
      process.env.RESERVED_STOCK_RECONCILE_ENABLED === "1"
        ? (
            await prisma.product.findMany({
              where: { reservedStock: { gt: 0 } },
              select: { id: true },
              take: BATCH_LIMIT,
            })
          ).map((p) => p.id)
        : [];

    if (recentLogs.length === 0 && reservedIds.length === 0) return;

    const productIds = [
      ...new Set([...recentLogs.map((l) => l.productId), ...reservedIds]),
    ];

    // Com o espelhamento de status ligado, listings podem carregar
    // under_review/reviewing/unlist/inactive (item ainda existe no
    // marketplace e volta a vender) — antes do espelho essas linhas ficavam
    // stale em active/paused e ENTRAVAM aqui; a ampliação preserva a
    // cobertura de drift que elas sempre tiveram.
    // "pending"/"PENDING" entram porque é o estado ESTÁVEL de um anúncio OLX
    // publicado: a OLX confirma na fila de revisão e o Dexo não espelha esse
    // status, então o anúncio fica pending indefinidamente e ficava invisível
    // para a rede de segurança de drift.
    //
    // Só no ramo COM espelhamento (o que roda em produção — a flag é vazia no
    // .env). O ramo do kill-switch fica byte-idêntico ao anterior de propósito:
    // ele existe para voltar ao filtro base, e há teste travando isso
    // (listing-status-mirror-interactions.spec.ts).
    const reconcilableStatuses =
      process.env.LISTING_STATUS_SYNC_DISABLED === "1"
        ? ["ACTIVE", "active", "paused", "PAUSED"]
        : [
            "ACTIVE",
            "active",
            "paused",
            "PAUSED",
            "pending",
            "PENDING",
            "under_review",
            "reviewing",
            "unlist",
            "inactive",
          ];

    const rows = await prisma.productListing.findMany({
      where: {
        productId: { in: productIds },
        status: { in: reconcilableStatuses },
        // Placeholders locais NUNCA existiram no canal: ML, Shopee e o
        // republish do ML criam linhas com externalListingId `PENDING_*` e
        // status exatamente "pending". Sem este filtro, admitir "pending"
        // acima passaria a enfileirar job de sync para anúncio que não existe
        // do outro lado — regressão direta em ML e Shopee.
        //
        // PAREADO com o status de propósito: excluir todo `PENDING_*` de forma
        // ampla também removeria da varredura uma linha legítima — o create da
        // Magalu sem SKU grava `PENDING_<ts>` com status "active" e entrava na
        // reconciliação antes desta entrega. Assim o ramo do kill-switch fica
        // de fato byte-idêntico ao anterior, como o comentário acima promete.
        NOT: {
          AND: [
            { status: { in: ["pending", "PENDING"] } },
            { externalListingId: { startsWith: "PENDING_" } },
          ],
        },
      },
      select: {
        id: true,
        productId: true,
        marketplaceAccountId: true,
        // BLOCO G — `reservedStock` entra no select porque o alvo do job
        // precisa ser o estoque DISPONÍVEL. Sem isto o reconciliador
        // enfileiraria o estoque BRUTO e desfaria a reserva a cada tick de
        // 15 minutos — silenciosamente, e para todos os anúncios de uma vez.
        product: { select: { stock: true, reservedStock: true } },
        marketplaceAccount: { select: { platform: true, status: true } },
      },
    });

    const candidates: DriftCandidate[] = rows
      .filter((r) => r.marketplaceAccount?.status === "ACTIVE")
      .map((r) => ({
        productId: r.productId,
        stock: availableForSale(r.product.stock, r.product.reservedStock),
        listingId: r.id,
        marketplaceAccountId: r.marketplaceAccountId,
        platform: r.marketplaceAccount.platform,
      }));

    if (candidates.length === 0) return;

    console.log(
      `[StockReconciliationService] enqueueing ${candidates.length} drift-repair job(s)`,
    );

    for (const c of candidates) {
      await this.enqueue(c);
    }
  }

  /**
   * Extraído do laço acima sem mudança de comportamento, para que a vigília de
   * disponibilidade enfileire pelo MESMO caminho — inclusive o advisory lock.
   */
  private static async enqueue(c: DriftCandidate): Promise<void> {
    try {
      // Serializa com OrderUseCase.deductStockForOrder via advisory lock
      // para evitar P2002 no upsert não-atômico do Prisma. Ambos lados
      // pegam o mesmo lock por listing antes do SELECT/INSERT.
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock_sync_job:" + c.listingId}))`;

          await (tx as any).stockSyncJob.upsert({
            where: {
              listingId_status: { listingId: c.listingId, status: "PENDING" },
            },
            create: {
              productId: c.productId,
              listingId: c.listingId,
              platform: c.platform,
              targetStock: c.stock,
              status: "PENDING",
            },
            update: {
              targetStock: c.stock,
            },
          });
        },
        { timeout: 60_000, maxWait: 20_000 },
      );
    } catch (err) {
      console.error(
        `[StockReconciliationService] upsert failed for listing ${c.listingId}:`,
        err,
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // VIGÍLIA DE DISPONIBILIDADE
  //
  // O BURACO QUE ESTA ROTINA FECHA, com o caso que o revelou:
  //
  // SKU 33996, peça de 1 unidade. Vendeu na Shopee em 01/08/2026 23:02 BRT; a
  // baixa correu e as três Shopee foram zeradas em segundos. Os dois anúncios
  // do ML estavam `under_review` e foram pulados — o ML PRESERVA
  // `available_quantity` enquanto o anúncio está fora do ar. Em 10/09 um deles
  // voltou ao ar e vendeu a peça que não existia mais.
  //
  // Entre 02/08 02:50 e 10/09 15:28 não há UM registro de sync desses dois
  // anúncios. Não é falha de ninguém: o sync de estoque roda por
  // `StockSyncJob`, que nasce de `StockLog`, e o `runOnce` acima só varre
  // produto com `StockLog` na última hora. Estoque que já foi a zero NUNCA
  // MAIS MUDA — então nada volta a olhar aquele anúncio. Foram 39 dias.
  //
  // POR QUE NÃO BASTA ZERAR A QUANTIDADE: o ML RECUSA alterar
  // `available_quantity` em anúncio fora do ar. Medido no SyncLog (60 dias):
  // 2.922 recusas em 241 anúncios `inactive`, 1.408 em 557 `under_review`,
  // 97 em 8 `paused`. Para esses não existe caminho de API — a única defesa é
  // ver a VOLTA para `active` e pausar na hora, que é o que funciona (29.087
  // STOCK_UPDATE de sucesso no ML).
  //
  // O que a rotina faz, e só: consulta o estado no ML e, quando acha um
  // anúncio ATIVO vendendo peça que não existe, grava o alerta e enfileira o
  // job. Quem pausa é o pipeline de sempre — nenhuma escrita nova de
  // marketplace nasce aqui.
  //
  // COBERTURA (corrigido em 15/09/2026): a varredura não tem mais cursor — a
  // fatia vem do relógio, e em 24 horas a base inteira passa. A versão com
  // OFFSET em memória nunca passou de 4.000 de 10.698 porque o processo
  // reinicia; ver o bloco de constantes no topo do arquivo.
  //
  // Default DESLIGADA. AVAILABILITY_WATCH_ENABLED=1 liga. O boot agora diz em
  // qual dos dois estados subiu — antes os dois eram silenciosos e iguais.
  // ───────────────────────────────────────────────────────────────────────────

  private static watchIntervalId: NodeJS.Timeout | null = null;
  private static watchInProgress = false;

  /**
   * Qual fatia a hora do relógio manda varrer. Determinístico e sem estado:
   * duas passadas na mesma hora visitam a mesma fatia, e 24 horas visitam
   * todas. Recebe a data para que o teste não dependa do relógio real.
   */
  static sliceForClock(agora: Date): number {
    const horasDesdeEpoch = Math.floor(agora.getTime() / (60 * 60 * 1000));
    return (
      ((horasDesdeEpoch % AVAILABILITY_WATCH_SLICES) +
        AVAILABILITY_WATCH_SLICES) %
      AVAILABILITY_WATCH_SLICES
    );
  }

  static async watchAvailabilityOnce(agora = new Date()): Promise<void> {
    if (process.env.AVAILABILITY_WATCH_ENABLED !== "1") return;
    if (this.watchInProgress) return;
    this.watchInProgress = true;
    try {
      await this.watchAvailabilityInner(agora);
    } finally {
      this.watchInProgress = false;
    }
  }

  private static async watchAvailabilityInner(agora: Date): Promise<void> {
    const fatia = this.sliceForClock(agora);
    // `stock - reservedStock` compara DUAS COLUNAS, coisa que o `where` do
    // Prisma não faz — daí o raw. `closed` fica de fora: é terminal e o
    // anúncio não volta sozinho. Placeholders `PENDING_*` nunca existiram no
    // canal.
    const candidatos = await prisma.$queryRaw<
      Array<{
        listingId: string;
        externalListingId: string;
        productId: string;
        productName: string;
        sku: string | null;
        disponivel: number;
        accountId: string;
        accountName: string;
        accessToken: string | null;
      }>
    >`
      SELECT pl.id                        AS "listingId",
             pl."externalListingId"       AS "externalListingId",
             p.id                         AS "productId",
             p.name                       AS "productName",
             p.sku                        AS sku,
             (p.stock - p."reservedStock") AS disponivel,
             ma.id                        AS "accountId",
             ma."accountName"             AS "accountName",
             ma."accessToken"             AS "accessToken"
      FROM "ProductListing" pl
      JOIN "Product" p ON p.id = pl."productId"
      JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
      WHERE ma.platform = 'MERCADO_LIVRE'
        AND ma.status = 'ACTIVE'
        AND (p.stock - p."reservedStock") <= 0
        AND pl.status NOT IN ('closed', 'CLOSED')
        AND pl."externalListingId" NOT LIKE 'PENDING_%'
        AND ((hashtext(pl.id) % ${AVAILABILITY_WATCH_SLICES}) + ${AVAILABILITY_WATCH_SLICES}) % ${AVAILABILITY_WATCH_SLICES} = ${fatia}
      ORDER BY pl.id
      LIMIT ${AVAILABILITY_WATCH_MAX_PER_TICK}
    `;

    if (candidatos.length === 0) return;

    // MULTIGET POR CONTA, nunca item a item. Uma passada com `getItemDetails`
    // custaria uma chamada e ~12 KB por anúncio — 566 chamadas e ~6,8 MB com o
    // volume de 14/09/2026. Em blocos de 20 com seleção explícita de campos são
    // ~29 chamadas e ~85 KB. As regras de egress da casa exigem as duas coisas:
    // pré-carga em lote no lugar de consulta dentro de laço, e nada de ler a
    // linha inteira em caminho recorrente.
    const porConta = new Map<string, typeof candidatos>();
    let semToken = 0;
    for (const c of candidatos) {
      if (!c.accessToken) {
        semToken++;
        continue;
      }
      const atual = porConta.get(c.accountId) ?? [];
      atual.push(c);
      porConta.set(c.accountId, atual);
    }

    let verificados = 0;
    let reabertos = 0;
    let contasComFalha = 0;
    let puladosPorFalhaDeConta = 0;

    for (const [, lista] of porConta) {
      const token = lista[0].accessToken!;
      let snapshot: Array<{
        id: string;
        status: string;
        available_quantity: number;
      }> = [];
      try {
        snapshot = await MLApiService.getItemsStockSnapshot(
          token,
          lista.map((c) => c.externalListingId),
        );
      } catch {
        // Token expirado, conta instável: a vigília nunca derruba o laço nem
        // renova token por conta própria — refresh a partir do processo errado
        // marca a conta como ERROR e para o lojista inteiro. Próxima conta.
        contasComFalha++;
        puladosPorFalhaDeConta += lista.length;
        continue;
      }

      const porItem = new Map(snapshot.map((s) => [s.id, s]));
      verificados += snapshot.length;

      for (const c of lista) {
        const item = porItem.get(c.externalListingId);
        if (!item) continue; // item removido/inacessível: o multiget omite
        if (item.status !== "active" || item.available_quantity <= 0) continue;

        // ACHOU: anúncio no ar vendendo peça que não existe. É o estado que
        // precede a venda dupla.
        reabertos++;
        await this.alertBackOnlineWithoutStock(c, item.available_quantity);
        await this.enqueue({
          productId: c.productId,
          stock: Math.max(0, c.disponivel),
          listingId: c.listingId,
          marketplaceAccountId: c.accountId,
          platform: "MERCADO_LIVRE",
        });
      }

      // Respiro entre CONTAS (não entre itens): a vigília nunca deve competir
      // com o sync do usuário.
      await new Promise((r) => setTimeout(r, AVAILABILITY_WATCH_DELAY_MS));
    }

    // Telemetria HONESTA: antes só saíam `candidatos` e `verificados`, e a
    // diferença entre os dois — 57% da base em 15/09/2026 — não tinha nome
    // nem causa no log. Quem não é verificado agora aparece com o motivo.
    const naoVerificados = candidatos.length - verificados;
    console.log(
      JSON.stringify({
        event: "availability_watch.tick",
        fatia,
        deTotalDeFatias: AVAILABILITY_WATCH_SLICES,
        candidatos: candidatos.length,
        verificados,
        naoVerificados,
        semToken,
        puladosPorFalhaDeConta,
        contas: porConta.size,
        contasComFalha,
        reabertosSemEstoque: reabertos,
      }),
    );

    // Corte pelo teto = fatia maior que o orçamento da passada. Parte dela não
    // foi olhada, e silêncio aqui reproduziria exatamente o defeito que este
    // PR corrige — por isso o aviso é ruidoso.
    if (candidatos.length >= AVAILABILITY_WATCH_MAX_PER_TICK) {
      console.warn(
        `[availability_watch] fatia ${fatia} atingiu o teto de ${AVAILABILITY_WATCH_MAX_PER_TICK} candidatos — parte da fatia NÃO foi verificada. Aumentar AVAILABILITY_WATCH_SLICES.`,
      );
    }
  }

  /** Dedupe de 24h, mesmo padrão de `alertMLReactivationRisk`. Nunca lança. */
  private static async alertBackOnlineWithoutStock(
    c: {
      listingId: string;
      externalListingId: string;
      productId: string;
      productName: string;
      sku: string | null;
      accountId: string;
      accountName: string;
    },
    remoteQuantity: number,
  ): Promise<void> {
    try {
      const desde = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const existe = await prisma.systemLog.findFirst({
        where: {
          action: "ML_BACK_ONLINE_WITHOUT_STOCK",
          resourceId: c.listingId,
          createdAt: { gte: desde },
        },
        select: { id: true },
      });
      if (existe) return;

      await SystemLogService.logError(
        "ML_BACK_ONLINE_WITHOUT_STOCK",
        `Anúncio ${c.externalListingId} (SKU ${c.sku ?? "?"} — ${c.productName}) voltou ao ar no Mercado Livre com quantidade=${remoteQuantity}, mas a peça não está disponível no estoque. Pausa enfileirada automaticamente.`,
        {
          resource: "Listing",
          resourceId: c.listingId,
          details: {
            platform: "MERCADO_LIVRE",
            accountId: c.accountId,
            accountName: c.accountName,
            externalListingId: c.externalListingId,
            productId: c.productId,
            productSku: c.sku,
            remoteQuantity,
            availableLocal: 0,
          },
        },
      );
    } catch (err) {
      console.error("[availability_watch] falha ao alertar:", err);
    }
  }

  static start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      void this.runOnce().catch((err) => {
        console.error("[StockReconciliationService] runOnce failed:", err);
      });
    }, intervalMs);
    console.log(
      `[StockReconciliationService] started (interval=${intervalMs}ms)`,
    );

    // Vigília horária: entra e sai junto com o reconciliador, então não há
    // ciclo de vida novo para ninguém lembrar de parar.
    if (process.env.AVAILABILITY_WATCH_ENABLED === "1") {
      this.watchIntervalId = setInterval(() => {
        void this.watchAvailabilityOnce().catch((err) => {
          console.error("[availability_watch] tick failed:", err);
        });
      }, AVAILABILITY_WATCH_INTERVAL_MS);
      console.log(
        `[availability_watch] started (interval=${AVAILABILITY_WATCH_INTERVAL_MS}ms, slices=${AVAILABILITY_WATCH_SLICES}, maxPorTick=${AVAILABILITY_WATCH_MAX_PER_TICK})`,
      );
    } else {
      // Sem esta linha, vigília ligada e vigília desligada produzem o MESMO
      // log de boot — e foi assim que ela passou semanas desligada sem
      // ninguém notar. O estado agora é legível no log do processo.
      console.log(
        "[availability_watch] DESLIGADA (AVAILABILITY_WATCH_ENABLED != '1') — nenhum anúncio será vigiado",
      );
    }
  }

  static stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    if (this.watchIntervalId) clearInterval(this.watchIntervalId);
    this.watchIntervalId = null;
    this.running = false;
  }
}
