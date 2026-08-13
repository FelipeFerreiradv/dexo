import {
  Scrap,
  ScrapCreate,
  ScrapUpdate,
  ScrapRepository,
  ScrapListOptions,
  ScrapPipeline,
  ScrapPart,
  ScrapManualSale,
  ScrapStatusEventDTO,
} from "../interfaces/scrap.interface";
import prisma from "../lib/prisma";
import {
  Prisma,
  Scrap as PrismaScrap,
  ScrapStatus,
  LogisticsStatus,
} from "@prisma/client";

// Campos omitidos na LISTAGEM/PIPELINE (findById os traz). O mapper os trata
// como opcionais para aceitar tanto o registro completo quanto o enxuto.
type ScrapListOmittedKey =
  | "imageUrls"
  | "notes"
  | "ncm"
  | "accessKey"
  | "issueDate"
  | "entryDate"
  | "nfeNumber"
  | "nfeProtocol"
  | "operationNature"
  | "nfeSeries"
  | "fiscalModel"
  | "icmsValue"
  | "icmsCtValue"
  | "freightMode"
  | "issuePurpose";

function mapPrismaToScrap(
  item: Omit<PrismaScrap, ScrapListOmittedKey> &
    Partial<Pick<PrismaScrap, ScrapListOmittedKey>> & {
      _count?: { products: number };
      location?: { code: string } | null;
    },
): Scrap {
  return {
    id: item.id,
    userId: item.userId,

    brand: item.brand,
    model: item.model,
    nickname: item.nickname ?? undefined,
    year: item.year ?? undefined,
    version: item.version ?? undefined,
    color: item.color ?? undefined,
    plate: item.plate ?? undefined,
    chassis: item.chassis ?? undefined,
    engineNumber: item.engineNumber ?? undefined,
    renavam: item.renavam ?? undefined,
    lot: item.lot ?? undefined,
    deregistrationCert: item.deregistrationCert ?? undefined,

    cost: item.cost?.toNumber() ?? undefined,
    extraCosts: item.extraCosts?.toNumber() ?? undefined,
    paymentMethod: item.paymentMethod ?? undefined,

    locationId: item.locationId ?? undefined,
    locationCode: item.location?.code ?? undefined,

    ncm: item.ncm ?? undefined,
    supplierCnpj: item.supplierCnpj ?? undefined,
    accessKey: item.accessKey ?? undefined,
    issueDate: item.issueDate ?? undefined,
    entryDate: item.entryDate ?? undefined,
    nfeNumber: item.nfeNumber ?? undefined,
    nfeProtocol: item.nfeProtocol ?? undefined,
    operationNature: item.operationNature ?? undefined,
    nfeSeries: item.nfeSeries ?? undefined,
    fiscalModel: item.fiscalModel ?? undefined,
    icmsValue: item.icmsValue?.toNumber() ?? undefined,
    icmsCtValue: item.icmsCtValue?.toNumber() ?? undefined,
    freightMode: item.freightMode ?? undefined,
    issuePurpose: item.issuePurpose ?? undefined,

    imageUrls: item.imageUrls ?? [],

    status: item.status,
    logisticsStatus: item.logisticsStatus,
    notes: item.notes ?? undefined,
    createdByUserId: item.createdByUserId ?? undefined,

    createdAt: item.createdAt,
    updatedAt: item.updatedAt,

    productsCount: item._count?.products ?? 0,
  };
}

/**
 * ⭐ TENANT GUARD DA LOCALIZAÇÃO. Espelha o que `Product.scrapId` já faz
 * (product.repository.ts:1008-1021), e existe pelo mesmo motivo.
 *
 * `Scrap.locationId` é FK para `Location` e o banco **não** garante que
 * `Scrap.userId == Location.userId`. Sem esta checagem, um payload forjado
 * pendura a sucata numa prateleira de OUTRO tenant — e a partir daí ela aparece
 * na contagem de ocupação daquela localização, numa tela que o dono da
 * prateleira abre achando que é dele.
 *
 * No-op para o caminho legítimo (mesma conta) e para sucata sem localização.
 */
async function assertLocalizacaoDoTenant(
  locationId: string | null | undefined,
  userId: string | null | undefined,
): Promise<void> {
  if (!locationId || !userId) return;
  const propria = await prisma.location.findFirst({
    where: { id: locationId, userId },
    select: { id: true },
  });
  if (!propria) {
    throw new Error(
      "Localização inválida: localização não encontrada para este usuário",
    );
  }
}

export class ScrapRepositoryPrisma implements ScrapRepository {
  async create(data: ScrapCreate): Promise<Scrap> {
    try {
      await assertLocalizacaoDoTenant(data.locationId, data.userId);

      const result = await prisma.scrap.create({
        data: {
          userId: data.userId,
          brand: data.brand,
          model: data.model,
          nickname: data.nickname ?? null,
          year: data.year ?? null,
          version: data.version ?? null,
          color: data.color ?? null,
          plate: data.plate ?? null,
          chassis: data.chassis ?? null,
          engineNumber: data.engineNumber ?? null,
          renavam: data.renavam ?? null,
          lot: data.lot ?? null,
          deregistrationCert: data.deregistrationCert ?? null,
          cost: data.cost ?? null,
          extraCosts: data.extraCosts ?? null,
          paymentMethod: data.paymentMethod ?? null,
          locationId: data.locationId ?? null,
          ncm: data.ncm ?? null,
          supplierCnpj: data.supplierCnpj ?? null,
          accessKey: data.accessKey ?? null,
          issueDate: data.issueDate ?? null,
          entryDate: data.entryDate ?? null,
          nfeNumber: data.nfeNumber ?? null,
          nfeProtocol: data.nfeProtocol ?? null,
          operationNature: data.operationNature ?? null,
          nfeSeries: data.nfeSeries ?? null,
          fiscalModel: data.fiscalModel ?? null,
          icmsValue: data.icmsValue ?? null,
          icmsCtValue: data.icmsCtValue ?? null,
          freightMode: data.freightMode ?? null,
          issuePurpose: data.issuePurpose ?? null,
          imageUrls: data.imageUrls ?? [],
          status: data.status ?? "AVAILABLE",
          logisticsStatus: data.logisticsStatus ?? "IN_YARD",
          notes: data.notes ?? null,
          createdByUserId: data.createdByUserId ?? null,
        },
        include: {
          location: { select: { code: true } },
          _count: { select: { products: true } },
        },
      });

      return mapPrismaToScrap(result);
    } catch (error) {
      console.error("Erro Prisma ao criar sucata:", error);
      throw new Error(
        error instanceof Error ? error.message : "Erro ao criar sucata",
      );
    }
  }

  async findById(id: string, userId?: string): Promise<Scrap | null> {
    try {
      const item = await prisma.scrap.findFirst({
        where: { id, ...(userId ? { userId } : {}) },
        include: {
          location: { select: { code: true } },
          _count: { select: { products: true } },
        },
      });
      if (!item) return null;
      return mapPrismaToScrap(item);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async findAll(
    options?: ScrapListOptions,
    userId?: string,
  ): Promise<{ scraps: Scrap[]; total: number }> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 10;
    const skip = (page - 1) * limit;
    const search = options?.search ?? "";

    const where: any = userId ? { userId } : {};

    if (options?.status) {
      where.status = options.status;
    }

    if (options?.logisticsStatus) {
      where.logisticsStatus = options.logisticsStatus;
    }

    if (search) {
      where.OR = [
        { brand: { contains: search, mode: "insensitive" as const } },
        { model: { contains: search, mode: "insensitive" as const } },
        { plate: { contains: search, mode: "insensitive" as const } },
        { chassis: { contains: search, mode: "insensitive" as const } },
        { lot: { contains: search, mode: "insensitive" as const } },
        { nickname: { contains: search, mode: "insensitive" as const } },
      ];
    }

    try {
      const [items, total] = await Promise.all([
        prisma.scrap.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          // EGRESS: a tabela não exibe fotos/notas/bloco fiscal. O Edit recarrega
          // o registro completo via GET /scraps/:id (findById, sem omit) ao abrir
          // — então a listagem não trafega essas colunas. imageUrls (array de URLs
          // de fotos) é o maior ofensor. Campos exibidos passam intactos.
          omit: {
            imageUrls: true,
            notes: true,
            ncm: true,
            accessKey: true,
            issueDate: true,
            entryDate: true,
            nfeNumber: true,
            nfeProtocol: true,
            operationNature: true,
            nfeSeries: true,
            fiscalModel: true,
            icmsValue: true,
            icmsCtValue: true,
            freightMode: true,
            issuePurpose: true,
          },
          include: {
            location: { select: { code: true } },
            _count: { select: { products: true } },
          },
        }),
        prisma.scrap.count({ where }),
      ]);

      const scraps = items.map(mapPrismaToScrap);
      return { scraps, total };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  // Pipeline logístico (Kanban): contadores por estágio + amostra de cards,
  // tudo num único request (1 groupBy + N findMany em paralelo, sem N+1).
  async pipeline(userId: string): Promise<ScrapPipeline> {
    const STAGES: LogisticsStatus[] = [
      "IN_TRANSIT",
      "IN_YARD",
      "ON_LIFT",
      "DISMANTLED",
    ];
    const PER_STAGE = 12;

    const [counts, ...lists] = await Promise.all([
      prisma.scrap.groupBy({
        by: ["logisticsStatus"],
        where: { userId },
        _count: { _all: true },
      }),
      ...STAGES.map((stage) =>
        prisma.scrap.findMany({
          where: { userId, logisticsStatus: stage },
          orderBy: { createdAt: "desc" },
          take: PER_STAGE,
          // EGRESS: idem findAll — os cards do Kanban não mostram fotos/notas/
          // fiscais; o Edit recarrega via GET /scraps/:id. Até 48 linhas (4x12),
          // então o corte de imageUrls aqui é o maior ganho da página.
          omit: {
            imageUrls: true,
            notes: true,
            ncm: true,
            accessKey: true,
            issueDate: true,
            entryDate: true,
            nfeNumber: true,
            nfeProtocol: true,
            operationNature: true,
            nfeSeries: true,
            fiscalModel: true,
            icmsValue: true,
            icmsCtValue: true,
            freightMode: true,
            issuePurpose: true,
          },
          include: {
            location: { select: { code: true } },
            _count: { select: { products: true } },
          },
        }),
      ),
    ]);

    const countByStage = new Map<string, number>(
      counts.map((c: any) => [c.logisticsStatus, c._count?._all ?? 0]),
    );

    const pipeline = {} as ScrapPipeline;
    STAGES.forEach((stage, i) => {
      pipeline[stage] = {
        count: countByStage.get(stage) ?? 0,
        scraps: lists[i].map(mapPrismaToScrap),
      };
    });
    return pipeline;
  }

  // Agregados financeiros de uma sucata num único request (3 subqueries
  // escalares). Espelha a lógica financeira existente: receita = unitPrice
  // (snapshot) * quantity; marketplace conta Order PAID/SHIPPED/DELIVERED;
  // balcão conta Receivable PAGA. O chamador (usecase) já validou que a
  // sucata pertence ao userId, então scrapId já restringe ao tenant.
  async getScrapMoney(
    scrapId: string,
    userId: string,
  ): Promise<{ marketplace: number; counter: number; potential: number }> {
    const rows = await prisma.$queryRaw<
      { marketplace: number; counter: number; potential: number }[]
    >(Prisma.sql`
      SELECT
        (SELECT COALESCE(SUM(oi."unitPrice" * oi."quantity"), 0)::float8
           FROM "OrderItem" oi
           JOIN "Product" p ON p."id" = oi."productId"
           JOIN "Order" o ON o."id" = oi."orderId"
           JOIN "MarketplaceAccount" ma ON ma."id" = o."marketplaceAccountId"
           WHERE p."scrapId" = ${scrapId}
             AND o."status"::text IN ('PAID', 'SHIPPED', 'DELIVERED')
             AND ma."userId" = ${userId}
        ) AS marketplace,
        (SELECT COALESCE(SUM(ri."unitPrice" * ri."quantity"), 0)::float8
           FROM "ReceivableItem" ri
           LEFT JOIN "Product" p ON p."id" = ri."productId"
           JOIN "Receivable" r ON r."id" = ri."receivableId"
           WHERE COALESCE(ri."scrapId", p."scrapId") = ${scrapId}
             AND r."status"::text = 'PAGA'
             AND r."userId" = ${userId}
        ) AS counter,
        (SELECT COALESCE(SUM(p."price" * p."stock"), 0)::float8
           FROM "Product" p
           JOIN "Scrap" s ON s."id" = p."scrapId"
           WHERE p."scrapId" = ${scrapId}
             AND s."userId" = ${userId}
             AND p."userId" = ${userId}
             AND p."stock" > 0
        ) AS potential
    `);

    const row = rows[0] ?? { marketplace: 0, counter: 0, potential: 0 };
    return {
      marketplace: Number(row.marketplace) || 0,
      counter: Number(row.counter) || 0,
      potential: Number(row.potential) || 0,
    };
  }

  // Peças de uma sucata com etiqueta Vendido/Em estoque, qualidade, flags e
  // quantidade realmente vendida (marketplace + balcão). scrapId já restringe
  // ao tenant (sucata validada no usecase); userId reforça o escopo das vendas.
  // Sem N+1: 1 findMany + 2 groupBy agregados.
  async getScrapParts(scrapId: string, userId: string): Promise<ScrapPart[]> {
    const products = await prisma.product.findMany({
      // userId além de scrapId: defense-in-depth contra produto de outro tenant
      // apontando para esta sucata (Product.scrapId não garante Product.userId
      // == Scrap.userId). Para dados legítimos é no-op (mesmo dono).
      where: { scrapId, userId },
      select: {
        id: true,
        name: true,
        sku: true,
        partNumber: true,
        price: true,
        stock: true,
        quality: true,
        isSecurityItem: true,
        isTraceable: true,
      },
      orderBy: [{ stock: "desc" }, { name: "asc" }],
    });

    if (products.length === 0) return [];
    const ids = products.map((p) => p.id);

    const [marketplaceSold, counterSold] = await Promise.all([
      prisma.orderItem.groupBy({
        by: ["productId"],
        where: {
          productId: { in: ids },
          order: {
            status: { in: ["PAID", "SHIPPED", "DELIVERED"] },
            marketplaceAccount: { userId },
          },
        },
        _sum: { quantity: true },
      }),
      prisma.receivableItem.groupBy({
        by: ["productId"],
        where: {
          productId: { in: ids },
          receivable: { status: "PAGA", userId },
        },
        _sum: { quantity: true },
      }),
    ]);

    const soldBy = new Map<string, number>();
    for (const r of marketplaceSold) {
      soldBy.set(r.productId, r._sum.quantity ?? 0);
    }
    for (const r of counterSold) {
      // productId virou nulável no schema (itens manuais). O groupBy já filtra
      // productId IN ids (subconjunto não-nulo), mas o tipo agora é
      // string | null — narrow defensivo para satisfazer o Map<string, number>.
      if (r.productId == null) continue;
      soldBy.set(
        r.productId,
        (soldBy.get(r.productId) ?? 0) + (r._sum.quantity ?? 0),
      );
    }

    return products.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      partNumber: p.partNumber ?? undefined,
      price: Number(p.price ?? 0),
      stock: p.stock,
      status: p.stock > 0 ? "IN_STOCK" : "SOLD",
      quality: p.quality ?? undefined,
      isSecurityItem: p.isSecurityItem ?? false,
      isTraceable: p.isTraceable ?? false,
      soldQuantity: soldBy.get(p.id) ?? 0,
    }));
  }

  // Vendas avulsas (itens MANUAIS, sem produto cadastrado) atribuídas
  // diretamente a esta sucata via ReceivableItem.scrapId, em contas PAGA.
  // Restringir a `productId IS NULL` mantém este conjunto DISJUNTO das peças
  // cadastradas (getScrapParts) — um item manual nunca aparece na tabela de
  // peças e vice-versa. Display-only: a receita já está somada no `counter`
  // de getScrapMoney (não há dupla contagem). Para productId NULL,
  // COALESCE(ri.scrapId, p.scrapId) colapsa em ri.scrapId — o predicado é
  // escrito direto, sem JOIN com Product. scrapId já restringe ao tenant; o
  // filtro r.userId reforça o escopo.
  async getScrapManualSales(
    scrapId: string,
    userId: string,
  ): Promise<ScrapManualSale[]> {
    const rows = await prisma.$queryRaw<
      { description: string | null; quantity: number; unitPrice: number; total: number }[]
    >(Prisma.sql`
      SELECT
        ri."description"                          AS description,
        ri."quantity"                             AS quantity,
        ri."unitPrice"::float8                    AS "unitPrice",
        (ri."unitPrice" * ri."quantity")::float8  AS total
      FROM "ReceivableItem" ri
      JOIN "Receivable" r ON r."id" = ri."receivableId"
      WHERE ri."productId" IS NULL
        AND ri."scrapId" = ${scrapId}
        AND r."status"::text = 'PAGA'
        AND r."userId" = ${userId}
      ORDER BY ri."createdAt" DESC
    `);

    return rows.map((r) => ({
      description: r.description ?? null,
      quantity: Number(r.quantity) || 0,
      unitPrice: Number(r.unitPrice) || 0,
      total: Number(r.total) || 0,
    }));
  }

  // Estágios de várias sucatas por id (Visão de Balcão). Os ids já vêm de
  // produtos do tenant; o filtro userId reforça o isolamento.
  async findStagesByIds(
    ids: string[],
    userId: string,
  ): Promise<
    Array<{
      id: string;
      brand: string;
      model: string;
      year: string | null;
      plate: string | null;
      logisticsStatus: LogisticsStatus;
    }>
  > {
    if (ids.length === 0) return [];
    return prisma.scrap.findMany({
      where: { id: { in: ids }, userId },
      select: {
        id: true,
        brand: true,
        model: true,
        year: true,
        plate: true,
        logisticsStatus: true,
      },
    });
  }

  // Registra um evento de transição de estágio (histórico — diferencial F).
  async recordStatusEvent(
    scrapId: string,
    userId: string,
    fromStatus: LogisticsStatus | null,
    toStatus: LogisticsStatus,
  ): Promise<void> {
    await prisma.scrapStatusEvent.create({
      data: { scrapId, userId, fromStatus, toStatus },
    });
  }

  // Linha do tempo de transições de uma sucata (mais antigo → mais recente).
  async getStatusEvents(
    scrapId: string,
    userId: string,
  ): Promise<ScrapStatusEventDTO[]> {
    const events = await prisma.scrapStatusEvent.findMany({
      where: { scrapId, userId },
      orderBy: { createdAt: "asc" },
      select: { fromStatus: true, toStatus: true, createdAt: true },
    });
    return events.map((e) => ({
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      createdAt: e.createdAt,
    }));
  }

  async update(id: string, data: ScrapUpdate, userId?: string): Promise<Scrap> {
    try {
      if (userId) {
        const owner = await prisma.scrap.findFirst({
          where: { id, userId },
          select: { id: true },
        });
        if (!owner) throw new Error("Sucata não encontrada para este usuário");
      }

      // O PUT também pode trocar a prateleira — mesmo furo do create.
      await assertLocalizacaoDoTenant(data.locationId, userId);

      const result = await prisma.scrap.update({
        where: { id },
        data: {
          ...(data.brand !== undefined && { brand: data.brand }),
          ...(data.model !== undefined && { model: data.model }),
          ...(data.nickname !== undefined && { nickname: data.nickname }),
          ...(data.year !== undefined && { year: data.year }),
          ...(data.version !== undefined && { version: data.version }),
          ...(data.color !== undefined && { color: data.color }),
          ...(data.plate !== undefined && { plate: data.plate }),
          ...(data.chassis !== undefined && { chassis: data.chassis }),
          ...(data.engineNumber !== undefined && {
            engineNumber: data.engineNumber,
          }),
          ...(data.renavam !== undefined && { renavam: data.renavam }),
          ...(data.lot !== undefined && { lot: data.lot }),
          ...(data.deregistrationCert !== undefined && {
            deregistrationCert: data.deregistrationCert,
          }),
          ...(data.cost !== undefined && { cost: data.cost }),
          ...(data.extraCosts !== undefined && { extraCosts: data.extraCosts }),
          ...(data.paymentMethod !== undefined && {
            paymentMethod: data.paymentMethod,
          }),
          ...(data.locationId !== undefined && { locationId: data.locationId }),
          ...(data.ncm !== undefined && { ncm: data.ncm }),
          ...(data.supplierCnpj !== undefined && {
            supplierCnpj: data.supplierCnpj,
          }),
          ...(data.accessKey !== undefined && { accessKey: data.accessKey }),
          ...(data.issueDate !== undefined && { issueDate: data.issueDate }),
          ...(data.entryDate !== undefined && { entryDate: data.entryDate }),
          ...(data.nfeNumber !== undefined && { nfeNumber: data.nfeNumber }),
          ...(data.nfeProtocol !== undefined && {
            nfeProtocol: data.nfeProtocol,
          }),
          ...(data.operationNature !== undefined && {
            operationNature: data.operationNature,
          }),
          ...(data.nfeSeries !== undefined && { nfeSeries: data.nfeSeries }),
          ...(data.fiscalModel !== undefined && {
            fiscalModel: data.fiscalModel,
          }),
          ...(data.icmsValue !== undefined && { icmsValue: data.icmsValue }),
          ...(data.icmsCtValue !== undefined && {
            icmsCtValue: data.icmsCtValue,
          }),
          ...(data.freightMode !== undefined && {
            freightMode: data.freightMode,
          }),
          ...(data.issuePurpose !== undefined && {
            issuePurpose: data.issuePurpose,
          }),
          ...(data.imageUrls !== undefined && { imageUrls: data.imageUrls }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.logisticsStatus !== undefined && {
            logisticsStatus: data.logisticsStatus,
          }),
          ...(data.notes !== undefined && { notes: data.notes }),
        },
        include: {
          location: { select: { code: true } },
          _count: { select: { products: true } },
        },
      });

      return mapPrismaToScrap(result);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  // Transição de estágio logístico (PATCH dedicado). Verifica ownership e
  // atualiza só a coluna logisticsStatus — não toca em Product nem dispara sync.
  async updateLogisticsStatus(
    id: string,
    logisticsStatus: LogisticsStatus,
    userId?: string,
  ): Promise<Scrap> {
    try {
      if (userId) {
        const owner = await prisma.scrap.findFirst({
          where: { id, userId },
          select: { id: true },
        });
        if (!owner) throw new Error("Sucata não encontrada para este usuário");
      }

      const result = await prisma.scrap.update({
        where: { id },
        data: { logisticsStatus },
        include: {
          location: { select: { code: true } },
          _count: { select: { products: true } },
        },
      });

      return mapPrismaToScrap(result);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async delete(id: string, userId?: string): Promise<void> {
    try {
      if (userId) {
        const owner = await prisma.scrap.findFirst({
          where: { id, userId },
          select: { id: true },
        });
        if (!owner) throw new Error("Sucata não encontrada para este usuário");
      }

      // Desvincula produtos antes de excluir (SET NULL)
      await prisma.product.updateMany({
        where: { scrapId: id },
        data: { scrapId: null },
      });

      await prisma.scrap.delete({ where: { id } });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async count(userId?: string): Promise<number> {
    try {
      return await prisma.scrap.count({ where: userId ? { userId } : {} });
    } catch {
      throw new Error("Erro ao contar sucatas");
    }
  }
}
