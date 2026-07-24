import prisma from "../../lib/prisma";

/**
 * Repositório para gerenciar ProductListings
 * Conexão entre Product local e anúncios no Mercado Livre
 */
export class ListingRepository {
  /**
   * Cria uma nova conexão entre produto e anúncio ML
   */
  static async createListing(data: {
    productId: string;
    marketplaceAccountId: string;
    externalListingId: string;
    externalSku?: string | null;
    permalink?: string | null;
    status: string;
    // optional retry metadata
    retryAttempts?: number;
    nextRetryAt?: Date | null;
    lastError?: string | null;
    retryEnabled?: boolean;
    // category that was requested when attempting the ML create (useful for retries)
    requestedCategoryId?: string | null;
    // ML listing settings (persisted per-account; survives retries/edits)
    listingType?: string | null;
    itemCondition?: string | null;
    hasWarranty?: boolean | null;
    warrantyUnit?: string | null;
    warrantyDuration?: number | null;
    shippingMode?: string | null;
    freeShipping?: boolean | null;
    localPickup?: boolean | null;
    manufacturingTime?: number | null;
    // Autor real da criação (actorId = request.user.id). Ausente = fluxo de
    // sistema (autodetect/sync/retry) → NULL → UI exibe "—".
    createdByUserId?: string | null;
  }) {
    try {
      const listing = await prisma.productListing.create({
        data: {
          productId: data.productId,
          marketplaceAccountId: data.marketplaceAccountId,
          externalListingId: data.externalListingId,
          externalSku: data.externalSku || null,
          permalink: data.permalink || null,
          status: data.status,
          retryAttempts: data.retryAttempts ?? 0,
          nextRetryAt: data.nextRetryAt ?? null,
          lastError: data.lastError ?? null,
          retryEnabled: data.retryEnabled ?? false,
          requestedCategoryId: data.requestedCategoryId ?? null,
          listingType: data.listingType ?? null,
          itemCondition: data.itemCondition ?? null,
          hasWarranty: data.hasWarranty ?? null,
          warrantyUnit: data.warrantyUnit ?? null,
          warrantyDuration: data.warrantyDuration ?? null,
          shippingMode: data.shippingMode ?? null,
          freeShipping: data.freeShipping ?? null,
          localPickup: data.localPickup ?? null,
          manufacturingTime: data.manufacturingTime ?? null,
          createdByUserId: data.createdByUserId ?? null,
        },
      });
      return listing;
    } catch (error) {
      throw new Error(
        `Erro ao criar listing: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Cria OU atualiza o listing pela unique key (marketplaceAccountId,
   * externalListingId) — idempotente. Usado onde o mesmo anúncio pode ser
   * (re)criado com resultados diferentes (ex.: Magalu, cuja identidade é o SKU:
   * uma falha grava status "error"+lastError e um retry bem-sucedido reaproveita
   * a MESMA linha virando "active", sem P2002 nem linha duplicada). Só sobrescreve
   * os campos informados (preserva overrides do usuário e o resto).
   */
  static async upsertListing(data: {
    productId: string;
    marketplaceAccountId: string;
    externalListingId: string;
    externalSku?: string | null;
    permalink?: string | null;
    status: string;
    lastError?: string | null;
    retryEnabled?: boolean;
    nextRetryAt?: Date | null;
    retryAttempts?: number;
    // Autor real da criação. Só entra no branch `create` — autoria = quem
    // criou a linha pela primeira vez; retries/updates nunca sobrescrevem.
    createdByUserId?: string | null;
  }) {
    return prisma.productListing.upsert({
      where: {
        marketplaceAccountId_externalListingId: {
          marketplaceAccountId: data.marketplaceAccountId,
          externalListingId: data.externalListingId,
        },
      },
      create: {
        productId: data.productId,
        marketplaceAccountId: data.marketplaceAccountId,
        externalListingId: data.externalListingId,
        externalSku: data.externalSku ?? null,
        permalink: data.permalink ?? null,
        status: data.status,
        lastError: data.lastError ?? null,
        retryEnabled: data.retryEnabled ?? false,
        nextRetryAt: data.nextRetryAt ?? null,
        retryAttempts: data.retryAttempts ?? 0,
        createdByUserId: data.createdByUserId ?? null,
      },
      update: {
        status: data.status,
        permalink: data.permalink === undefined ? undefined : data.permalink,
        externalSku:
          data.externalSku === undefined ? undefined : data.externalSku,
        lastError: data.lastError === undefined ? undefined : data.lastError,
        retryEnabled: data.retryEnabled ?? undefined,
        nextRetryAt:
          data.nextRetryAt === undefined ? undefined : data.nextRetryAt,
        retryAttempts: data.retryAttempts ?? undefined,
      },
    });
  }

  /**
   * Cria (ou reaproveita) o listing de um anúncio detectado automaticamente no
   * marketplace. Upsert na unique key (marketplaceAccountId, externalListingId):
   * idempotente e à prova de corrida — uma reentrega/polling repetido cai no
   * `update` no-op em vez de estourar P2002. Espelha `upsertFromOrderFallback`,
   * acrescentando `permalink` (o anúncio já vem com a URL pública).
   */
  static async upsertAutodetectedListing(data: {
    productId: string;
    marketplaceAccountId: string;
    externalListingId: string;
    externalSku?: string | null;
    permalink?: string | null;
    status: string;
  }) {
    try {
      return await prisma.productListing.upsert({
        where: {
          marketplaceAccountId_externalListingId: {
            marketplaceAccountId: data.marketplaceAccountId,
            externalListingId: data.externalListingId,
          },
        },
        create: {
          productId: data.productId,
          marketplaceAccountId: data.marketplaceAccountId,
          externalListingId: data.externalListingId,
          externalSku: data.externalSku || null,
          permalink: data.permalink || null,
          status: data.status,
        },
        update: {},
        // EGRESS: o chamador só precisa do id + productId (p/ detectar órfão).
        select: { id: true, productId: true },
      });
    } catch (error: any) {
      // Prisma upsert NÃO é atômico (faz SELECT→INSERT). Sob entregas
      // concorrentes do MESMO anúncio (o ML dispara vários webhooks `items`
      // quase simultâneos: criação + preço + estoque), duas execuções passam
      // pelo "não existe" e dois inserts correm → o segundo estoura P2002 na
      // unique key (marketplaceAccountId, externalListingId). Isso é exatamente
      // o estado desejado (o listing já existe) → idempotente: relê e devolve.
      if (error?.code === "P2002") {
        return prisma.productListing.findUnique({
          where: {
            marketplaceAccountId_externalListingId: {
              marketplaceAccountId: data.marketplaceAccountId,
              externalListingId: data.externalListingId,
            },
          },
          select: { id: true, productId: true },
        });
      }
      // Outro erro qualquer: loga completo (a mensagem do Error vinha vazia).
      console.error(
        `[autodetect] Falha no upsert do listing (acct=${data.marketplaceAccountId}, item=${data.externalListingId}, product=${data.productId}):`,
        error,
      );
      const detail =
        error?.message ||
        error?.code ||
        (error?.meta ? JSON.stringify(error.meta) : "") ||
        (error ? String(error) : "erro desconhecido");
      throw new Error(`Erro ao criar listing auto-detectado: ${detail}`);
    }
  }

  /**
   * EGRESS-light: só o `productId` do listing de (conta, anúncio), para a
   * checagem de idempotência da auto-detecção. Evita puxar o Product inteiro
   * (com JSONB de attributes/mlCatalogSnapshot) a cada webhook/polling.
   */
  static async findProductIdByExternalListingId(
    marketplaceAccountId: string,
    externalListingId: string,
  ): Promise<{ productId: string } | null> {
    return prisma.productListing.findUnique({
      where: {
        marketplaceAccountId_externalListingId: {
          marketplaceAccountId,
          externalListingId,
        },
      },
      select: { productId: true },
    });
  }

  /**
   * Detecção de "SKU de caixa": um produto que já tem um anúncio NESTA conta e
   * casaria com um NOVO anúncio pelo mesmo SKU indica que o SKU foi reutilizado
   * como rótulo de caixa/palete (não é um SKU único por item). Nesse caso o novo
   * anúncio NÃO deve ser agrupado — vira produto próprio. Anúncios da MESMA conta
   * sinalizam reuso; contas diferentes (mesmo SKU) são agrupamento legítimo.
   * EGRESS-light: só existência.
   */
  static async productHasListingInAccount(
    productId: string,
    marketplaceAccountId: string,
  ): Promise<boolean> {
    const found = await prisma.productListing.findFirst({
      where: { productId, marketplaceAccountId },
      select: { id: true },
    });
    return found != null;
  }

  static async upsertFromOrderFallback(data: {
    productId: string;
    marketplaceAccountId: string;
    externalListingId: string;
    externalSku?: string | null;
    status: string;
  }) {
    try {
      return await prisma.productListing.upsert({
        where: {
          marketplaceAccountId_externalListingId: {
            marketplaceAccountId: data.marketplaceAccountId,
            externalListingId: data.externalListingId,
          },
        },
        create: {
          productId: data.productId,
          marketplaceAccountId: data.marketplaceAccountId,
          externalListingId: data.externalListingId,
          externalSku: data.externalSku || null,
          status: data.status,
        },
        update: {},
      });
    } catch (error) {
      throw new Error(
        `Erro ao criar listing via fallback do pedido: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Busca listing por ID do anúncio externo (ML ID)
   */
  static async findByExternalListingId(
    marketplaceAccountId: string,
    externalListingId: string,
  ) {
    return prisma.productListing.findUnique({
      where: {
        marketplaceAccountId_externalListingId: {
          marketplaceAccountId,
          externalListingId,
        },
      },
      include: {
        product: true,
      },
    });
  }

  /**
   * Busca listing por produto e conta de marketplace.
   *
   * Um par (produto, conta) pode ter VÁRIAS linhas: o autodetect cria uma por
   * anúncio, e a base tem milhares de pares assim (SKUs repetidos entre
   * anúncios do ML, anúncios duplicados). O findFirst sem orderBy devolvia uma
   * linha ARBITRÁRIA — o createMLListing chegou a reusar a linha de um anúncio
   * vivo em vez do placeholder do candidato, marcando retry nela (o cron
   * recriaria = duplicata) e, no sucesso, sobrescreveria o externalListingId
   * do anúncio vivo (órfão no ML).
   *
   * Preferência determinística: placeholder PENDING_ mais recente (a linha
   * "em criação", que é o que os callers de reuso querem); senão, a linha
   * mais recente.
   */
  static async findByProductAndAccount(
    productId: string,
    marketplaceAccountId: string,
  ) {
    const rows = await prisma.productListing.findMany({
      where: {
        productId,
        marketplaceAccountId,
      },
      orderBy: { createdAt: "desc" },
    });
    if (rows.length === 0) return null;
    return (
      rows.find((r) => r.externalListingId?.startsWith("PENDING_")) ?? rows[0]
    );
  }

  /**
   * Anúncio VIVO (active/paused, com id real) do par (produto, conta), se
   * houver. Usado pelo guard anti-duplicata do createMLListing: criar outro
   * anúncio enquanto este existe gera duplicata no ML. `closed` NÃO conta —
   * recriar um anúncio encerrado é o fluxo legítimo de republicação.
   * EGRESS: select mínimo.
   *
   * Com o espelhamento de status ligado (LISTING_STATUS_SYNC_DISABLED ≠ "1"),
   * o conjunto "vivo" inclui também estados em que o item AINDA EXISTE no
   * marketplace (moderação/despublicado): under_review/reviewing (ML/Shopee),
   * unlist (Shopee) e inactive (ML). Antes do espelho essas linhas ficavam
   * stale em active/paused e o guard as via; sem a ampliação, o primeiro
   * sweep as tiraria do radar e liberaria criar duplicata. closed/deleted/
   * banned continuam FORA (republicar é o fluxo legítimo).
   */
  static async findLiveByProductAndAccount(
    productId: string,
    marketplaceAccountId: string,
  ) {
    const liveStatuses =
      process.env.LISTING_STATUS_SYNC_DISABLED === "1"
        ? ["active", "paused"]
        : ["active", "paused", "under_review", "reviewing", "unlist", "inactive"];
    return prisma.productListing.findFirst({
      where: {
        productId,
        marketplaceAccountId,
        status: { in: liveStatuses },
        NOT: { externalListingId: { startsWith: "PENDING_" } },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, externalListingId: true, status: true },
    });
  }

  /**
   * EGRESS-lean: só o estado de retry de uma linha, pelo id. Usado pelo cron
   * para re-ler o PRÓPRIO candidato após a delegação — (produto, conta) pode
   * ter várias linhas, então re-ler por par pegaria a linha errada.
   */
  static async findRetryStateById(listingId: string) {
    return prisma.productListing.findUnique({
      where: { id: listingId },
      select: { id: true, retryEnabled: true },
    });
  }

  /**
   * Claim atômico de um candidato de retry — a trava ENTRE PROCESSOS do cron.
   *
   * A trava de reentrância do ListingRetryService (`passInFlight`) é por
   * processo. Em produção já rodaram DOIS crons em paralelo — o pm2 gerencia
   * um wrapper `npm exec` e, num restart de deploy, o node neto do deploy
   * anterior sobreviveu como órfão por vários minutos, processando os mesmos
   * candidatos com código antigo (flagrado em 16/07: escritas de duas versões
   * na mesma janela). Dois processos criando o mesmo anúncio = item DUPLICADO
   * no ML.
   *
   * O UPDATE condicional é atômico no Postgres: exige que o candidato ainda
   * esteja elegível (retryEnabled + nextRetryAt vencido) e o empurra `leaseMs`
   * para a frente. Só um processo vê `count === 1`; qualquer outro (segunda
   * instância, órfão de deploy, POST /ml/retry-pending concorrente) perde a
   * corrida e pula o candidato. Se o processo morrer no meio, o lease expira
   * e o candidato volta à fila sozinho.
   *
   * Advisory lock de sessão foi deliberadamente descartado: com o pool de
   * conexões do Prisma, o unlock pode rodar em outra conexão e o lock ficaria
   * preso para sempre (o cron nunca mais rodaria); e segurar uma transação
   * pela passada inteira esbarra no idle_in_transaction_session_timeout.
   */
  static async claimRetryCandidate(listingId: string, leaseMs: number) {
    const res = await prisma.productListing.updateMany({
      where: {
        id: listingId,
        retryEnabled: true,
        OR: [{ nextRetryAt: { lte: new Date() } }, { nextRetryAt: null }],
      },
      data: { nextRetryAt: new Date(Date.now() + leaseMs) },
    });
    return res.count === 1;
  }

  /**
   * Lista todos os listings de uma conta de marketplace
   */
  static async findAllByAccount(marketplaceAccountId: string) {
    return prisma.productListing.findMany({
      where: {
        marketplaceAccountId,
      },
      include: {
        product: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
    });
  }

  /**
   * Encontra placeholders pendentes para retry (externals que começam com PENDING_)
   * ou listings marcados com retryEnabled=true e nextRetryAt <= now
   */
  static async findPendingRetries(cutoff: Date, limit = 100) {
    // PERF: o WHERE legado — (LIKE 'PENDING\_%' ∧ retryEnabled≠false) ∨
    // retryEnabled=true — é logicamente equivalente a `retryEnabled = true`:
    // `retryEnabled` é Boolean NOT NULL (schema), então `{ not: false }` ≡
    // `= true` e, por absorção, (A ∧ B) ∨ B ≡ B. O conjunto retornado é
    // IDÊNTICO para qualquer estado do banco (placeholders PENDING_ nascem
    // com retryEnabled=false de propósito e nunca entravam pelo ramo LIKE).
    // O ramo LIKE, porém, forçava seq scan + sort na ProductListing inteira
    // a cada tick de 60s do ListingRetryService — a query nº 1 do
    // pg_stat_statements em produção (~94k calls, ~2,3M ms). O WHERE simples
    // casa com o índice ProductListing_retryEnabled_updatedAt_idx (DDL
    // manual, padrão do projeto) e elimina o sort.
    // Kill-switch: LISTING_RETRY_SIMPLE_WHERE_DISABLED=1 volta ao WHERE
    // legado (lido a cada chamada — rollback por env sem redeploy).
    return prisma.productListing.findMany({
      where:
        process.env.LISTING_RETRY_SIMPLE_WHERE_DISABLED === "1"
          ? {
              AND: [
                {
                  OR: [
                    {
                      externalListingId: { startsWith: "PENDING_" },
                      retryEnabled: { not: false },
                    },
                    { retryEnabled: true },
                  ],
                },
                {
                  OR: [{ nextRetryAt: { lte: cutoff } }, { nextRetryAt: null }],
                },
              ],
            }
          : {
              retryEnabled: true,
              OR: [{ nextRetryAt: { lte: cutoff } }, { nextRetryAt: null }],
            },
      include: { product: true, marketplaceAccount: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });
  }

  static async incrementRetryAttempts(
    listingId: string,
    data: {
      lastError?: string | null;
      nextRetryAt?: Date | null;
      retryEnabled?: boolean;
    },
  ) {
    return prisma.productListing.update({
      where: { id: listingId },
      data: {
        retryAttempts: { increment: 1 },
        lastError: data.lastError ?? undefined,
        nextRetryAt:
          data.nextRetryAt === undefined ? undefined : data.nextRetryAt,
        retryEnabled: data.retryEnabled ?? undefined,
      },
    });
  }

  /**
   * Lista todos os listings de um produto
   */
  static async findAllByProduct(productId: string) {
    return prisma.productListing.findMany({
      where: {
        productId,
      },
      include: {
        marketplaceAccount: true,
      },
    });
  }

  /**
   * Atualiza status de um listing
   */
  static async updateStatus(listingId: string, status: string) {
    return prisma.productListing.update({
      where: { id: listingId },
      data: { status },
    });
  }

  /**
   * EGRESS-lean: variante do updateStatus para o espelhamento de status —
   * devolve só (id, status, updatedAt) em vez da linha inteira (os JSONs de
   * override são o maior peso por linha). O espelho grava com frequência
   * (webhook/sync/sweep/live), então a projeção importa.
   */
  static async updateStatusLean(listingId: string, status: string) {
    return prisma.productListing.update({
      where: { id: listingId },
      data: { status },
      select: { id: true, status: true, updatedAt: true },
    });
  }

  /**
   * EGRESS-lean: só (id, status) do par (conta, anúncio), para o espelho de
   * status do webhook decidir se grava — NÃO usar findByExternalListingId
   * aqui (include de Product inteiro por evento de webhook).
   */
  static async findStatusByExternalListingId(
    marketplaceAccountId: string,
    externalListingId: string,
  ) {
    return prisma.productListing.findUnique({
      where: {
        marketplaceAccountId_externalListingId: {
          marketplaceAccountId,
          externalListingId,
        },
      },
      select: { id: true, status: true },
    });
  }

  /**
   * Reaponta um listing para outra conta de marketplace.
   *
   * Usado pelo reparo automático de ownership: quando a remoção via API
   * estoura 403 ("you are not the seller") e descobrimos que o anúncio
   * pertence a outra conta do MESMO usuário, atualizamos o FK aqui em vez
   * de pedir intervenção manual.
   *
   * O índice único `(marketplaceAccountId, externalListingId)` é respeitado
   * porque o destino é uma conta diferente — só dispara conflict se já
   * houver outro listing local para o mesmo externalId nessa conta-destino,
   * o que indicaria duplicação prévia (raro; deixar o erro propagar).
   */
  static async reassignAccount(
    listingId: string,
    newAccountId: string,
  ) {
    return prisma.productListing.update({
      where: { id: listingId },
      data: { marketplaceAccountId: newAccountId },
    });
  }

  /**
   * Atualiza SKU externo de um listing
   */
  static async updateExternalSku(listingId: string, externalSku: string) {
    return prisma.productListing.update({
      where: { id: listingId },
      data: { externalSku },
    });
  }

  /**
   * Atualiza campos principais de um listing quando o item for publicado no ML
   */
  static async updateListing(
    listingId: string,
    data: {
      externalListingId?: string;
      externalSku?: string;
      permalink?: string | null;
      status?: string;
      // retry metadata updates
      retryAttempts?: number;
      nextRetryAt?: Date | null;
      lastError?: string | null;
      retryEnabled?: boolean;
      // optionally update requestedCategoryId
      requestedCategoryId?: string | null;
      // ML listing settings
      listingType?: string | null;
      itemCondition?: string | null;
      hasWarranty?: boolean | null;
      warrantyUnit?: string | null;
      warrantyDuration?: number | null;
      shippingMode?: string | null;
      freeShipping?: boolean | null;
      localPickup?: boolean | null;
      manufacturingTime?: number | null;
      // Override fields per-listing (NULL = herda do produto)
      titleOverride?: string | null;
      descriptionOverride?: string | null;
      priceOverride?: number | null;
      brandOverride?: string | null;
      modelOverride?: string | null;
      yearOverride?: string | null;
      versionOverride?: string | null;
      categoryOverride?: string | null;
      mlCategoryOverride?: string | null;
      shopeeCategoryOverride?: string | null;
      partNumberOverride?: string | null;
      qualityOverride?: string | null;
      heightCmOverride?: number | null;
      widthCmOverride?: number | null;
      lengthCmOverride?: number | null;
      weightKgOverride?: number | null;
      imageUrlsOverride?: unknown;
      attributesOverride?: unknown;
      compatibilitiesOverride?: unknown;
      sourceVehicleOverride?: string | null;
      // Diagnóstico do envio de compatibilidade ao marketplace.
      compatSyncedAt?: Date | null;
      compatDiagnostics?: unknown;
    },
  ) {
    return prisma.productListing.update({
      where: { id: listingId },
      data: {
        externalListingId: data.externalListingId || undefined,
        externalSku: data.externalSku || undefined,
        permalink: data.permalink === undefined ? undefined : data.permalink,
        status: data.status || undefined,
        retryAttempts: data.retryAttempts ?? undefined,
        nextRetryAt:
          data.nextRetryAt === undefined ? undefined : data.nextRetryAt,
        lastError: data.lastError === undefined ? undefined : data.lastError,
        retryEnabled: data.retryEnabled ?? undefined,
        requestedCategoryId:
          data.requestedCategoryId === undefined
            ? undefined
            : data.requestedCategoryId,
        listingType:
          data.listingType === undefined ? undefined : data.listingType,
        itemCondition:
          data.itemCondition === undefined ? undefined : data.itemCondition,
        hasWarranty:
          data.hasWarranty === undefined ? undefined : data.hasWarranty,
        warrantyUnit:
          data.warrantyUnit === undefined ? undefined : data.warrantyUnit,
        warrantyDuration:
          data.warrantyDuration === undefined
            ? undefined
            : data.warrantyDuration,
        shippingMode:
          data.shippingMode === undefined ? undefined : data.shippingMode,
        freeShipping:
          data.freeShipping === undefined ? undefined : data.freeShipping,
        localPickup:
          data.localPickup === undefined ? undefined : data.localPickup,
        manufacturingTime:
          data.manufacturingTime === undefined
            ? undefined
            : data.manufacturingTime,
        titleOverride:
          data.titleOverride === undefined ? undefined : data.titleOverride,
        descriptionOverride:
          data.descriptionOverride === undefined
            ? undefined
            : data.descriptionOverride,
        // Override de preço <= 0 significa "herdar o preço do produto" (null),
        // nunca "publicar por R$ 0". Normaliza na escrita para que o valor
        // inválido não chegue ao banco por nenhum caminho (rota, dispatcher,
        // import). `undefined` continua sendo "não mexer no campo".
        priceOverride:
          data.priceOverride === undefined
            ? undefined
            : data.priceOverride !== null && data.priceOverride > 0
              ? data.priceOverride
              : null,
        brandOverride:
          data.brandOverride === undefined ? undefined : data.brandOverride,
        modelOverride:
          data.modelOverride === undefined ? undefined : data.modelOverride,
        yearOverride:
          data.yearOverride === undefined ? undefined : data.yearOverride,
        versionOverride:
          data.versionOverride === undefined ? undefined : data.versionOverride,
        categoryOverride:
          data.categoryOverride === undefined
            ? undefined
            : data.categoryOverride,
        mlCategoryOverride:
          data.mlCategoryOverride === undefined
            ? undefined
            : data.mlCategoryOverride,
        shopeeCategoryOverride:
          data.shopeeCategoryOverride === undefined
            ? undefined
            : data.shopeeCategoryOverride,
        partNumberOverride:
          data.partNumberOverride === undefined
            ? undefined
            : data.partNumberOverride,
        qualityOverride:
          data.qualityOverride === undefined ? undefined : data.qualityOverride,
        heightCmOverride:
          data.heightCmOverride === undefined
            ? undefined
            : data.heightCmOverride,
        widthCmOverride:
          data.widthCmOverride === undefined ? undefined : data.widthCmOverride,
        lengthCmOverride:
          data.lengthCmOverride === undefined
            ? undefined
            : data.lengthCmOverride,
        weightKgOverride:
          data.weightKgOverride === undefined
            ? undefined
            : data.weightKgOverride,
        imageUrlsOverride:
          data.imageUrlsOverride === undefined
            ? undefined
            : (data.imageUrlsOverride as never),
        attributesOverride:
          data.attributesOverride === undefined
            ? undefined
            : (data.attributesOverride as never),
        compatibilitiesOverride:
          data.compatibilitiesOverride === undefined
            ? undefined
            : (data.compatibilitiesOverride as never),
        sourceVehicleOverride:
          data.sourceVehicleOverride === undefined
            ? undefined
            : data.sourceVehicleOverride,
        compatSyncedAt:
          data.compatSyncedAt === undefined ? undefined : data.compatSyncedAt,
        compatDiagnostics:
          data.compatDiagnostics === undefined
            ? undefined
            : (data.compatDiagnostics as never),
      },
    });
  }

  /**
   * Remove um listing
   */
  static async deleteListing(listingId: string) {
    return prisma.productListing.delete({
      where: { id: listingId },
    });
  }

  /**
   * Busca listing por ID interno.
   *
   * Egress (padrão perf do projeto): `leanProduct` projeta o Product incluído
   * a { userId, sku } — os ÚNICOS campos que o caminho de edição de fields lê
   * (ownership + chave de API Magalu). Sem a flag (default), comportamento
   * idêntico ao histórico: row completa do produto (JSONBs pesados inclusos),
   * para os callers que precisam dela. O cast mantém o TIPO de retorno
   * estável (payload cheio) para não propagar união de tipos aos consumidores;
   * NÃO leia outros campos de `listing.product` num caminho que passe
   * leanProduct — eles virão undefined em runtime.
   */
  static async findById(
    listingId: string,
    opts?: { leanProduct?: boolean },
  ) {
    const include = (
      opts?.leanProduct
        ? {
            product: { select: { userId: true, sku: true } },
            marketplaceAccount: true,
          }
        : { product: true, marketplaceAccount: true }
    ) as { product: true; marketplaceAccount: true };
    return prisma.productListing.findUnique({
      where: { id: listingId },
      include,
    });
  }

  /**
   * Write cirúrgico de priceOverride com retorno mínimo (select id) — padrão
   * perf(egress): o `updateListing` genérico devolve a row inteira, que os
   * caminhos de preço escalonado descartam. Mantém a MESMA normalização do
   * updateListing: valor <= 0 vira null ("herdar o preço do produto"), nunca
   * chega R$ 0 ao banco; null explícito limpa o override.
   */
  static async updatePriceOverride(
    listingId: string,
    priceOverride: number | null,
  ): Promise<void> {
    await prisma.productListing.update({
      where: { id: listingId },
      data: {
        priceOverride:
          priceOverride !== null && priceOverride > 0 ? priceOverride : null,
      },
      select: { id: true },
    });
  }
}
