import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/prisma", () => {
  const stockSyncJob = { upsert: vi.fn() };
  const mock: any = {
    stockLog: { findMany: vi.fn() },
    productListing: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
    systemLog: { findFirst: vi.fn().mockResolvedValue(null) },
    stockSyncJob,
    $queryRaw: vi.fn().mockResolvedValue([]),
    // advisory lock (pg_advisory_xact_lock) é executado via $executeRaw em prod
    $executeRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation(async (cb: any) => cb(mock));
  return { default: mock };
});

vi.mock("@/app/marketplaces/services/ml-api.service", () => ({
  MLApiService: { getItemDetails: vi.fn(), getItemsStockSnapshot: vi.fn() },
}));

vi.mock("@/app/marketplaces/services/shopee-api.service", () => ({
  ShopeeApiService: { getItemsBaseInfo: vi.fn() },
}));

vi.mock("@/app/marketplaces/usecases/sync.usercase", () => ({
  SyncUseCase: {
    // Delega ao formato real da Shopee: estoque vem de stock_info_v2 e, na
    // falta dele, do primeiro stock_info.
    getShopeeItemAvailableStock: vi.fn((item: any) => {
      const v2 = item?.stock_info_v2?.summary_info?.total_available_stock;
      if (typeof v2 === "number") return v2;
      const legado = item?.stock_info?.[0]?.stock_quantity;
      return typeof legado === "number" ? legado : 0;
    }),
  },
}));

vi.mock("@/app/services/system-log.service", () => ({
  SystemLogService: { logError: vi.fn().mockResolvedValue(undefined) },
}));

import prisma from "@/app/lib/prisma";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { SystemLogService } from "@/app/services/system-log.service";
import { StockReconciliationService } from "@/app/marketplaces/services/stock-reconciliation.service";

const makeListingRow = (overrides: Partial<any> = {}) => ({
  id: "lst-1",
  productId: "prod-1",
  marketplaceAccountId: "acc-1",
  product: { stock: 5 },
  marketplaceAccount: { platform: "SHOPEE", status: "ACTIVE" },
  ...overrides,
});

describe("StockReconciliationService.runOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma as any).$transaction.mockImplementation(async (cb: any) =>
      cb(prisma),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("não enfileira nada quando não há StockLog recente", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([]);

    await StockReconciliationService.runOnce();

    expect((prisma as any).productListing.findMany).not.toHaveBeenCalled();
    expect((prisma as any).stockSyncJob.upsert).not.toHaveBeenCalled();
  });

  // A reserva não gera StockLog (o `stock` não muda), então peça comprometida
  // em venda aberta é invisível para esta varredura. A flag inclui esses
  // produtos; sem ela, o comportamento é o de sempre.
  describe("peças comprometidas em venda aberta (RESERVED_STOCK_RECONCILE_ENABLED)", () => {
    const comFlag = async (valor: string | undefined, fn: () => Promise<void>) => {
      const anterior = process.env.RESERVED_STOCK_RECONCILE_ENABLED;
      if (valor === undefined) {
        delete process.env.RESERVED_STOCK_RECONCILE_ENABLED;
      } else {
        process.env.RESERVED_STOCK_RECONCILE_ENABLED = valor;
      }
      try {
        await fn();
      } finally {
        if (anterior === undefined) {
          delete process.env.RESERVED_STOCK_RECONCILE_ENABLED;
        } else {
          process.env.RESERVED_STOCK_RECONCILE_ENABLED = anterior;
        }
      }
    };

    it("sem a flag, não consulta produtos reservados nem muda a varredura", async () => {
      await comFlag(undefined, async () => {
        (prisma as any).stockLog.findMany.mockResolvedValue([]);

        await StockReconciliationService.runOnce();

        expect((prisma as any).product.findMany).not.toHaveBeenCalled();
        expect((prisma as any).stockSyncJob.upsert).not.toHaveBeenCalled();
      });
    });

    it("com a flag, enfileira a peça reservada mesmo sem StockLog recente", async () => {
      await comFlag("1", async () => {
        (prisma as any).stockLog.findMany.mockResolvedValue([]);
        (prisma as any).product.findMany.mockResolvedValue([
          { id: "prod-reservado" },
        ]);
        (prisma as any).productListing.findMany.mockResolvedValue([
          makeListingRow({
            id: "lst-reservado",
            productId: "prod-reservado",
            // 1 em estoque, 1 comprometida ⇒ disponível 0.
            product: { stock: 1, reservedStock: 1 },
          }),
        ]);

        await StockReconciliationService.runOnce();

        expect((prisma as any).stockSyncJob.upsert).toHaveBeenCalledTimes(1);
        const arg = (prisma as any).stockSyncJob.upsert.mock.calls[0][0];
        // O alvo é o DISPONÍVEL, não o estoque bruto.
        expect(arg.create.targetStock).toBe(0);
        expect(arg.create.listingId).toBe("lst-reservado");
      });
    });

    it("com a flag, não duplica produto que já veio pelo StockLog", async () => {
      await comFlag("1", async () => {
        (prisma as any).stockLog.findMany.mockResolvedValue([
          { productId: "prod-1" },
        ]);
        (prisma as any).product.findMany.mockResolvedValue([{ id: "prod-1" }]);
        (prisma as any).productListing.findMany.mockResolvedValue([]);

        await StockReconciliationService.runOnce();

        const where = (prisma as any).productListing.findMany.mock.calls[0][0]
          .where;
        expect(where.productId.in).toEqual(["prod-1"]);
      });
    });
  });

  it("enfileira um upsert por listing ativo dos produtos com drift", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([
      { productId: "prod-1" },
      { productId: "prod-2" },
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      makeListingRow({
        id: "lst-ml",
        productId: "prod-1",
        marketplaceAccountId: "acc-ml",
        product: { stock: 4 },
        marketplaceAccount: { platform: "MERCADO_LIVRE", status: "ACTIVE" },
      }),
      makeListingRow({
        id: "lst-shp",
        productId: "prod-1",
        marketplaceAccountId: "acc-shp",
        product: { stock: 4 },
        marketplaceAccount: { platform: "SHOPEE", status: "ACTIVE" },
      }),
      makeListingRow({
        id: "lst-2",
        productId: "prod-2",
        marketplaceAccountId: "acc-ml",
        product: { stock: 7 },
        marketplaceAccount: { platform: "MERCADO_LIVRE", status: "ACTIVE" },
      }),
    ]);
    (prisma as any).stockSyncJob.upsert.mockResolvedValue({});

    await StockReconciliationService.runOnce();

    expect((prisma as any).stockSyncJob.upsert).toHaveBeenCalledTimes(3);
    const calls = (prisma as any).stockSyncJob.upsert.mock.calls.map(
      (c: any[]) => c[0],
    );
    const listingIds = calls.map(
      (c: any) => c.where.listingId_status.listingId,
    );
    expect(listingIds).toEqual(
      expect.arrayContaining(["lst-ml", "lst-shp", "lst-2"]),
    );
    for (const call of calls) {
      expect(call.where.listingId_status.status).toBe("PENDING");
      expect(call.create.status).toBe("PENDING");
    }
  });

  it("ignora listings cuja marketplaceAccount não está ACTIVE", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([
      { productId: "prod-1" },
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      makeListingRow({
        id: "lst-inactive",
        marketplaceAccount: { platform: "SHOPEE", status: "REVOKED" },
      }),
    ]);

    await StockReconciliationService.runOnce();

    expect((prisma as any).stockSyncJob.upsert).not.toHaveBeenCalled();
  });

  it("busca apenas listings com status de sincronização válida", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([
      { productId: "prod-1" },
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([]);

    await StockReconciliationService.runOnce();

    const where = (prisma as any).productListing.findMany.mock.calls[0][0]
      .where;
    expect(where.productId).toEqual({ in: ["prod-1"] });
    expect(where.status.in).toEqual(
      expect.arrayContaining(["ACTIVE", "active", "paused", "PAUSED"]),
    );
  });

  it("propaga targetStock = estoque atual do produto para o upsert", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([
      { productId: "prod-1" },
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      makeListingRow({ product: { stock: 12 } }),
    ]);

    await StockReconciliationService.runOnce();

    const call = (prisma as any).stockSyncJob.upsert.mock.calls[0][0];
    expect(call.create.targetStock).toBe(12);
    expect(call.update.targetStock).toBe(12);
  });

  it("não derruba o loop quando um upsert falha", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([
      { productId: "prod-1" },
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      makeListingRow({ id: "lst-broken" }),
      makeListingRow({ id: "lst-ok", marketplaceAccountId: "acc-2" }),
    ]);
    (prisma as any).stockSyncJob.upsert
      .mockRejectedValueOnce(new Error("deadlock"))
      .mockResolvedValueOnce({});

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(StockReconciliationService.runOnce()).resolves.toBeUndefined();

    expect((prisma as any).stockSyncJob.upsert).toHaveBeenCalledTimes(2);
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining("upsert failed for listing lst-broken"),
      expect.any(Error),
    );
  });

  it("usa janela de 1h baseada em createdAt ao buscar StockLog", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([]);

    const before = Date.now();
    await StockReconciliationService.runOnce();
    const after = Date.now();

    const call = (prisma as any).stockLog.findMany.mock.calls[0][0];
    const since = call.where.createdAt.gte.getTime();
    expect(since).toBeGreaterThanOrEqual(before - 60 * 60 * 1000 - 5);
    expect(since).toBeLessThanOrEqual(after - 60 * 60 * 1000 + 5);
    expect(call.distinct).toEqual(["productId"]);
  });
});

/**
 * VIGÍLIA DE DISPONIBILIDADE
 *
 * O caso que a motivou: SKU 33996, peça de 1 unidade, vendida na Shopee em
 * 01/08/2026 e DE NOVO no ML em 10/09. Entre 02/08 02:50 e 10/09 15:28 não há
 * UM registro de sync dos dois anúncios do ML — o sync roda por StockSyncJob,
 * que nasce de StockLog, e estoque que já foi a zero nunca mais muda.
 *
 * E zerar a quantidade não resolve: o ML RECUSA alterar `available_quantity`
 * em anúncio fora do ar (4.330 recusas medidas em 60 dias, 0 sucessos). A
 * única defesa é ver a VOLTA para `active` e pausar.
 */
describe("StockReconciliationService.watchAvailabilityOnce", () => {
  const comFlag = async (valor: string | undefined, fn: () => Promise<void>) => {
    const anterior = process.env.AVAILABILITY_WATCH_ENABLED;
    if (valor === undefined) delete process.env.AVAILABILITY_WATCH_ENABLED;
    else process.env.AVAILABILITY_WATCH_ENABLED = valor;
    try {
      await fn();
    } finally {
      if (anterior === undefined) delete process.env.AVAILABILITY_WATCH_ENABLED;
      else process.env.AVAILABILITY_WATCH_ENABLED = anterior;
    }
  };

  const candidato = (over: Partial<any> = {}) => ({
    listingId: "lst-ml",
    externalListingId: "MLB4862135565",
    productId: "prod-33996",
    productName: "Circuito lanterna traseira direita Fiat Strada 2015",
    sku: "33996",
    disponivel: 0,
    accountId: "acc-ml",
    accountName: "DESMONTE-JOTABE",
    accessToken: "tok-ml",
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    StockReconciliationService.stop(); // zera o cursor entre os testes
    (prisma as any).$transaction.mockImplementation(async (cb: any) => cb(prisma));
    (prisma as any).systemLog.findFirst.mockResolvedValue(null);
    (prisma as any).stockSyncJob.upsert.mockResolvedValue({});
  });

  it("sem a flag não consulta nada — nem banco, nem ML", async () => {
    await comFlag(undefined, async () => {
      await StockReconciliationService.watchAvailabilityOnce();

      expect((prisma as any).$queryRaw).not.toHaveBeenCalled();
      expect(MLApiService.getItemsStockSnapshot).not.toHaveBeenCalled();
    });
  });

  it("anúncio que segue fora do ar não gera alerta nem job", async () => {
    await comFlag("1", async () => {
      (prisma as any).$queryRaw.mockResolvedValue([candidato()]);
      (MLApiService.getItemsStockSnapshot as any).mockResolvedValue([
        {
          id: "MLB4862135565",
          status: "under_review",
          available_quantity: 1,
        },
      ]);

      await StockReconciliationService.watchAvailabilityOnce();

      // Multiget, nunca item a item: uma chamada por CONTA, com os ids juntos.
      expect(MLApiService.getItemsStockSnapshot).toHaveBeenCalledWith("tok-ml", [
        "MLB4862135565",
      ]);
      expect(MLApiService.getItemDetails).not.toHaveBeenCalled();
      expect(SystemLogService.logError).not.toHaveBeenCalled();
      expect((prisma as any).stockSyncJob.upsert).not.toHaveBeenCalled();
    });
  });

  it("anúncio ATIVO vendendo peça inexistente: alerta e enfileira a pausa", async () => {
    await comFlag("1", async () => {
      (prisma as any).$queryRaw.mockResolvedValue([candidato()]);
      (MLApiService.getItemsStockSnapshot as any).mockResolvedValue([
        { id: "MLB4862135565", status: "active", available_quantity: 1 },
      ]);

      await StockReconciliationService.watchAvailabilityOnce();

      expect(SystemLogService.logError).toHaveBeenCalledWith(
        "ML_BACK_ONLINE_WITHOUT_STOCK",
        expect.stringContaining("MLB4862135565"),
        expect.objectContaining({ resourceId: "lst-ml" }),
      );
      expect((prisma as any).stockSyncJob.upsert).toHaveBeenCalledTimes(1);
      const arg = (prisma as any).stockSyncJob.upsert.mock.calls[0][0];
      expect(arg.create.targetStock).toBe(0);
      expect(arg.create.listingId).toBe("lst-ml");
      // Mesmo caminho do reconciliador, advisory lock incluído.
      expect((prisma as any).$executeRaw).toHaveBeenCalled();
    });
  });

  it("ativo com quantidade 0 não é risco: nada a fazer", async () => {
    await comFlag("1", async () => {
      (prisma as any).$queryRaw.mockResolvedValue([candidato()]);
      (MLApiService.getItemsStockSnapshot as any).mockResolvedValue([
        { id: "MLB4862135565", status: "active", available_quantity: 0 },
      ]);

      await StockReconciliationService.watchAvailabilityOnce();

      expect(SystemLogService.logError).not.toHaveBeenCalled();
      expect((prisma as any).stockSyncJob.upsert).not.toHaveBeenCalled();
    });
  });

  it("falha na API do ML não derruba o restante do lote", async () => {
    await comFlag("1", async () => {
      (prisma as any).$queryRaw.mockResolvedValue([
        candidato({
          listingId: "lst-1",
          externalListingId: "MLB-1",
          accountId: "acc-a",
        }),
        candidato({
          listingId: "lst-2",
          externalListingId: "MLB-2",
          accountId: "acc-b",
        }),
      ]);
      // Contas diferentes: a primeira falha, a segunda tem de seguir.
      (MLApiService.getItemsStockSnapshot as any)
        .mockRejectedValueOnce(new Error("401 token expirado"))
        .mockResolvedValueOnce([
          { id: "MLB-2", status: "active", available_quantity: 1 },
        ]);

      await StockReconciliationService.watchAvailabilityOnce();

      // O segundo foi processado apesar da falha do primeiro.
      expect((prisma as any).stockSyncJob.upsert).toHaveBeenCalledTimes(1);
      const arg = (prisma as any).stockSyncJob.upsert.mock.calls[0][0];
      expect(arg.create.listingId).toBe("lst-2");
    });
  });

  it("conta sem token é pulada sem chamar o ML", async () => {
    await comFlag("1", async () => {
      (prisma as any).$queryRaw.mockResolvedValue([
        candidato({ accessToken: null }),
      ]);

      await StockReconciliationService.watchAvailabilityOnce();

      expect(MLApiService.getItemsStockSnapshot).not.toHaveBeenCalled();
      expect((prisma as any).stockSyncJob.upsert).not.toHaveBeenCalled();
    });
  });

  it("alerta repetido é deduplicado em 24h", async () => {
    await comFlag("1", async () => {
      (prisma as any).$queryRaw.mockResolvedValue([candidato()]);
      (MLApiService.getItemsStockSnapshot as any).mockResolvedValue([
        { id: "MLB4862135565", status: "active", available_quantity: 1 },
      ]);
      (prisma as any).systemLog.findFirst.mockResolvedValue({ id: "ja-existe" });

      await StockReconciliationService.watchAvailabilityOnce();

      expect(SystemLogService.logError).not.toHaveBeenCalled();
      // O alerta é deduplicado, mas a pausa continua sendo enfileirada.
      expect((prisma as any).stockSyncJob.upsert).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * COBERTURA DA VIGÍLIA — o defeito que estes testes travam.
 *
 * Até 15/09/2026 a varredura usava OFFSET com a posição guardada em memória.
 * O processo reinicia de tempos em tempos e a posição zerava: medido em
 * produção, o deslocamento NUNCA passou de 4.000 de 10.698 candidatos, 62,6%
 * da base jamais foi verificada uma única vez, e 27 das 29 contas de Mercado
 * Livre estavam inteiras nessa zona cega. O anúncio que vendeu a peça do SKU
 * 34049 pela segunda vez estava na posição ~7.921 — a vigília estava LIGADA e
 * mesmo assim nunca chegou nele.
 *
 * O invariante que estes testes travam não é "existe um cursor certo": é que
 * NENHUM anúncio pode ficar preso fora do alcance da varredura, e que
 * reiniciar o processo não reposiciona nada.
 */
describe("StockReconciliationService — cobertura da vigília", () => {
  const HORA_MS = 60 * 60 * 1000;

  it("24 horas consecutivas visitam as 24 fatias, sem repetir nenhuma", () => {
    const base = new Date("2026-09-15T00:00:00.000Z").getTime();
    const visitadas = new Set<number>();

    for (let h = 0; h < 24; h++) {
      visitadas.add(
        StockReconciliationService.sliceForClock(new Date(base + h * HORA_MS)),
      );
    }

    // Se alguma fatia faltasse, os anúncios dela ficariam invisíveis — que é
    // exatamente o defeito de produção que motivou a mudança.
    expect(visitadas.size).toBe(24);
  });

  it("a fatia não depende de estado: reiniciar o processo não reposiciona", () => {
    const momento = new Date("2026-09-15T13:00:00.000Z");

    const antes = StockReconciliationService.sliceForClock(momento);
    StockReconciliationService.stop(); // simula o reinício do processo
    const depois = StockReconciliationService.sliceForClock(momento);

    expect(depois).toBe(antes);
  });

  it("horas diferentes varrem fatias diferentes — a varredura avança sozinha", () => {
    const base = new Date("2026-09-15T05:00:00.000Z").getTime();

    const agora = StockReconciliationService.sliceForClock(new Date(base));
    const daquiUmaHora = StockReconciliationService.sliceForClock(
      new Date(base + HORA_MS),
    );

    expect(daquiUmaHora).not.toBe(agora);
  });

  it("a fatia entra na consulta, e o deslocamento não existe mais", async () => {
    const anterior = process.env.AVAILABILITY_WATCH_ENABLED;
    process.env.AVAILABILITY_WATCH_ENABLED = "1";
    try {
      vi.clearAllMocks();
      (prisma as any).$queryRaw.mockResolvedValue([]);
      const momento = new Date("2026-09-15T13:00:00.000Z");

      await StockReconciliationService.watchAvailabilityOnce(momento);

      const [fragmentos, ...valores] = (prisma as any).$queryRaw.mock.calls[0];
      const sql: string = fragmentos.join("?");

      expect(sql).toContain("hashtext");
      expect(sql).not.toContain("OFFSET");
      // A fatia da hora é o último parâmetro interpolado no WHERE.
      expect(valores).toContain(
        StockReconciliationService.sliceForClock(momento),
      );
    } finally {
      if (anterior === undefined) delete process.env.AVAILABILITY_WATCH_ENABLED;
      else process.env.AVAILABILITY_WATCH_ENABLED = anterior;
    }
  });

  it("duas passadas na mesma hora não pulam nada — a fatia é a mesma", async () => {
    const anterior = process.env.AVAILABILITY_WATCH_ENABLED;
    process.env.AVAILABILITY_WATCH_ENABLED = "1";
    try {
      vi.clearAllMocks();
      (prisma as any).$queryRaw.mockResolvedValue([]);
      const momento = new Date("2026-09-15T09:30:00.000Z");

      await StockReconciliationService.watchAvailabilityOnce(momento);
      await StockReconciliationService.watchAvailabilityOnce(momento);

      const fatiaDaPrimeira = (prisma as any).$queryRaw.mock.calls[0].slice(1);
      const fatiaDaSegunda = (prisma as any).$queryRaw.mock.calls[1].slice(1);

      // Antes, a segunda passada saltava 400 posições à frente. Agora as duas
      // olham o mesmo conjunto — nada escapa entre uma e outra.
      expect(fatiaDaSegunda).toEqual(fatiaDaPrimeira);
    } finally {
      if (anterior === undefined) delete process.env.AVAILABILITY_WATCH_ENABLED;
      else process.env.AVAILABILITY_WATCH_ENABLED = anterior;
    }
  });
});

/**
 * SHOPEE NA VIGÍLIA — o canal maior, que estava fora por construção.
 *
 * Medido em 15/09/2026: 6.246 anúncios de Shopee não encerrados sobre peça sem
 * saldo (4.331 produtos, 15 clientes), contra 1.729 `active` no ML. E aqui a
 * correção funciona de verdade: na venda do SKU 34049 os três anúncios de
 * Shopee zeraram em segundos, enquanto os dois do ML recusaram.
 *
 * O invariante mais importante desta seção não é o que a Shopee passa a fazer:
 * é que **sem a flag, o Mercado Livre continua exatamente como estava**.
 */
describe("StockReconciliationService — vigília na Shopee", () => {
  const comFlags = async (
    valores: Record<string, string | undefined>,
    fn: () => Promise<void>,
  ) => {
    const anteriores: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(valores)) {
      anteriores[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(anteriores)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const candidatoShopee = (over: Partial<any> = {}) => ({
    listingId: "lst-shp",
    externalListingId: "58263970741",
    productId: "prod-34049",
    productName: "Gargalo tanque combustível Fiat Palio 2000",
    sku: "34049",
    disponivel: 0,
    accountId: "acc-shp",
    accountName: "SHOPEE Jotabê Auto-Peças",
    accessToken: "tok-shp",
    platform: "SHOPEE",
    shopId: 1547916297,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma as any).$transaction.mockImplementation(async (cb: any) =>
      cb(prisma),
    );
    (prisma as any).systemLog.findFirst.mockResolvedValue(null);
    (prisma as any).stockSyncJob.upsert.mockResolvedValue({});
  });

  it("sem a flag, a Shopee nem entra na consulta", async () => {
    await comFlags(
      {
        AVAILABILITY_WATCH_ENABLED: "1",
        AVAILABILITY_WATCH_SHOPEE_ENABLED: undefined,
      },
      async () => {
        (prisma as any).$queryRaw.mockResolvedValue([]);

        await StockReconciliationService.watchAvailabilityOnce();

        const valores = (prisma as any).$queryRaw.mock.calls[0].slice(1);
        // A lista de plataformas é o primeiro parâmetro interpolado.
        expect(valores).toContainEqual(["MERCADO_LIVRE"]);
        expect(ShopeeApiService.getItemsBaseInfo).not.toHaveBeenCalled();
      },
    );
  });

  it("com a flag, anúncio à venda na Shopee sobre peça zerada vira alerta e job", async () => {
    await comFlags(
      {
        AVAILABILITY_WATCH_ENABLED: "1",
        AVAILABILITY_WATCH_SHOPEE_ENABLED: "1",
      },
      async () => {
        (prisma as any).$queryRaw.mockResolvedValue([candidatoShopee()]);
        (ShopeeApiService.getItemsBaseInfo as any).mockResolvedValue([
          {
            item_id: 58263970741,
            item_status: "NORMAL",
            stock_info_v2: { summary_info: { total_available_stock: 1 } },
          },
        ]);

        await StockReconciliationService.watchAvailabilityOnce();

        expect(SystemLogService.logError).toHaveBeenCalledTimes(1);
        const [rotulo, , opcoes] = (SystemLogService.logError as any).mock
          .calls[0];
        // Rótulo próprio: não contamina a série do Mercado Livre.
        expect(rotulo).toBe("SHOPEE_BACK_ONLINE_WITHOUT_STOCK");
        expect(opcoes.details.platform).toBe("SHOPEE");

        expect((prisma as any).stockSyncJob.upsert).toHaveBeenCalledTimes(1);
        const job = (prisma as any).stockSyncJob.upsert.mock.calls[0][0];
        expect(job.create.platform).toBe("SHOPEE");
        expect(job.create.targetStock).toBe(0);
      },
    );
  });

  it("anúncio fora do ar na Shopee (UNLIST) não é risco, mesmo com estoque remoto", async () => {
    await comFlags(
      {
        AVAILABILITY_WATCH_ENABLED: "1",
        AVAILABILITY_WATCH_SHOPEE_ENABLED: "1",
      },
      async () => {
        (prisma as any).$queryRaw.mockResolvedValue([candidatoShopee()]);
        (ShopeeApiService.getItemsBaseInfo as any).mockResolvedValue([
          {
            item_id: 58263970741,
            item_status: "UNLIST",
            stock_info_v2: { summary_info: { total_available_stock: 5 } },
          },
        ]);

        await StockReconciliationService.watchAvailabilityOnce();

        expect(SystemLogService.logError).not.toHaveBeenCalled();
        expect((prisma as any).stockSyncJob.upsert).not.toHaveBeenCalled();
      },
    );
  });

  it("item com variação é pulado: o total do item não responde pelo modelo", async () => {
    await comFlags(
      {
        AVAILABILITY_WATCH_ENABLED: "1",
        AVAILABILITY_WATCH_SHOPEE_ENABLED: "1",
      },
      async () => {
        (prisma as any).$queryRaw.mockResolvedValue([candidatoShopee()]);
        (ShopeeApiService.getItemsBaseInfo as any).mockResolvedValue([
          {
            item_id: 58263970741,
            item_status: "NORMAL",
            has_model: true,
            stock_info_v2: { summary_info: { total_available_stock: 3 } },
          },
        ]);

        await StockReconciliationService.watchAvailabilityOnce();

        // Decidir pelo total do item daria falso positivo: o estoque de uma
        // variação não diz nada sobre a outra.
        expect((prisma as any).stockSyncJob.upsert).not.toHaveBeenCalled();
      },
    );
  });

  it("conta de Shopee sem shopId é pulada sem chamar a API", async () => {
    await comFlags(
      {
        AVAILABILITY_WATCH_ENABLED: "1",
        AVAILABILITY_WATCH_SHOPEE_ENABLED: "1",
      },
      async () => {
        (prisma as any).$queryRaw.mockResolvedValue([
          candidatoShopee({ shopId: null }),
        ]);

        await StockReconciliationService.watchAvailabilityOnce();

        expect(ShopeeApiService.getItemsBaseInfo).not.toHaveBeenCalled();
        expect((prisma as any).stockSyncJob.upsert).not.toHaveBeenCalled();
      },
    );
  });

  it("com a flag, o Mercado Livre continua sendo tratado como antes", async () => {
    await comFlags(
      {
        AVAILABILITY_WATCH_ENABLED: "1",
        AVAILABILITY_WATCH_SHOPEE_ENABLED: "1",
      },
      async () => {
        (prisma as any).$queryRaw.mockResolvedValue([
          {
            ...candidatoShopee(),
            listingId: "lst-ml",
            externalListingId: "MLB4862135565",
            accountId: "acc-ml",
            accountName: "DESMONTE-JOTABE",
            platform: "MERCADO_LIVRE",
            shopId: null,
          },
        ]);
        (MLApiService.getItemsStockSnapshot as any).mockResolvedValue([
          { id: "MLB4862135565", status: "active", available_quantity: 1 },
        ]);

        await StockReconciliationService.watchAvailabilityOnce();

        const [rotulo] = (SystemLogService.logError as any).mock.calls[0];
        expect(rotulo).toBe("ML_BACK_ONLINE_WITHOUT_STOCK");
        expect(ShopeeApiService.getItemsBaseInfo).not.toHaveBeenCalled();
        const job = (prisma as any).stockSyncJob.upsert.mock.calls[0][0];
        expect(job.create.platform).toBe("MERCADO_LIVRE");
      },
    );
  });
});
