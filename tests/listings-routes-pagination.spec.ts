import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

/**
 * TETO E PAGINAÇÃO NAS CINCO ABAS "ANÚNCIOS".
 *
 * Medido em produção em 19/08/2026: `GET /marketplace/ml/listings` devolvia
 * **13 MB** na maior conta (36.185 anúncios), sem `take`. Shopee tinha conta com
 * 11.699. O banco resolvia em 72 ms — o custo era materializar dezenas de
 * milhares de objetos no Node, serializar e transmitir.
 *
 * Os casos aqui travam as três propriedades que sustentam a correção:
 *   1. sempre há teto, e ele não depende de quem chama (`?limit=999999`);
 *   2. o total dos que existem viaja junto, senão a tela mentiria dizendo 50;
 *   3. UMA consulta, não uma por conta — e sem perder campo nenhum de canal.
 */

vi.mock("../app/lib/prisma", () => ({
  default: {
    marketplaceAccount: { findMany: vi.fn() },
    productListing: { findMany: vi.fn(), count: vi.fn() },
  },
}));
vi.mock("@/app/lib/prisma", () => ({
  default: {
    marketplaceAccount: { findMany: vi.fn() },
    productListing: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { id: "user-1", dataOwnerId: "user-1" };
  },
}));

import prisma from "../app/lib/prisma";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";

const CANAIS = ["ml", "shopee", "magalu", "olx", "facebook"] as const;

function contas(n = 1) {
  return Array.from({ length: n }, (_, i) => ({
    id: `acc-${i + 1}`,
    accountName: `Conta ${i + 1}`,
    fbCatalogId: `100000000000${i + 1}`,
    shopId: 900 + i,
  }));
}

function linhas(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `l-${i}`,
    productId: `p-${i}`,
    externalListingId: `EXT-${i}`,
    externalSku: `SKU-${i}`,
    permalink: null,
    status: "active",
    lastError: null,
    createdAt: new Date("2026-08-19T12:00:00.000Z"),
    olxListId: "999",
    fbCatalogItemId: "77001",
    marketplaceAccountId: "acc-1",
    marketplaceAccount: { shopId: 900 },
    product: { name: `Peça ${i}`, sku: `SKU-${i}`, stock: 1 },
  }));
}

describe("GET /marketplace/{canal}/listings — teto e paginação", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    const { marketplaceRoutes } = await import(
      "../app/routes/marketplace.routes"
    );
    app = fastify();
    await app.register(marketplaceRoutes, { prefix: "/marketplace" });

    vi.spyOn(
      MarketplaceRepository,
      "findAllByUserIdAndPlatform",
    ).mockResolvedValue(contas(1) as any);
    (prisma as any).productListing.count.mockResolvedValue(36185);
    (prisma as any).productListing.findMany.mockResolvedValue(linhas(50));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    await app.close();
  });

  const buscar = (canal: string, qs = "") =>
    app.inject({
      method: "GET",
      url: `/marketplace/${canal}/listings${qs}`,
      headers: { email: "t@e.com" },
    });

  const argsDoFindMany = () =>
    (prisma as any).productListing.findMany.mock.calls[0][0];

  it("os CINCO canais aplicam teto por padrão", async () => {
    for (const canal of CANAIS) {
      (prisma as any).productListing.findMany.mockClear();
      const res = await buscar(canal);

      expect(res.statusCode, canal).toBe(200);
      expect(argsDoFindMany().take, `${canal}: sem take`).toBe(50);
      expect(argsDoFindMany().skip, `${canal}: sem skip`).toBe(0);
    }
  });

  it("os CINCO devolvem quantos EXISTEM, não só quantos vieram", async () => {
    for (const canal of CANAIS) {
      const body = JSON.parse((await buscar(canal)).payload);

      expect(body.pagination, `${canal}: sem pagination`).toBeDefined();
      expect(body.pagination.total, canal).toBe(36185);
      expect(body.pagination.totalPages, canal).toBe(724);
      expect(body.pagination.page, canal).toBe(1);
      expect(body.pagination.limit, canal).toBe(50);
      // Compatibilidade: `count` segue sendo o tamanho da página, como sempre foi.
      expect(body.count, canal).toBe(50);
      expect(Array.isArray(body.listings), canal).toBe(true);
    }
  });

  it("página 3 pula as duas anteriores", async () => {
    await buscar("ml", "?page=3&limit=20");
    expect(argsDoFindMany().take).toBe(20);
    expect(argsDoFindMany().skip).toBe(40);
  });

  it("?limit=999999 NÃO fura o teto — era o buraco inteiro", async () => {
    for (const canal of CANAIS) {
      (prisma as any).productListing.findMany.mockClear();
      await buscar(canal, "?limit=999999");
      expect(argsDoFindMany().take, canal).toBe(200);
    }
  });

  it("UMA consulta por requisição, não uma por conta", async () => {
    // O formato antigo era `Promise.all(accounts.map(findMany))`: com 3 contas,
    // 3 consultas. Além do custo, a concatenação tornava a página indefinida.
    vi.spyOn(
      MarketplaceRepository,
      "findAllByUserIdAndPlatform",
    ).mockResolvedValue(contas(3) as any);

    for (const canal of CANAIS) {
      (prisma as any).productListing.findMany.mockClear();
      await buscar(canal);

      expect(
        (prisma as any).productListing.findMany.mock.calls.length,
        canal,
      ).toBe(1);
      expect(argsDoFindMany().where).toEqual({
        marketplaceAccountId: { in: ["acc-1", "acc-2", "acc-3"] },
      });
    }
  });

  it("a ordem tem desempate — sem ele a virada de página duplica ou perde linha", async () => {
    for (const canal of CANAIS) {
      (prisma as any).productListing.findMany.mockClear();
      await buscar(canal);
      expect(argsDoFindMany().orderBy, canal).toEqual([
        { createdAt: "desc" },
        { id: "desc" },
      ]);
    }
  });

  it("nenhum canal perdeu campo do seu select", async () => {
    // Controle de regressão do que é ESPECÍFICO de cada canal — foi a parte da
    // mudança com mais chance de erro de digitação.
    const especificos: Record<string, string[]> = {
      ml: ["id", "productId", "externalListingId", "externalSku", "permalink"],
      shopee: ["marketplaceAccount"],
      magalu: ["externalSku", "createdAt"],
      olx: ["olxListId"],
      facebook: ["fbCatalogItemId", "marketplaceAccountId"],
    };

    for (const [canal, campos] of Object.entries(especificos)) {
      (prisma as any).productListing.findMany.mockClear();
      await buscar(canal);
      const select = argsDoFindMany().select;
      for (const campo of campos) {
        expect(select[campo], `${canal}.${campo}`).toBeTruthy();
      }
      expect(select.product, `${canal}.product`).toBeTruthy();
    }
  });

  it("a Shopee continua projetando shopId em cada linha", async () => {
    const body = JSON.parse((await buscar("shopee")).payload);
    expect(body.listings[0].shopId).toBe(900);
  });

  it("o Facebook continua resolvendo o catálogo da conta — e não vaza o id da conta", async () => {
    const body = JSON.parse((await buscar("facebook")).payload);
    expect(body.listings[0].fbCatalogId).toBe("1000000000001");
    // `marketplaceAccountId` entra no select só para resolver o catálogo; não
    // tem por que trafegar 50× por página.
    expect(body.listings[0]).not.toHaveProperty("marketplaceAccountId");
  });

  it("conta sem anúncio devolve lista vazia com UMA página", async () => {
    (prisma as any).productListing.count.mockResolvedValue(0);
    (prisma as any).productListing.findMany.mockResolvedValue([]);

    const body = JSON.parse((await buscar("olx")).payload);
    expect(body.listings).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.pagination.total).toBe(0);
    expect(body.pagination.totalPages).toBe(1);
  });
});
